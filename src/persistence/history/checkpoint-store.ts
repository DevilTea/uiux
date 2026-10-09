import { validateCheckpointRecord, type CheckpointRecord } from '../../domain/history/schema'
import { isFullUuid, isRecord, type Diagnostic } from '../../domain/validation'
import { PersistenceError } from '../errors'
import { canonicalJsonBytes, type FileNativePersistence } from '../file-native'
import { artifactRelativePath, LEGACY_LAYOUT, type WorkspaceLayout } from '../paths'
import { blobDigest, type InvalidHistoryFile } from './host-store'
import { compareVersionOrder } from './order'
import { referencedDigests } from './snapshot'

export type CheckpointListing = Readonly<{
	/** Valid checkpoints, oldest first by `at`, then `id`. */
	records: readonly CheckpointRecord[]
	/** Files under the checkpoints directory that are not a valid checkpoint record. */
	invalid: readonly InvalidHistoryFile[]
}>

const CHECKPOINT_FILE = /^(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/iu

/**
 * Checkpoints stored inside the Workspace (Rule 01a11a5e-04e2-71fe-8cd7-a4e26f0ff560, Clause
 * 01a11a5e-1e0e-7539-b925-c54dcb1afb55): one canonical JSON file per checkpoint at the layout's
 * `checkpointRelativePath(id)`, written atomically and never replaced, with every file blob it
 * names stored first in the derived-artifact store (checkpoint creation is one of its producers,
 * Rule 01a115cd-c16d-7dc8-a770-b6455ab80409).
 *
 * The `*Unlocked` methods run while the caller holds the exclusive persistence lock and has
 * decided whether the Workspace state allows the write; `create` takes the lock itself and
 * refuses unless the Workspace is writable.
 */
export class CheckpointStore {
	constructor(
		private readonly persistence: FileNativePersistence,
		private readonly layout: WorkspaceLayout = LEGACY_LAYOUT,
	) {}

	async create(record: CheckpointRecord, blobs: ReadonlyMap<string, Uint8Array>): Promise<void> {
		await this.persistence.withLock(async () => {
			await this.persistence.assertWritableUnlocked()
			await this.createUnlocked(record, blobs)
		})
	}

	/**
	 * Stores the blobs every file of `record` names, then writes the record. A digest without bytes
	 * in `blobs` must already be in the artifact store. An existing checkpoint id is refused.
	 */
	async createUnlocked(record: CheckpointRecord, blobs: ReadonlyMap<string, Uint8Array>): Promise<void> {
		const validation = validateCheckpointRecord(record)
		if (!validation.ok)
			throw new PersistenceError('persistence.invalid_resource', 'Refusing to write an invalid checkpoint record.', { diagnostics: validation.diagnostics })
		const relativePath = this.layout.checkpointRelativePath(record.id)
		if (await this.persistence.readOptionalBytesUnlocked(relativePath))
			throw new PersistenceError('persistence.resource_exists', `Checkpoint ${record.id} already exists.`)
		for (const digest of referencedDigests(record.resources)) {
			const bytes = blobs.get(digest)
			if (bytes) {
				if (blobDigest(bytes) !== digest)
					throw new PersistenceError('persistence.artifact_corrupt', `Checkpoint blob bytes do not match ${digest}.`)
				await this.persistence.artifacts.putUnlocked(bytes)
			}
			else if (!await this.persistence.readOptionalBytesUnlocked(artifactRelativePath(digest))) {
				throw new PersistenceError('persistence.resource_not_found', `Checkpoint ${record.id} names blob ${digest}, which is neither supplied nor stored.`)
			}
		}
		if (!await this.persistence.atomicCreateUnlocked(relativePath, canonicalJsonBytes(record, 'checkpoint record')))
			throw new PersistenceError('persistence.resource_exists', `Checkpoint ${record.id} already exists.`)
	}

	async read(id: string): Promise<CheckpointRecord | undefined> {
		return this.persistence.withReadLock(async () => this.readUnlocked(id))
	}

	async readUnlocked(id: string): Promise<CheckpointRecord | undefined> {
		const relativePath = this.layout.checkpointRelativePath(id)
		const bytes = await this.persistence.readOptionalBytesUnlocked(relativePath)
		if (!bytes) return undefined
		const decoded = decodeCheckpoint(bytes, id, relativePath)
		if (!decoded.ok)
			throw new PersistenceError('persistence.invalid_resource', `Checkpoint ${id} is not a valid checkpoint record.`, { diagnostics: decoded.diagnostics })
		return decoded.value
	}

	async list(): Promise<CheckpointListing> {
		return this.persistence.withReadLock(async () => this.listUnlocked())
	}

	async listUnlocked(): Promise<CheckpointListing> {
		const directory = this.layout.checkpointsDir
		const entries = await this.persistence.listDirectoryUnlocked(directory)
		if (!entries) return { records: [], invalid: [] }
		const records: CheckpointRecord[] = []
		const invalid: InvalidHistoryFile[] = []
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue
			const relativePath = `${directory}/${entry.name}`
			const id = CHECKPOINT_FILE.exec(entry.name)?.groups?.id
			if (!id || !entry.isFile()) {
				invalid.push({ file: relativePath, diagnostics: [{ code: 'history.unexpected_file', path: `/${relativePath}`, message: 'Only regular <uuid>.json checkpoint files belong in the checkpoints directory.' }] })
				continue
			}
			const decoded = decodeCheckpoint(await this.persistence.readBytesUnlocked(relativePath), id, relativePath)
			if (decoded.ok) records.push(decoded.value)
			else invalid.push({ file: relativePath, diagnostics: decoded.diagnostics })
		}
		return { records: records.sort(compareVersionOrder), invalid }
	}
}

function decodeCheckpoint(bytes: Uint8Array, id: string, relativePath: string): Readonly<{ ok: true; value: CheckpointRecord } | { ok: false; diagnostics: readonly Diagnostic[] }> {
	let value: unknown
	try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
	catch {
		return { ok: false, diagnostics: [{ code: 'persistence.invalid_json', path: `/${relativePath}`, message: 'A checkpoint file is UTF-8 JSON.' }] }
	}
	const result = validateCheckpointRecord(value)
	if (!result.ok) return { ok: false, diagnostics: result.diagnostics }
	if (!isFullUuid(id) || !isRecord(value) || value.id !== id)
		return { ok: false, diagnostics: [{ code: 'identity.filename_id_mismatch', path: '/id', message: 'A checkpoint file is named by its record id.' }] }
	return { ok: true, value: result.value }
}

