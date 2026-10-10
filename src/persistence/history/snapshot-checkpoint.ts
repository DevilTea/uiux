import { randomUUID } from 'node:crypto'

import type { HistorySource } from '../../domain/history/constants'
import { HISTORY_SCHEMA_VERSION } from '../../domain/history/constants'
import type { CheckpointRecord, HistoryActor } from '../../domain/history/schema'
import type { FileNativePersistence } from '../file-native'
import type { CheckpointStore } from './checkpoint-store'
import type { HostHistoryStore } from './host-store'
import { versionResourcesFromSnapshot } from './snapshot'

export type SnapshotCheckpointInput = Readonly<{
	persistence: FileNativePersistence
	checkpoints: CheckpointStore
	/**
	 * The host store, when the checkpoint's blobs must also be there: a recorder whose recorded state
	 * becomes this checkpoint later writes host versions naming the same blobs.
	 */
	host?: HostHistoryStore
	at: string
	actor: HistoryActor
	name: string
	note?: string
	source: HistorySource
}>

/**
 * Writes a Checkpoint of the current versioned files (Clauses 01a11a5e-1e0e-7539-b925-c54dcb1afb55
 * and 01a11a5e-2070-7c38-a62e-daae1fd8ac43): the resources scanned now, the Workspace schema version
 * the files are decoded under, and `parentCheckpoint` naming the latest Checkpoint already stored,
 * if any. The caller holds the exclusive persistence lock and has decided whether the Workspace
 * state allows the write (`uiux migrate` writes its Checkpoint while migration is required).
 */
export async function writeSnapshotCheckpointUnlocked(input: SnapshotCheckpointInput): Promise<CheckpointRecord> {
	const snapshot = versionResourcesFromSnapshot(await input.persistence.scanVersionedSnapshotUnlocked(), input.persistence.layout)
	const parentCheckpoint = (await input.checkpoints.listUnlocked()).records.at(-1)?.id
	const record: CheckpointRecord = {
		historySchemaVersion: HISTORY_SCHEMA_VERSION,
		id: randomUUID(),
		type: 'checkpoint',
		actor: input.actor,
		at: input.at,
		workspaceSchemaVersion: await input.persistence.readRecordSchemaVersionUnlocked(),
		resources: snapshot.resources,
		name: input.name,
		...(input.note !== undefined ? { note: input.note } : {}),
		source: input.source,
		...(parentCheckpoint ? { parentCheckpoint } : {}),
	}
	await input.checkpoints.createUnlocked(record, snapshot.blobs)
	if (input.host) {
		try {
			for (const bytes of snapshot.blobs.values()) await input.host.putBlob(bytes)
		}
		catch (cause) {
			throw new CheckpointHostBlobsError(record.id, cause)
		}
	}
	return record
}

/** The Checkpoint record was written, but copying its blobs to the host store failed. */
export class CheckpointHostBlobsError extends Error {
	constructor(readonly checkpointId: string, override readonly cause: unknown) {
		super(`Checkpoint ${checkpointId} was written, but its blobs could not be stored in host history: ${cause instanceof Error ? cause.message : String(cause)}`)
		this.name = 'CheckpointHostBlobsError'
	}
}
