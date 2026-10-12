import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

import { containedRealPath, maskHostPaths } from '../adapters/kit-registry'
import { readKitBuildDeclaration, type KitBuildDeclaration } from '../adapters/kit-build-declaration'
import { realDirectoryIdentity } from '../adapters/resolution'
import type { KitBuildControl, KitBuildRestart, KitBuildStatus } from '../application/ports/kit-build'

/**
 * The kit build runner (Feature 01a11bb1-8534-7f0f-b8d0-de7efabe31f7). Under `uiux dev` it runs the
 * one build process the kit project declares in `kit/package.json` (Clause
 * 01a11bb1-86af-7d2c-946e-6217b40c8ad3): the `watch` command, or else the build `command` once
 * (Rule 01a11bb1-9d90-79c0-a51d-44382359bb6b). It never compiles anything itself (Rule
 * 01a11bb1-9cb5-77f6-8e5d-5746bcfa9162), and no caller supplies a command or an argument: a
 * restart reads the declaration anew from the host file (Rule 01a11bb1-9d17-7205-abee-c2aa7058c107).
 *
 * - The process runs in the real `kit/` directory, through `spawn` with an argument array and no
 *   shell, with UIUX's environment minus `UIUX_MCP_TOKEN` and every `UIUX_INTERNAL_*` variable, the
 *   `node_modules/.bin` directories of `kit/` and of the Workspace root, and no other, first on
 *   `PATH`, and standard input closed (Clause 01a11bb1-88ba-7030-a7dd-5c7e843c31ea). It leads its
 *   own process group, so stopping it stops what it started.
 * - Its argument array is printed before it runs (Rule 01a11bb1-a05b-7686-beaa-22a90aa90fc2).
 * - The output is settled once 500 ms pass without a change in the output directory (Clause
 *   01a11bb1-87ed-7fec-b485-ede3986675d4), watched by polling its listing. Each settled output
 *   advances the output generation, from which the server resolves the Adapters anew and builds a
 *   new Preview bundle (Rule 01a11bb1-9df8-762d-b5e5-306f9898aae2); a failed run leaves the
 *   generation, so the last good output stays in use (Rule 01a11bb1-9e5e-79ab-841e-c953e8b44bbf).
 * - States follow Clause 01a11bb1-8856-737f-945c-e44c596f7782: `none` without a declaration,
 *   `building` while a run is in progress, `ready` once its output settled, else `failed`. A watch
 *   run is first `ready` only after its output changed since it started, so an output left from
 *   before the start is never taken (Rule 01a12f9d-a14e-70fe-b44a-cb8c7a85b899).
 * - A run that exceeds `timeoutSeconds` is stopped and fails (Rule
 *   01a11bb1-9f91-7528-a71c-6cd206e25121): the `command` run as a whole, and a `watch` run until
 *   its first settled output (a watch process runs on after that).
 * - The log is the last 256 KiB of the process output, in memory only (Clause
 *   01a11bb1-891e-7fa5-bf48-4c459fd60d11), read with secret values masked (`maskSecrets`, Clause
 *   01a12f99-bb0c-7b87-b500-561feb853ae3), then host paths.
 *
 * Known limit (Product Kit Contract, Notes): a watch rebuild that fails without exiting leaves the
 * old output `ready`; the log shows the error. The build runs with the host user's privileges.
 */
export type KitBuildRunner = KitBuildControl & Readonly<{
	/** Reads the declaration and starts the build; `none` when nothing is declared. */
	start(): Promise<KitBuildStatus>
	/** Stops the running build process, if any. */
	stop(): Promise<void>
	/** Kills the running build process group at once (for process exit). */
	stopSync(): void
	/**
	 * The generation of the last good output: `0` for an output present when the runner first
	 * started, then one more for each settled output; `undefined` while there has been none.
	 */
	outputGeneration(): number | undefined
	/** The declaration the current run follows, if any. */
	declaration(): KitBuildDeclaration | undefined
}>

export type KitBuildRunnerOptions = Readonly<{
	/** The Workspace root. */
	root: string
	/** The kit project's directory name (`kit`), absent below `schemaVersion` 5. */
	codeDirectoryName: string | undefined
	/** The environment the build's is made from; `process.env` by default. */
	env?: NodeJS.ProcessEnv
	settleMs?: number
	pollMs?: number
	/** How long a stopped process gets after `SIGTERM` before `SIGKILL`. */
	killGraceMs?: number
	/** The minimum interval between restarts; `KIT_BUILD_RESTART_INTERVAL_MS` by default. */
	restartIntervalMs?: number
	/** The output generation past which a warning is printed once; `KIT_BUILD_GENERATION_WARNING` by default. */
	generationWarning?: number
	/** Where the argument array and failures are printed; `console.log` by default. */
	print?: (line: string) => void
}>

/** Clause 01a11bb1-87ed-7fec-b485-ede3986675d4. */
export const KIT_BUILD_SETTLE_MS = 500
/** Clause 01a11bb1-891e-7fa5-bf48-4c459fd60d11. */
export const KIT_BUILD_LOG_BYTES = 256 * 1024
/** Clause 01a12f9a-ef7c-7d41-86ac-2f2b3f1acd8a: restarts are at least this far apart. */
export const KIT_BUILD_RESTART_INTERVAL_MS = 2000
/**
 * Each output generation imports the `./` Adapter module under a new URL, which Node keeps for the
 * life of the process, so past this many a warning is printed once (owner ruling 3 of 2026-10-12).
 */
export const KIT_BUILD_GENERATION_WARNING = 50
const INTERNAL_VARIABLE_PREFIX = 'UIUX_INTERNAL_'
/** The Agent Token variable the CLI suggests; never passed to a build (owner ruling 2 of 2026-10-12). */
const MCP_TOKEN_VARIABLE = 'UIUX_MCP_TOKEN'
/** Variable names whose values the build log masks (Clause 01a12f99-bb0c-7b87-b500-561feb853ae3). */
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD/i
/** The shortest value masked, so that a short value such as `1` leaves the log readable. */
export const KIT_BUILD_SECRET_MIN_LENGTH = 8
export const KIT_BUILD_SECRET_MASK = '<secret>'
const DEFAULT_POLL_MS = 100
const DEFAULT_KILL_GRACE_MS = 2000
/** The most output entries one listing reads; past it the listing stops, still changing with the files read. */
const MAX_OUTPUT_ENTRIES = 20_000

/**
 * The build process environment (Clause 01a11bb1-88ba-7030-a7dd-5c7e843c31ea): `base` minus
 * `UIUX_MCP_TOKEN` and every `UIUX_INTERNAL_*` variable, with `kit/node_modules/.bin` and
 * `<workspace root>/node_modules/.bin` ahead of the inherited `PATH`. No other ancestor directory is
 * added (owner ruling 1 of 2026-10-12): a tool elsewhere is named by an absolute path in the build
 * command.
 */
export function kitBuildEnvironment(base: NodeJS.ProcessEnv, kitDirectory: string, workspaceRoot: string): Record<string, string> {
	const env: Record<string, string> = {}
	for (const [name, value] of Object.entries(base)) {
		if (value === undefined) continue
		// Variable names are case-insensitive on Windows, so the names compared are too.
		const upper = name.toUpperCase()
		if (upper.startsWith(INTERNAL_VARIABLE_PREFIX) || upper === MCP_TOKEN_VARIABLE) continue
		env[name] = value
	}
	const pathName = Object.keys(env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH'
	const bins = [join(kitDirectory, 'node_modules', '.bin'), join(workspaceRoot, 'node_modules', '.bin')]
	const inherited = env[pathName]
	env[pathName] = [...bins, ...(inherited ? [inherited] : [])].join(delimiter)
	return env
}

/**
 * The values the build log masks (Clause 01a12f99-bb0c-7b87-b500-561feb853ae3): those of every
 * variable in `envs` whose name contains TOKEN, SECRET, KEY or PASSWORD, in any case, and whose value
 * has at least `KIT_BUILD_SECRET_MIN_LENGTH` characters; longest first.
 */
export function secretValues(...envs: readonly NodeJS.ProcessEnv[]): string[] {
	const values = new Set<string>()
	for (const env of envs) {
		for (const [name, value] of Object.entries(env)) {
			if (value !== undefined && value.length >= KIT_BUILD_SECRET_MIN_LENGTH && SECRET_NAME.test(name)) values.add(value)
		}
	}
	return [...values].sort((a, b) => b.length - a.length)
}

/** `text` with each of `values` replaced by `KIT_BUILD_SECRET_MASK`. */
export function maskSecrets(text: string, values: readonly string[]): string {
	let masked = text
	for (const value of values) masked = masked.replaceAll(value, KIT_BUILD_SECRET_MASK)
	return masked
}

/** The last `capacity` bytes written, in memory only. */
export class KitBuildLog {
	private chunks: Buffer[] = []
	private size = 0

	constructor(private readonly capacity: number = KIT_BUILD_LOG_BYTES) {}

	write(chunk: Buffer | string): void {
		let bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
		if (bytes.length >= this.capacity) {
			bytes = Buffer.from(bytes.subarray(bytes.length - this.capacity))
			this.chunks = []
			this.size = 0
		}
		this.chunks.push(bytes)
		this.size += bytes.length
		while (this.size > this.capacity) {
			const first = this.chunks[0]!
			const excess = this.size - this.capacity
			if (first.length <= excess) {
				this.chunks.shift()
				this.size -= first.length
			}
			else {
				this.chunks[0] = Buffer.from(first.subarray(excess))
				this.size -= excess
			}
		}
	}

	byteLength(): number {
		return this.size
	}

	text(): string {
		return Buffer.concat(this.chunks).toString('utf8')
	}

	clear(): void {
		this.chunks = []
		this.size = 0
	}
}

type Run = {
	id: number
	child?: ChildProcess
	exited: Promise<void>
	stopping: boolean
	/**
	 * Set once the leader has exited and its group was killed: the group's ID may then be reused,
	 * so it is never signalled again.
	 */
	groupDone: boolean
	timer?: NodeJS.Timeout
	poll?: NodeJS.Timeout
}

export function createKitBuildRunner(options: KitBuildRunnerOptions): KitBuildRunner {
	const settleMs = options.settleMs ?? KIT_BUILD_SETTLE_MS
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS
	const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
	const print = options.print ?? ((line: string) => console.log(line))
	const detached = process.platform !== 'win32'
	const log = new KitBuildLog()
	let status: KitBuildStatus = { state: 'none' }
	let generation: number | undefined
	let started = false
	let runs = 0
	let current: Run | undefined
	let declared: KitBuildDeclaration | undefined
	let maskRoots: string[] = [options.root]
	let queue: Promise<unknown> = Promise.resolve()
	const restartIntervalMs = options.restartIntervalMs ?? KIT_BUILD_RESTART_INTERVAL_MS
	const generationWarning = options.generationWarning ?? KIT_BUILD_GENERATION_WARNING
	let warnedGenerations = false
	/** The restart waiting in the queue, not yet begun, which a further request shares. */
	let queuedRestart: Promise<KitBuildRestart> | undefined
	let lastRestartAt: number | undefined

	function advanceGeneration(): void {
		generation = (generation ?? 0) + 1
		if (!warnedGenerations && generation > generationWarning) {
			warnedGenerations = true
			print(`uiux: warning: the kit build has produced more than ${generationWarning} outputs in this server; each one loads its Adapter module anew and Node keeps every loaded module in memory. Restart uiux dev to release them.`)
		}
	}

	function restart(): Promise<KitBuildRestart> {
		if (queuedRestart) return queuedRestart
		const now = Date.now()
		if (lastRestartAt !== undefined && now - lastRestartAt < restartIntervalMs)
			return Promise.resolve({ outcome: 'throttled', retryAfterMs: restartIntervalMs - (now - lastRestartAt) })
		lastRestartAt = now
		const queued: Promise<KitBuildRestart> = serialize(async () => {
			if (queuedRestart === queued) queuedRestart = undefined
			if (current) await terminate(current)
			return { outcome: 'started', build: await begin() }
		})
		queuedRestart = queued
		return queued
	}

	function serialize<T>(task: () => Promise<T>): Promise<T> {
		const next = queue.then(task, task)
		queue = next.catch(() => undefined)
		return next
	}

	/** Secret values first, from the build's environment and the server's own, then host paths. */
	function mask(text: string): string {
		return maskHostPaths(maskSecrets(text, secretValues(options.env ?? process.env, process.env)), maskRoots)
	}

	function settle(run: Run, next: KitBuildStatus): void {
		if (current?.id !== run.id) return
		status = next
		if (next.state === 'failed') print(`uiux: kit build failed: ${next.message ?? 'see the build log'}`)
		if (next.state !== 'building') clearTimers(run)
	}

	function clearTimers(run: Run): void {
		if (run.timer) clearTimeout(run.timer)
		if (run.poll) clearTimeout(run.poll)
		run.timer = undefined
		run.poll = undefined
	}

	function signalGroup(run: Run, signal: NodeJS.Signals): void {
		const child = run.child
		if (!child || child.pid === undefined || run.groupDone) return
		try {
			if (detached) process.kill(-child.pid, signal)
			else child.kill(signal)
		}
		catch { /* the process group is already gone */ }
	}

	async function terminate(run: Run): Promise<void> {
		run.stopping = true
		clearTimers(run)
		if (!run.child) return
		signalGroup(run, 'SIGTERM')
		const exited = await Promise.race([run.exited.then(() => true), delay(killGraceMs).then(() => false)])
		// A leader still running after the grace period is killed with its group; one that exited
		// had its group killed then (`groupDone`), so nothing is signalled again.
		signalGroup(run, 'SIGKILL')
		if (!exited) await Promise.race([run.exited, delay(killGraceMs)])
	}

	async function begin(): Promise<KitBuildStatus> {
		const run: Run = { id: ++runs, exited: Promise.resolve(), stopping: false, groupDone: false }
		current = run
		log.clear()
		declared = undefined
		const first = !started
		started = true
		const name = options.codeDirectoryName
		const realRoot = await realpath(options.root).catch(() => undefined)
		maskRoots = realRoot && realRoot !== options.root ? [realRoot, options.root] : [options.root]
		const kitDirectory = name && realRoot ? join(realRoot, name) : undefined
		// Without a real kit/ directory (or below schemaVersion 5) there is no kit project to build.
		if (!kitDirectory || !realRoot || !await realDirectoryIdentity(kitDirectory).catch(() => undefined)) {
			status = { state: 'none' }
			return status
		}
		const read = await readKitBuildDeclaration(kitDirectory)
		if (read.state === 'none') {
			status = { state: 'none' }
			return status
		}
		if (read.state === 'invalid') {
			settle(run, { state: 'failed', message: mask(read.message) })
			return status
		}
		const declaration = read.declaration
		declared = declaration
		const outputDirectory = join(kitDirectory, ...declaration.output.split('/'))
		// An output a previous session left is the last good output until this run settles (Rule 01a11bb1-9e5e-…).
		if (first && generation === undefined && (await outputListing(kitDirectory, outputDirectory))?.files)
			generation = 0

		const watching = declaration.watch !== undefined
		const argv = declaration.watch ?? declaration.command
		print(`uiux: kit build: running ${JSON.stringify(argv)} in ${name}/${watching ? ' (watch)' : ''}`)
		status = { state: 'building' }

		let child: ChildProcess
		try {
			child = spawn(argv[0]!, argv.slice(1), {
				cwd: kitDirectory,
				env: kitBuildEnvironment(options.env ?? process.env, kitDirectory, realRoot),
				stdio: ['ignore', 'pipe', 'pipe'],
				shell: false,
				detached,
				windowsHide: true,
			})
		}
		catch (error) {
			settle(run, { state: 'failed', message: mask(`The build could not start ${JSON.stringify(argv[0])}: ${error instanceof Error ? error.message : String(error)}`) })
			return status
		}
		run.child = child
		run.exited = new Promise<void>(resolveExit => child.once('exit', () => {
			// What the process started may outlive it, so its group is killed once, as it exits.
			signalGroup(run, 'SIGKILL')
			run.groupDone = true
			resolveExit()
		}))
		child.stdout?.on('data', (chunk: Buffer) => log.write(chunk))
		child.stderr?.on('data', (chunk: Buffer) => log.write(chunk))

		let exitedCleanly = false
		let observed: string | null = null
		let lastChange = Date.now()
		let changedSinceReady = false

		child.once('error', (error: NodeJS.ErrnoException) => {
			if (run.stopping) return
			settle(run, { state: 'failed', message: mask(`The build could not start ${JSON.stringify(argv[0])}${error.code ? ` (${error.code})` : ''}.`) })
		})
		child.once('exit', (code, signal) => {
			if (run.stopping || current?.id !== run.id || status.state === 'failed') return
			if (code === 0) {
				exitedCleanly = true
				return
			}
			settle(run, { state: 'failed', message: code === null ? `The build process was stopped by ${signal ?? 'a signal'}.` : `The build process exited with code ${code}.` })
		})
		run.timer = setTimeout(() => {
			if (current?.id !== run.id || status.state !== 'building') return
			const message = watching
				? `The watch command produced no settled output within ${declaration.timeoutSeconds} s and was stopped.`
				: `The build timed out after ${declaration.timeoutSeconds} s and was stopped.`
			settle(run, { state: 'failed', message })
			void terminate(run)
		}, declaration.timeoutSeconds * 1000)

		const tick = async (): Promise<void> => {
			if (current?.id !== run.id || run.stopping) return
			const listing = await outputListing(kitDirectory, outputDirectory)
			if (current?.id !== run.id || run.stopping) return
			const now = Date.now()
			const signature = listing?.signature ?? ''
			if (signature !== observed) {
				if (observed !== null) {
					changedSinceReady = true
					// A watch rebuild is a new run in progress.
					if (watching && status.state === 'ready') status = { state: 'building' }
				}
				observed = signature
				lastChange = now
			}
			const quiet = now - lastChange >= settleMs
			if (status.state === 'building' && quiet) {
				if (exitedCleanly) {
					if (listing?.files) {
						advanceGeneration()
						settle(run, { state: 'ready' })
					}
					else settle(run, { state: 'failed', message: `The build produced no output in ${name}/${declaration.output}/.` })
				}
				else if (watching && changedSinceReady && listing?.files) {
					changedSinceReady = false
					advanceGeneration()
					status = { state: 'ready' }
					if (run.timer) clearTimeout(run.timer)
					run.timer = undefined
				}
			}
			if (status.state === 'failed' && current?.id === run.id) return
			if (!exitedCleanly || status.state === 'building') run.poll = setTimeout(() => { void tick() }, pollMs)
		}
		void tick()
		return status
	}

	return Object.freeze({
		status: () => status,
		log: () => mask(log.text()),
		outputGeneration: () => generation,
		declaration: () => declared,
		start: () => serialize(async () => {
			if (current) return status
			return begin()
		}),
		restart,
		stop: () => serialize(async () => {
			const run = current
			if (run) await terminate(run)
		}),
		stopSync() {
			const run = current
			if (!run) return
			run.stopping = true
			clearTimers(run)
			signalGroup(run, 'SIGKILL')
		},
	})
}

/**
 * The build output listing, read without following links: a signature that changes with any
 * entry's path, type, size or modification time, and whether it holds any file. `undefined` when
 * the output is not a real directory inside `kit/`.
 */
async function outputListing(kitDirectory: string, outputDirectory: string): Promise<Readonly<{ signature: string; files: number }> | undefined> {
	if (!await realDirectoryIdentity(outputDirectory).catch(() => undefined)) return undefined
	if (await containedRealPath(kitDirectory, outputDirectory) === undefined) return undefined
	const entries: string[] = []
	let files = 0
	const pending = ['']
	while (pending.length > 0 && entries.length < MAX_OUTPUT_ENTRIES) {
		const relative = pending.pop()!
		const names = await readdir(relative ? join(outputDirectory, relative) : outputDirectory).catch(() => [] as string[])
		for (const name of names) {
			if (entries.length >= MAX_OUTPUT_ENTRIES) break
			const path = relative ? `${relative}/${name}` : name
			const info = await lstat(join(outputDirectory, path)).catch(() => undefined)
			if (!info) continue
			const type = info.isDirectory() ? 'd' : info.isFile() ? 'f' : 'o'
			if (type === 'f') files++
			entries.push(`${path}\0${type}\0${info.size}\0${info.mtimeMs}`)
			if (type === 'd') pending.push(path)
		}
	}
	entries.sort()
	return { signature: createHash('sha256').update(entries.join('\n')).digest('hex'), files }
}

function delay(ms: number): Promise<void> {
	return new Promise(resolveDelay => setTimeout(resolveDelay, ms).unref?.())
}

/**
 * The runner of each selected Workspace root in this process, consulted by Adapter resolution and
 * the Preview bundle for the last good output (`src/server/workspace-adapters.ts`).
 */
const runners = new Map<string, KitBuildRunner>()

export function registerKitBuildRunner(root: string, runner: KitBuildRunner): () => void {
	runners.set(root, runner)
	return () => {
		if (runners.get(root) === runner) runners.delete(root)
	}
}

export function kitBuildRunnerFor(root: string): KitBuildRunner | undefined {
	return runners.get(root)
}
