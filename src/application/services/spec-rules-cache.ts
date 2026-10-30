import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createSpecClient } from '@deviltea/spec-tool'

/**
 * A cache of the Rules of a Spec Tool workspace, for the `spec` requirements provider (issue #390).
 *
 * A read of the workspace exports the whole graph (about 100 ms for this repository's `.spec/`) and, while
 * a Spec Tool writer holds its lock, waits for it. Spec Tool exposes its revision only through such a
 * read, so the cache keys on a cheap change signal instead: a fingerprint of the name, size, inode and
 * modification and change time of every entry under `.spec/` (a directory's own time moves when an entry is added,
 * removed or renamed). An unchanged signature serves the Rules read last, with the status of a provider
 * that was read; a changed one reads again. Nothing is served for a changed workspace, so no staleness
 * is reported: Clause 01a18120-f903-7f8d-9b44-d581ab520c0d has `none`, `url`, `ok` and `unavailable`, and
 * no status for stale data.
 *
 * While a writer holds the workspace's lock and the signature changed (or nothing is cached), a read waits
 * only {@link WRITER_WAIT_MS} before it reports the provider as unavailable, where the Spec Tool reader
 * would wait up to 30 s. Reads that overlap share one underlying read, even after one of them gave up,
 * so a held lock does not pile up readers (a few can still start while a writer publishes).
 */

/** How long a read waits while a Spec Tool writer holds the workspace's lock. */
export const WRITER_WAIT_MS = 2_000

/** How long a read of a workspace nobody is writing may take. */
export const READ_TIMEOUT_MS = 10_000

const MAX_ENTRIES = 16

export type SpecRulesRead = Readonly<{ ok: true; rules: ReadonlyMap<string, string> }> | Readonly<{ ok: false; reason: string }>

/** The effects of the cache, a seam for tests. `root` is the directory holding `.spec/`. */
export type SpecWorkspaceSource = Readonly<{
	/** The change signal of the workspace; it differs whenever a file under `.spec/` changed. */
	signature: (root: string) => Promise<string>
	/** Whether a Spec Tool writer holds the workspace's lock now. */
	writerActive: (root: string) => Promise<boolean>
	/** The Rules by full UUID (the statement is the Rule's text); waits for a writer as Spec Tool does. */
	readRules: (root: string) => Promise<ReadonlyMap<string, string>>
}>

export type SpecRulesCache = Readonly<{
	read: (root: string) => Promise<SpecRulesRead>
	clear: () => void
}>

async function fingerprint(directory: string, prefix: string, lines: string[]): Promise<void> {
	const own = await lstat(directory)
	lines.push(`${prefix}/ ${own.mtimeMs} ${own.ctimeMs} ${own.ino}`)
	const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)
	const collected = await Promise.all(entries.map(async (entry) => {
		const path = join(directory, entry.name)
		const name = `${prefix}/${entry.name}`
		if (entry.isDirectory()) {
			const nested: string[] = []
			await fingerprint(path, name, nested)
			return nested
		}
		const stats = await lstat(path)
		return [`${name} ${stats.size} ${stats.mtimeMs} ${stats.ctimeMs} ${stats.ino}`]
	}))
	for (const part of collected) lines.push(...part)
}

/** The Spec Tool workspace on the file system: `.spec/` for the signature, the lock beside it, the client for the read. */
export const fileSystemSpecWorkspace: SpecWorkspaceSource = {
	async signature(root) {
		const lines: string[] = []
		await fingerprint(join(root, '.spec'), '.spec', lines)
		return createHash('sha1').update(lines.join('\n')).digest('hex')
	},
	async writerActive(root) {
		try {
			await lstat(join(root, '.spec-tool-v1.lock'))
			return true
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
			throw error
		}
	},
	async readRules(root) {
		const exported = await createSpecClient(root).graph.export()
		const rules = new Map<string, string>()
		for (const node of exported.data.nodes) {
			if (node.kind === 'rule') rules.set(node.id, node.statement)
		}
		return rules
	},
}

function failure(error: unknown): SpecRulesRead {
	return { ok: false, reason: error instanceof Error && error.message !== '' ? error.message : 'The Spec Tool workspace cannot be read.' }
}

export function createSpecRulesCache(
	source: SpecWorkspaceSource = fileSystemSpecWorkspace,
	options: Readonly<{ writerWaitMs?: number; readTimeoutMs?: number }> = {},
): SpecRulesCache {
	const writerWaitMs = options.writerWaitMs ?? WRITER_WAIT_MS
	const readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS
	const entries = new Map<string, Readonly<{ signature: string; rules: ReadonlyMap<string, string> }>>()
	const inflight = new Map<string, Promise<ReadonlyMap<string, string>>>()

	function store(root: string, signature: string, rules: ReadonlyMap<string, string>): void {
		entries.delete(root)
		entries.set(root, { signature, rules })
		for (const oldest of entries.keys()) {
			if (entries.size <= MAX_ENTRIES) break
			entries.delete(oldest)
		}
	}

	/** One read per workspace state at a time; the read outlives a caller that stopped waiting for it. */
	function sharedRead(root: string, signature: string | undefined): Promise<ReadonlyMap<string, string>> {
		const key = `${root}\0${signature ?? ''}`
		const pending = inflight.get(key)
		if (pending) return pending
		const started = (async () => {
			const rules = await source.readRules(root)
			// A write during the read leaves it unattributable to either signature: do not cache it.
			if (signature !== undefined && await source.signature(root).catch(() => undefined) === signature) store(root, signature, rules)
			return rules
		})()
		const tracked = started.finally(() => { if (inflight.get(key) === tracked) inflight.delete(key) })
		inflight.set(key, tracked)
		// A reader that timed out leaves nobody awaiting this when it fails later.
		tracked.catch(() => undefined)
		return tracked
	}

	async function read(root: string): Promise<SpecRulesRead> {
		let signature: string | undefined
		try {
			signature = await source.signature(root)
		}
		catch {
			// A workspace that changes under the walk, or cannot be walked: read it without the cache.
			signature = undefined
		}
		if (signature !== undefined) {
			const hit = entries.get(root)
			if (hit?.signature === signature) return { ok: true, rules: hit.rules }
		}
		let writing = false
		try {
			writing = await source.writerActive(root)
		}
		catch {
			writing = false
		}
		const limit = writing ? writerWaitMs : readTimeoutMs
		let timer: NodeJS.Timeout | undefined
		try {
			const rules = await Promise.race([
				sharedRead(root, signature),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(writing
						? 'A Spec Tool writer holds the workspace lock, or `.spec-tool-v1.lock` beside `.spec/` is stale (remove it if no `spec` process is running); the provider is read again on the next request.'
						: 'The Spec Tool workspace did not answer in time.')), limit)
				}),
			])
			return { ok: true, rules }
		}
		catch (error) {
			return failure(error)
		}
		finally {
			if (timer) clearTimeout(timer)
		}
	}

	return { read, clear: () => { entries.clear(); inflight.clear() } }
}

/** The cache the `spec` provider reads through. */
export const specRulesCache: SpecRulesCache = createSpecRulesCache()
