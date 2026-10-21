import type { ServerResponse } from 'node:http'

import { setResponseHeader, setResponseStatus, type H3Event } from 'h3'

import type { PermissionKey } from '../application/access/keys'
import type { MemberPrincipal } from '../application/access/principal'
import type { ChangeEvent, ChangeEventBus } from '../application/services/change-events'
import { denyUnlessAllowed, requestPrincipal } from './access/http'
import { diagnostics } from '../logging/diagnostics'

/**
 * `GET /api/events`, the change-event stream (Clause 01a114ec-e839-7b11-957c-41c88b692e12) of the
 * Feature "Live refresh" (01a111e4-0315-7755-b867-e3c7b50d22e6): server-sent events for every
 * member holding `workspace.read` on every accepted origin (Rule 01a11485-f34a-7c7e-a69c-fba14914d62d).
 *
 * - On connect: a `retry` hint and `hello { serverInstanceId }`. Events carry no `id`, so nothing
 *   is replayed and `Last-Event-ID` is never read (Rule 01a11485-f39f-7464-9f8f-608335ed9800).
 * - Then every bus event as `event: <name>` with its content-free JSON `data`, and a `heartbeat`
 *   event (`{}`) every `heartbeatMs` (about 20 seconds), which the Workbench watches to notice a
 *   stream that went silent.
 * - The stream limits are those of Clause 01a1593c-77e1-7c8c-9b2d-e3c460fddda1 (in the Mutation
 *   Contract): at most four open streams per credential (each Workbench session or Token) and 256 in
 *   all; a request over a limit is refused with 429 `events.stream_limit` and `Retry-After`, which
 *   a browser `EventSource` does not retry, so the Workbench falls back to polling (Rule
 *   01a11485-f3d9-7663-b344-a60c2a949e5e).
 * - Each heartbeat, and each access change, re-checks every stream's credential: an ended
 *   session or Token, a removed member or a lost `workspace.read` closes the stream (Rule
 *   01a11485-f3f6-72df-b43a-91905eb4970c).
 * - A client that stops reading is disconnected once its unsent data passes `maxBufferedBytes`
 *   (1 MiB); it reconnects and resynchronizes like after any other drop.
 * - Server shutdown closes every stream at once (`close`), so a graceful shutdown does not wait on them.
 */
export const EVENT_STREAM_HEARTBEAT_MS = 20_000
export const MAX_EVENT_STREAMS_PER_CREDENTIAL = 4
export const MAX_EVENT_STREAMS = 256
export const MAX_EVENT_STREAM_BUFFERED_BYTES = 1024 * 1024
/** The reconnect delay the stream suggests to `EventSource`. */
export const EVENT_STREAM_RETRY_MS = 3000

export type EventStreamHubOptions = Readonly<{
	bus: ChangeEventBus
	/** The keys the stream's credential grants now, or `undefined` once it ended (`AccessService.credentialKeys`). */
	credentialKeys: (principal: MemberPrincipal) => readonly PermissionKey[] | undefined
	/** Work run on every heartbeat before the credential checks: ending expired leases, re-reading the roster. */
	onHeartbeat?: () => void | Promise<void>
	heartbeatMs?: number
	maxStreamsPerCredential?: number
	maxStreams?: number
	maxBufferedBytes?: number
}>

export interface EventStreamHub {
	/** Serves one `GET /api/events` request; settles when the stream closes. */
	serve(event: H3Event): Promise<unknown>
	/** Re-checks every open stream's credential and closes the ones that ended. */
	revalidate(): void
	/**
	 * Closes every open stream and drops its connection (server shutdown): a graceful shutdown waits
	 * for open connections, and a stream never ends by itself.
	 */
	close(): void
	readonly size: number
}

type OpenStream = {
	readonly principal: MemberPrincipal
	readonly res: ServerResponse
	/** Ends the stream; `destroy` drops the connection instead of flushing what is still buffered. */
	end(destroy?: boolean): void
}

export function createEventStreamHub(options: EventStreamHubOptions): EventStreamHub {
	const heartbeatMs = options.heartbeatMs ?? EVENT_STREAM_HEARTBEAT_MS
	const perCredential = options.maxStreamsPerCredential ?? MAX_EVENT_STREAMS_PER_CREDENTIAL
	const maxStreams = options.maxStreams ?? MAX_EVENT_STREAMS
	const maxBuffered = options.maxBufferedBytes ?? MAX_EVENT_STREAM_BUFFERED_BYTES
	const streams = new Set<OpenStream>()
	let timer: ReturnType<typeof setInterval> | undefined
	let beating = false

	function write(stream: OpenStream, chunk: string): void {
		if (stream.res.writableEnded || stream.res.destroyed) return stream.end()
		stream.res.write(chunk)
		// A client that stops reading would keep this data, and its socket, forever: drop it.
		if (stream.res.writableLength > maxBuffered) stream.end(true)
	}

	function revalidate(): void {
		for (const stream of [...streams]) {
			let keys: readonly PermissionKey[] | undefined
			try { keys = options.credentialKeys(stream.principal) }
			catch { keys = undefined }
			if (!keys || !keys.includes('workspace.read')) stream.end()
		}
	}

	async function heartbeat(): Promise<void> {
		if (beating) return
		beating = true
		try {
			try { await options.onHeartbeat?.() }
			catch (error) { diagnostics.warn(`uiux: the event stream heartbeat work failed: ${error instanceof Error ? error.message : String(error)}`) }
			revalidate()
			for (const stream of [...streams]) write(stream, eventFrame('heartbeat', {}))
		}
		finally {
			beating = false
		}
	}

	function startTimer(): void {
		if (timer) return
		timer = setInterval(() => { void heartbeat() }, heartbeatMs)
		timer.unref?.()
	}

	function stopTimerWhenIdle(): void {
		if (streams.size > 0 || !timer) return
		clearInterval(timer)
		timer = undefined
	}

	function refuse(event: H3Event, message: string) {
		setResponseStatus(event, 429)
		setResponseHeader(event, 'Cache-Control', 'no-store')
		setResponseHeader(event, 'Content-Type', 'application/json')
		setResponseHeader(event, 'Retry-After', Math.ceil(heartbeatMs / 1000))
		return { status: 'rejected', code: 'events.stream_limit', message, diagnostics: [{ code: 'events.stream_limit', path: '/', message }] }
	}

	async function serve(event: H3Event): Promise<unknown> {
		const denied = denyUnlessAllowed(event, 'subscribeEvents')
		if (denied !== undefined) return denied
		const principal = requestPrincipal(event)
		// The policy admits only members (no system credential subscribes); this narrows the type.
		if (principal.type !== 'member') return denyUnlessAllowed(event, 'subscribeEvents')
		if (streams.size >= maxStreams)
			return refuse(event, 'The server has too many open event streams. The Workbench polls instead; try again later.')
		if ([...streams].filter(stream => stream.principal.credentialId === principal.credentialId).length >= perCredential)
			return refuse(event, `This session already has ${perCredential} open event streams. Close another Workbench tab, or rely on polling in this one.`)

		const { req, res } = event.node
		res.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-store',
			'Connection': 'keep-alive',
			// Reverse proxies must not buffer the stream (nginx honors this header).
			'X-Accel-Buffering': 'no',
		})
		req.socket?.setNoDelay?.(true)
		req.socket?.setKeepAlive?.(true)

		let resolveClosed!: () => void
		const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
		const subscription: { stop?: () => void } = {}
		let ended = false
		const stream: OpenStream = {
			principal,
			res,
			end(destroy = false) {
				if (ended) return
				ended = true
				subscription.stop?.()
				streams.delete(stream)
				stopTimerWhenIdle()
				if (destroy) res.destroy()
				else if (!res.writableEnded) res.end()
				resolveClosed()
			},
		}
		streams.add(stream)
		req.once('close', () => stream.end())
		res.once('close', () => stream.end())
		// `on`, not `once`: a socket can emit more than one error, and an unhandled one would crash the process.
		req.on('error', () => stream.end(true))
		res.on('error', () => stream.end(true))
		write(stream, `retry: ${EVENT_STREAM_RETRY_MS}\n\n${eventFrame('hello', { serverInstanceId: options.bus.serverInstanceId })}`)
		subscription.stop = options.bus.subscribe(change => write(stream, changeEventFrame(change)))
		startTimer()
		await closed
		return undefined
	}

	return {
		serve,
		revalidate,
		close() {
			for (const stream of [...streams]) stream.end(true)
		},
		get size() {
			return streams.size
		},
	}
}

function eventFrame(name: string, data: unknown): string {
	return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

/** The wire form of one event: its name and only the fields Clause 01a114ec-e839-7b11-957c-41c88b692e12 names. */
export function changeEventFrame(change: ChangeEvent): string {
	switch (change.type) {
		case 'resource.changed': return eventFrame(change.type, { kind: change.kind, key: change.key, revision: change.revision })
		case 'resource.removed': return eventFrame(change.type, { kind: change.kind, key: change.key })
		case 'lock.changed': return eventFrame(change.type, { kind: change.kind, key: change.key })
		case 'access.changed': return eventFrame(change.type, {})
	}
}

/**
 * Closes every open stream of `hub` as soon as a shutdown signal arrives. Nitro's graceful shutdown
 * (the signals of `NITRO_SHUTDOWN_SIGNALS`, by default `SIGTERM` and `SIGINT`) first waits up to
 * `NITRO_SHUTDOWN_TIMEOUT` (30 s) for open connections to end, and only then runs the `close` hook,
 * while an event stream never ends by itself; `uiux dev` forwards the signals it receives to the
 * server, so its Ctrl+C takes the same path. With `NITRO_SHUTDOWN_DISABLED` nothing is installed, so
 * the process keeps its default signal handling. Returns the removal of the listeners.
 */
export function closeEventStreamsOnShutdown(
	hub: Pick<EventStreamHub, 'close'>,
	env: Readonly<Record<string, string | undefined>> = process.env,
	target: Pick<NodeJS.Process, 'on' | 'off'> = process,
): () => void {
	if (env.NITRO_SHUTDOWN_DISABLED) return () => {}
	const signals = (env.NITRO_SHUTDOWN_SIGNALS || 'SIGTERM SIGINT').split(' ').map(signal => signal.trim()).filter(signal => signal.length > 0) as NodeJS.Signals[]
	const close = () => hub.close()
	for (const signal of signals) target.on(signal, close)
	return () => {
		for (const signal of signals) target.off(signal, close)
	}
}
