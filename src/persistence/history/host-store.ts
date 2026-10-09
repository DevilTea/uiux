import { createHash, randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import {
	validateHostVersionRecord,
	validateWriteEvent,
	type HistoryWriteEvent,
	type HostVersionRecord,
} from '../../domain/history/schema'
import { isFullUuid, isRecord, isSafeRelativePath, isSha256Digest, validateUtcTimestamp, Validator, type Diagnostic } from '../../domain/validation'
import { canonicalJsonBytes, type PersistenceFaultHook, type PersistenceFaultPoint } from '../file-native'
import { compareVersionOrder } from './order'

/**
 * Host-stored history of one Workspace (Rule 01a11a5e-0485-7a8e-8194-a75c9cf65028, Clause
 * 01a11a5e-1e65-7deb-a89e-6ad021248fe0): autosave, external and system versions, the open
 * autosave's events and the file blobs they name, under `$UIUX_HOME/workspaces/<wsid>/history/`.
 *
 * - Each version is one canonical JSON file `versions/<uuid>.json`, written atomically (temporary
 *   file, fsync, then a no-replace link or a rename) so a crash never leaves a partial record
 *   (Rule 01a11a5e-0591-7987-a719-e5b40143d3d4).
 * - `open.json` is the open autosave's journal: one JSON entry per line, appended and fsynced.
 *   Only its last line can be cut short by a crash; a reader drops that line and the next append
 *   trims it first, so the journal stays readable.
 * - Blobs are `objects/sha256/<2>/<64>`, immutable and content-addressed.
 * - Like the roster, directories are 0700 and files 0600; a symbolic link, a non-directory, a
 *   non-regular file or a group- or other-writable entry is refused.
 *
 * The store takes no lock of its own: every mutation runs while the caller holds the Workspace's
 * exclusive persistence lock, which serializes the recorder, pruning and every other UIUX process
 * on the same Workspace.
 */
export type HostHistoryPaths = Readonly<{
	home: string
	workspaces: string
	/** The roster's `<wsid>` directory. */
	workspaceDir: string
	/** `<wsid>/history`. */
	dir: string
	versions: string
	open: string
	/** `history/objects/sha256`. */
	objects: string
}>

export type HostHistoryErrorCode =
	| 'history.store_unsafe'
	| 'history.record_invalid'
	| 'history.record_exists'
	| 'history.record_missing'
	| 'history.journal_invalid'
	| 'history.blob_corrupt'
	| 'history.write_failed'
	| 'history.rollback_failed'

/** Implementation-defined store errors (not diagnostics of any Contract). */
export class HostHistoryError extends Error {
	readonly code: HostHistoryErrorCode
	readonly diagnostics: readonly Diagnostic[]
	override readonly cause?: unknown

	constructor(code: HostHistoryErrorCode, message: string, options: { diagnostics?: readonly Diagnostic[]; cause?: unknown } = {}) {
		super(message)
		this.name = 'HostHistoryError'
		this.code = code
		this.diagnostics = options.diagnostics ?? []
		this.cause = options.cause
	}
}

/**
 * One line of `open.json` (its format beyond holding the open autosave's events is left to the
 * implementation by the Version history records Contract notes):
 * - `begin` opens the autosave with the id its version will have;
 * - `event` is one write event plus the blob digest of each file it changed (`null` when removed);
 * - `gap` marks that recording failed while the autosave was open.
 */
export type OpenAutosaveEntry =
	| Readonly<{ type: 'begin'; id: string; startedAt: string }>
	| Readonly<{ type: 'event'; event: HistoryWriteEvent; files: Readonly<Record<string, string | null>> }>
	| Readonly<{ type: 'gap'; at: string }>

export type OpenAutosaveJournal = Readonly<{
	entries: readonly OpenAutosaveEntry[]
	/** True when a final line cut short by a crash was dropped. */
	droppedPartialLine: boolean
}>

export type InvalidHistoryFile = Readonly<{ file: string; diagnostics: readonly Diagnostic[] }>

export type HostVersionListing = Readonly<{
	/** Valid versions, oldest first by `at`, then `id`. */
	records: readonly HostVersionRecord[]
	/** Files under `versions/` that are not a valid version record. */
	invalid: readonly InvalidHistoryFile[]
}>

export type OpenHostHistoryStoreOptions = Readonly<{
	paths: HostHistoryPaths
	/** Create the missing directories (0700). Without it a missing directory means no store. */
	create?: boolean
	/** Fault injection for tests, called with paths relative to the history directory. */
	fault?: PersistenceFaultHook
}>

const VERSION_FILE = /^(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/iu
const NEWLINE = 0x0A

export class HostHistoryStore {
	readonly paths: HostHistoryPaths
	private readonly fault?: PersistenceFaultHook

	private constructor(paths: HostHistoryPaths, fault?: PersistenceFaultHook) {
		this.paths = paths
		this.fault = fault
	}

	/** Opens the host history directory, checking (and with `create`, making) every directory down to it. */
	static async open(options: OpenHostHistoryStoreOptions): Promise<HostHistoryStore | undefined> {
		const { paths } = options
		for (const directory of [paths.home, paths.workspaces, paths.workspaceDir, paths.dir, paths.versions, dirname(paths.objects), paths.objects]) {
			if (!await ensurePrivateDirectory(directory, options.create === true)) return undefined
		}
		return new HostHistoryStore(paths, options.fault)
	}

	// ── Versions ────────────────────────────────────────────────────────────────

	/** Writes a new version file; an existing id is refused (`history.record_exists`). */
	async writeVersion(record: HostVersionRecord): Promise<void> {
		const bytes = versionBytes(record)
		await ensurePrivateDirectory(this.paths.versions, true)
		const target = this.versionPath(record.id)
		await this.publishFile(target, bytes, { replace: false, points: ['file.before_rename', 'file.after_rename'] })
	}

	/** Atomically replaces an existing version file (re-pointing a parent after pruning). */
	async replaceVersion(record: HostVersionRecord): Promise<void> {
		const bytes = versionBytes(record)
		const target = this.versionPath(record.id)
		if (!await checkPrivateFile(target))
			throw new HostHistoryError('history.record_missing', `Host version ${record.id} does not exist.`)
		await this.publishFile(target, bytes, { replace: true, points: ['file.before_rename', 'file.after_rename'] })
	}

	async readVersion(id: string): Promise<HostVersionRecord | undefined> {
		const bytes = await readPrivateFileIfPresent(this.versionPath(id))
		if (!bytes) return undefined
		const result = decodeVersion(bytes, id)
		if (!result.ok)
			throw new HostHistoryError('history.record_invalid', `Host version ${id} is not a valid version record.`, { diagnostics: result.diagnostics })
		return result.value
	}

	/** Every version file; temporary files (dot-files) are skipped, any other entry is reported invalid. */
	async listVersions(): Promise<HostVersionListing> {
		await ensurePrivateDirectory(this.paths.versions, false)
		let entries: import('node:fs').Dirent[]
		try { entries = await fs.readdir(this.paths.versions, { withFileTypes: true }) }
		catch (error) {
			if (isNotFound(error)) return { records: [], invalid: [] }
			throw error
		}
		const records: HostVersionRecord[] = []
		const invalid: InvalidHistoryFile[] = []
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue
			const file = `versions/${entry.name}`
			const id = VERSION_FILE.exec(entry.name)?.groups?.id
			if (!id || !entry.isFile()) {
				invalid.push({ file, diagnostics: [{ code: 'history.unexpected_file', path: `/${file}`, message: 'Only regular <uuid>.json version files belong in versions/.' }] })
				continue
			}
			// A version removed between the directory read and this read (pruning) is simply gone.
			const bytes = await readPrivateFileIfPresent(this.versionPath(id))
			if (!bytes) continue
			const result = decodeVersion(bytes, id)
			if (result.ok) records.push(result.value)
			else invalid.push({ file, diagnostics: result.diagnostics })
		}
		return { records: records.sort(compareVersionOrder), invalid }
	}

	async removeVersion(id: string): Promise<void> {
		const path = this.versionPath(id)
		if (!await checkPrivateFile(path)) return
		await fs.unlink(path)
		await syncDirectory(this.paths.versions)
	}

	// ── Open autosave journal ───────────────────────────────────────────────────

	/** Appends one entry as one line and fsyncs it; a line cut short by an earlier crash is trimmed first. */
	async appendOpenEntry(entry: OpenAutosaveEntry): Promise<void> {
		const validation = validateOpenEntry(entry, '')
		if (validation.length > 0)
			throw new HostHistoryError('history.journal_invalid', 'Refusing to append an invalid open-autosave entry.', { diagnostics: validation })
		const line = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8')
		const existed = await checkPrivateFile(this.paths.open) !== undefined
		const handle = await fs.open(this.paths.open, constants.O_RDWR | constants.O_CREAT | noFollow(), 0o600)
		try {
			if (existed) await trimPartialLastLine(handle)
			const { size } = await handle.stat()
			await writeFullyAt(handle, line, size)
			await handle.sync()
		}
		finally {
			await handle.close()
		}
		if (!existed) await syncDirectory(this.paths.dir)
	}

	/** The open autosave's entries, or `undefined` when no autosave is open. */
	async readOpenJournal(): Promise<OpenAutosaveJournal | undefined> {
		if (!await checkPrivateFile(this.paths.open)) return undefined
		let bytes: Buffer
		try { bytes = await fs.readFile(this.paths.open) }
		catch (error) {
			if (isNotFound(error)) return undefined
			throw error
		}
		return parseOpenJournal(bytes)
	}

	/** Removes `open.json` once its autosave has been written as a version. */
	async clearOpenJournal(): Promise<void> {
		if (!await checkPrivateFile(this.paths.open)) return
		await fs.rm(this.paths.open, { force: true })
		await syncDirectory(this.paths.dir)
	}

	// ── Blobs ───────────────────────────────────────────────────────────────────

	/** Stores `bytes` once under their SHA-256 and returns their `sha256:<hex>` digest. */
	async putBlob(bytes: Uint8Array): Promise<string> {
		const digest = blobDigest(bytes)
		const target = this.blobPath(digest)
		await ensurePrivateDirectory(dirname(target), true)
		if (await checkPrivateFile(target)) {
			await this.verifyBlob(digest, target)
			return digest
		}
		const published = await this.publishFile(target, bytes, { replace: false, points: ['artifact.before_publish', 'artifact.after_publish'], allowExisting: true })
		if (!published) await this.verifyBlob(digest, target)
		return digest
	}

	async readBlob(digest: string): Promise<Uint8Array | undefined> {
		const bytes = await readPrivateFileIfPresent(this.blobPath(digest))
		if (!bytes) return undefined
		if (blobDigest(bytes) !== digest)
			throw new HostHistoryError('history.blob_corrupt', `Host blob ${digest} does not match its content digest.`)
		return Uint8Array.from(bytes)
	}

	async hasBlob(digest: string): Promise<boolean> {
		return await checkPrivateFile(this.blobPath(digest)) !== undefined
	}

	/** Every stored blob digest, sorted; entries that are not `<2>/<64>` hex files are ignored. */
	async listBlobDigests(): Promise<readonly string[]> {
		const digests: string[] = []
		let shards: import('node:fs').Dirent[]
		try { shards = await fs.readdir(this.paths.objects, { withFileTypes: true }) }
		catch (error) {
			if (isNotFound(error)) return []
			throw error
		}
		for (const shard of shards) {
			if (!shard.isDirectory() || !/^[0-9a-f]{2}$/u.test(shard.name)) continue
			const shardPath = join(this.paths.objects, shard.name)
			if (!await ensurePrivateDirectory(shardPath, false)) continue
			let entries: import('node:fs').Dirent[]
			try { entries = await fs.readdir(shardPath, { withFileTypes: true }) }
			catch (error) {
				if (isNotFound(error)) continue
				throw error
			}
			for (const entry of entries) {
				if (entry.isFile() && /^[0-9a-f]{64}$/u.test(entry.name) && entry.name.startsWith(shard.name))
					digests.push(`sha256:${entry.name}`)
			}
		}
		return digests.sort()
	}

	async removeBlob(digest: string): Promise<void> {
		const path = this.blobPath(digest)
		if (!await checkPrivateFile(path)) return
		await fs.unlink(path)
		await syncDirectory(dirname(path))
	}

	// ── Internals ───────────────────────────────────────────────────────────────

	private versionPath(id: string): string {
		if (!isFullUuid(id))
			throw new HostHistoryError('history.record_invalid', 'A host version id must be a full UUID.')
		return join(this.paths.versions, `${id}.json`)
	}

	private blobPath(digest: string): string {
		if (!isSha256Digest(digest))
			throw new HostHistoryError('history.blob_corrupt', 'A blob digest must be sha256:<64 lowercase hexadecimal characters>.')
		const hex = digest.slice('sha256:'.length)
		return join(this.paths.objects, hex.slice(0, 2), hex)
	}

	private async verifyBlob(digest: string, path: string): Promise<void> {
		if (blobDigest(await fs.readFile(path)) !== digest)
			throw new HostHistoryError('history.blob_corrupt', `Existing host blob ${digest} does not match its content digest.`)
	}

	/**
	 * Temporary file (0600, fsync) in the target's directory, then a no-replace link (new files) or
	 * a rename (replacement), then a directory fsync. A failure before the link or rename leaves no
	 * trace; a failure after it restores the previous state. Returns false when `allowExisting` and
	 * another writer published the same path first.
	 */
	private async publishFile(target: string, bytes: Uint8Array, options: Readonly<{ replace: boolean; points: readonly [PersistenceFaultPoint, PersistenceFaultPoint]; allowExisting?: boolean }>): Promise<boolean> {
		const directory = dirname(target)
		const temporary = join(directory, `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
		const previous = options.replace ? await fs.readFile(target) : undefined
		const relative = target.slice(this.paths.dir.length + 1).split('\\').join('/')
		let published = false
		try {
			const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600)
			try {
				await handle.writeFile(bytes)
				await handle.sync()
			}
			finally {
				await handle.close()
			}
			await this.fault?.(options.points[0], { path: relative })
			if (options.replace) await fs.rename(temporary, target)
			else {
				try { await fs.link(temporary, target) }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
					if (options.allowExisting) return false
					throw new HostHistoryError('history.record_exists', `History record ${relative} already exists.`)
				}
			}
			published = true
			await this.fault?.(options.points[1], { path: relative })
			await syncDirectory(directory)
			return true
		}
		catch (cause) {
			if (published) {
				try {
					if (previous) await replaceWithoutFault(target, previous)
					else await fs.rm(target, { force: true })
					await syncDirectory(directory)
				}
				catch (rollbackCause) {
					throw new HostHistoryError('history.rollback_failed', `Could not roll back ${relative} after an interrupted write.`, { cause: new AggregateError([cause, rollbackCause]) })
				}
			}
			if (cause instanceof HostHistoryError) throw cause
			throw new HostHistoryError('history.write_failed', `Atomic write of ${relative} failed; the previous state was kept.`, { cause })
		}
		finally {
			await fs.rm(temporary, { force: true }).catch(() => undefined)
		}
	}
}

/**
 * Parses `open.json`. Every entry is written with its newline in one fsynced append, so only a
 * final part without a newline can be a crash remnant: it is dropped (the append that wrote it
 * never completed). Any complete line that is not a valid entry means the journal is corrupt.
 */
export function parseOpenJournal(bytes: Uint8Array): OpenAutosaveJournal {
	const lines = Buffer.from(bytes).toString('utf8').split('\n')
	// A complete journal ends with a newline, so the last split part is empty.
	const droppedPartialLine = lines.pop()!.length > 0
	const entries: OpenAutosaveEntry[] = []
	for (let index = 0; index < lines.length; index++) {
		let value: unknown
		try { value = JSON.parse(lines[index]!) }
		catch (cause) {
			throw new HostHistoryError('history.journal_invalid', `open.json line ${index + 1} is not valid JSON.`, { cause })
		}
		const diagnostics = validateOpenEntry(value, `/${index}`)
		if (diagnostics.length > 0)
			throw new HostHistoryError('history.journal_invalid', `open.json line ${index + 1} is not a valid open-autosave entry.`, { diagnostics })
		entries.push(value as OpenAutosaveEntry)
	}
	return { entries, droppedPartialLine }
}

function validateOpenEntry(input: unknown, path: string): readonly Diagnostic[] {
	const v = new Validator()
	const entry = v.object(input, path)
	if (!entry) return v.diagnostics
	const allowed = (keys: readonly string[]) => {
		for (const key of Object.keys(entry))
			if (!keys.includes(key)) v.issue('schema.unknown_field', `${path}/${key}`, 'Unknown open-autosave entry member.')
	}
	switch (entry.type) {
		case 'begin':
			allowed(['type', 'id', 'startedAt'])
			if (!isFullUuid(entry.id)) v.issue('history.invalid_open_entry', `${path}/id`, 'The open autosave id is a full UUID.')
			validateUtcTimestamp(entry.startedAt, `${path}/startedAt`, v)
			break
		case 'event': {
			allowed(['type', 'event', 'files'])
			v.diagnostics.push(...validateWriteEvent(entry.event, `${path}/event`).diagnostics)
			const files = v.object(entry.files, `${path}/files`)
			for (const [file, digest] of Object.entries(files ?? {})) {
				if (!isSafeRelativePath(file)) v.issue('history.invalid_file_path', `${path}/files`, 'Expected a Workspace-relative path without traversal.')
				if (digest !== null && !isSha256Digest(digest)) v.issue('identity.invalid_sha256', `${path}/files`, 'Expected a sha256 digest or null.')
			}
			break
		}
		case 'gap':
			allowed(['type', 'at'])
			validateUtcTimestamp(entry.at, `${path}/at`, v)
			break
		default:
			v.issue('history.invalid_open_entry', `${path}/type`, 'An open-autosave entry type is begin, event or gap.')
	}
	return v.diagnostics
}

function decodeVersion(bytes: Uint8Array, id: string): Readonly<{ ok: true; value: HostVersionRecord } | { ok: false; diagnostics: readonly Diagnostic[] }> {
	let value: unknown
	try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
	catch {
		return { ok: false, diagnostics: [{ code: 'persistence.invalid_json', path: `/versions/${id}.json`, message: 'A version file is UTF-8 JSON.' }] }
	}
	const result = validateHostVersionRecord(value)
	if (!result.ok) return { ok: false, diagnostics: result.diagnostics }
	if (!isRecord(value) || value.id !== id)
		return { ok: false, diagnostics: [{ code: 'identity.filename_id_mismatch', path: '/id', message: 'A version file is named by its record id.' }] }
	return { ok: true, value: result.value }
}

function versionBytes(record: HostVersionRecord): Buffer {
	const result = validateHostVersionRecord(record)
	if (!result.ok)
		throw new HostHistoryError('history.record_invalid', 'Refusing to write an invalid host version record.', { diagnostics: result.diagnostics })
	return canonicalJsonBytes(record, 'host version record')
}


export function blobDigest(bytes: Uint8Array): string {
	return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/**
 * Writes all of `bytes` at `position`. A short write is not success, so it keeps writing the rest;
 * a write that makes no progress fails with `history.write_failed` instead of retrying forever.
 */
export async function writeFullyAt(handle: Pick<fs.FileHandle, 'write'>, bytes: Uint8Array, position: number): Promise<void> {
	for (let offset = 0; offset < bytes.length;) {
		const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset)
		if (bytesWritten <= 0)
			throw new HostHistoryError('history.write_failed', `A write made no progress after ${offset} of ${bytes.length} bytes.`)
		offset += bytesWritten
	}
}

async function trimPartialLastLine(handle: fs.FileHandle): Promise<void> {
	const { size } = await handle.stat()
	if (size === 0) return
	const last = Buffer.alloc(1)
	await handle.read(last, 0, 1, size - 1)
	if (last[0] === NEWLINE) return
	const contents = Buffer.alloc(size)
	await handle.read(contents, 0, size, 0)
	await handle.truncate(contents.lastIndexOf(NEWLINE) + 1)
	await handle.sync()
}

async function replaceWithoutFault(target: string, bytes: Uint8Array): Promise<void> {
	const temporary = join(dirname(target), `.${basename(target)}.rollback-${randomBytes(6).toString('hex')}.tmp`)
	try {
		const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600)
		try {
			await handle.writeFile(bytes)
			await handle.sync()
		}
		finally {
			await handle.close()
		}
		await fs.rename(temporary, target)
	}
	finally {
		await fs.rm(temporary, { force: true }).catch(() => undefined)
	}
}

function noFollow(): number {
	return constants.O_NOFOLLOW ?? 0
}

const unsafe = (path: string, detail: string) => new HostHistoryError('history.store_unsafe', `Refusing the host history store at ${path}: ${detail}.`)

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
	try {
		return await fs.lstat(path)
	}
	catch (error) {
		if (isNotFound(error)) return undefined
		throw error
	}
}

/** The roster's directory rule: 0700, never a symbolic link, never group- or other-writable. */
async function ensurePrivateDirectory(path: string, create: boolean): Promise<boolean> {
	let stats = await lstatOrUndefined(path)
	if (!stats) {
		if (!create) return false
		try {
			await fs.mkdir(path, { mode: 0o700 })
			await fs.chmod(path, 0o700)
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		}
		stats = await fs.lstat(path)
	}
	if (stats.isSymbolicLink()) throw unsafe(path, 'it is a symbolic link')
	if (!stats.isDirectory()) throw unsafe(path, 'it is not a directory')
	if (process.platform !== 'win32' && (stats.mode & 0o022) !== 0) throw unsafe(path, 'it is writable by group or others (expected 0700)')
	return true
}

/** The bytes of a private file, or `undefined` when it is absent or disappears before it is read. */
async function readPrivateFileIfPresent(path: string): Promise<Buffer | undefined> {
	if (!await checkPrivateFile(path)) return undefined
	try {
		return await fs.readFile(path)
	}
	catch (error) {
		if (isNotFound(error)) return undefined
		throw error
	}
}

/** The roster's file rule: a regular 0600 file, never a symbolic link. Returns `undefined` when absent. */
async function checkPrivateFile(path: string): Promise<Stats | undefined> {
	const stats = await lstatOrUndefined(path)
	if (!stats) return undefined
	if (stats.isSymbolicLink()) throw unsafe(path, 'it is a symbolic link')
	if (!stats.isFile()) throw unsafe(path, 'it is not a regular file')
	if (process.platform !== 'win32' && (stats.mode & 0o022) !== 0) throw unsafe(path, 'it is writable by group or others (expected 0600)')
	return stats
}

async function syncDirectory(path: string): Promise<void> {
	let handle: fs.FileHandle | undefined
	try {
		handle = await fs.open(path, constants.O_RDONLY)
		await handle.sync()
	}
	catch { /* directory fsync is best effort on some platforms */ }
	finally { await handle?.close() }
}

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}
