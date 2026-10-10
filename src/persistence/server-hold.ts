import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, rmSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { hostname } from 'node:os'

import { isRecord } from '../domain/validation'
import { LEGACY_LAYOUT, resolveWorkspacePath, type WorkspaceLayout } from './paths'

/**
 * A live UIUX server's claim on its selected Workspace. It is local runtime state (never a
 * canonical file, never migrated or exported) that lets operator commands such as
 * `uiux migrate` refuse to rewrite a Workspace that a running server is serving. This is its path in
 * the legacy layout; a caller that holds a layout reads `layout.serverHoldPath`.
 */
export const SERVER_HOLD_RELATIVE_PATH = LEGACY_LAYOUT.serverHoldPath

export type ServerHold = Readonly<{
	pid: number
	hostname: string
	startedAt: string
	token: string
	/** The server's internal loopback origin, so host commands can name the server's port (`uiux invite create`). */
	origin?: string
}>

export type AcquiredServerHold = Readonly<{
	hold: ServerHold
	release(): Promise<void>
	/** Synchronous best-effort release for process `exit` handlers. */
	releaseSync(): void
}>

/**
 * Records the current process as the server holding `root`. Returns undefined when the Workspace
 * has no real metadata directory (the layout's `metadataDir`; an uninitialized root is not held).
 */
export async function acquireServerHold(root: string, options: Readonly<{ origin?: string; layout?: WorkspaceLayout }> = {}): Promise<AcquiredServerHold | undefined> {
	const layout = options.layout ?? LEGACY_LAYOUT
	const metadata = resolveWorkspacePath(root, layout.metadataDir)
	try {
		const stat = await fs.lstat(metadata)
		if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined
	}
	catch (error) {
		if (isNotFound(error)) return undefined
		throw error
	}
	const hold: ServerHold = { pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(), token: randomUUID(), ...(options.origin ? { origin: options.origin } : {}) }
	const target = resolveWorkspacePath(root, layout.serverHoldPath)
	const temporary = resolveWorkspacePath(root, layout.metadataFilePath(`.server-hold-${hold.token}.tmp`))
	await fs.writeFile(temporary, `${JSON.stringify(hold)}\n`, { encoding: 'utf8', flag: 'wx' })
	await fs.rename(temporary, target)
	const ownsHold = (bytes: string): boolean => {
		try {
			const parsed = JSON.parse(bytes) as unknown
			return isRecord(parsed) && parsed.token === hold.token
		}
		catch { return false }
	}
	return {
		hold,
		async release() {
			try {
				if (ownsHold(await fs.readFile(target, 'utf8'))) await fs.rm(target, { force: true })
			}
			catch (error) { if (!isNotFound(error)) throw error }
		},
		releaseSync() {
			try {
				if (lstatSync(target).isFile() && ownsHold(readFileSync(target, 'utf8'))) rmSync(target, { force: true })
			}
			catch { /* best effort during process exit */ }
		},
	}
}

/**
 * Returns the hold of a server that is still running, or undefined when the Workspace is not held.
 * A hold whose process no longer exists on this host is stale and ignored. A hold recorded by
 * another host cannot be checked and is treated as active.
 */
export async function readActiveServerHold(root: string, layout: WorkspaceLayout = LEGACY_LAYOUT): Promise<ServerHold | undefined> {
	let text: string
	try { text = await fs.readFile(resolveWorkspacePath(root, layout.serverHoldPath), 'utf8') }
	catch (error) {
		if (isNotFound(error)) return undefined
		throw error
	}
	let parsed: unknown
	try { parsed = JSON.parse(text) }
	catch { return undefined }
	if (!isRecord(parsed) || typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid < 1
		|| typeof parsed.hostname !== 'string' || typeof parsed.startedAt !== 'string' || typeof parsed.token !== 'string')
		return undefined
	const hold: ServerHold = {
		pid: parsed.pid,
		hostname: parsed.hostname,
		startedAt: parsed.startedAt,
		token: parsed.token,
		...(typeof parsed.origin === 'string' ? { origin: parsed.origin } : {}),
	}
	if (hold.hostname !== hostname()) return hold
	return isProcessAlive(hold.pid) ? hold : undefined
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	}
	catch (error) {
		return (error as NodeJS.ErrnoException)?.code === 'EPERM'
	}
}

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}
