import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { createMigrationHistoryRecorder, type MigrationCheckpointReport } from '../application/services/history-recorder'
import { migrationCheckpointName } from '../domain/history/constants'
import { FileNativePersistence, type PersistenceFaultHook } from '../persistence/file-native'
import { CheckpointHostBlobsError } from '../persistence/history/snapshot-checkpoint'
import { PersistenceError } from '../persistence/errors'
import type { WorkspaceSchemaPolicy } from '../persistence/schema-policy'
import { readActiveServerHold } from '../persistence/server-hold'
import { checkWorkspaceSelection } from '../persistence/workspace-selection'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../product/workspace-schema'
import { resolveUiuxHome } from '../server/access/store'
import { createHistoryStoreFactory } from '../server/history-stores'

export type MigrateCommandOptions = Readonly<{
	workspaceRoot: string
	dryRun: boolean
	/** `$UIUX_HOME`, where host history lives; defaults to the environment's (`~/.uiux`). */
	home?: string
	stdout?: (line: string) => void
	stderr?: (line: string) => void
	/** Test seams: the schema policy and persistence fault injection. */
	schemaPolicy?: WorkspaceSchemaPolicy
	fault?: PersistenceFaultHook
}>

/** The pre-migration history could not be recorded; no step ran. */
class PreMigrationHistoryError extends Error {
	/** The pre-migration Checkpoint, when its record was written before the failure. */
	readonly checkpointId: string | undefined

	constructor(override readonly cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause))
		this.name = 'PreMigrationHistoryError'
		this.checkpointId = cause instanceof CheckpointHostBlobsError ? cause.checkpointId : undefined
	}
}

/**
 * `uiux migrate --workspace <dir> [--dry-run]`: the only entrypoint that applies the product
 * Workspace schema migration (CLI-only by decision; there is no MCP tool and no HTTP route).
 *
 * A real run that has steps to apply records history under the migration's lock, outside every
 * step (Rules 01a11a5e-0b23-7d4f-954a-26fcde4a8014 and 01a11a5e-0422-78fe-b28b-d877417932e9,
 * Clause 01a1144e-5605-722c-a662-2b483ddaad73): first it closes a leftover autosave and records
 * changes made outside UIUX, then writes the pre-migration system Checkpoint, and once the
 * migration committed it records the migration as a system version on the host. A failed migration
 * leaves the Checkpoint in place. A dry run, and a Workspace already at the current version, write
 * nothing, history included.
 *
 * Returns the process exit code: 0 on success (including "already current"), 1 when the
 * migration is refused or fails, 2 for an unusable Workspace root.
 */
export async function runMigrateCommand(options: MigrateCommandOptions): Promise<number> {
	const out = options.stdout ?? (line => console.log(line))
	const err = options.stderr ?? (line => console.error(line))
	const root = resolve(options.workspaceRoot)
	try {
		if (!(await stat(root)).isDirectory()) {
			err(`uiux: Workspace root is not a directory: ${root}`)
			return 2
		}
	}
	catch {
		err(`uiux: Workspace root does not exist: ${root}`)
		return 2
	}

	// The entry check runs before any lock, server hold, recovery, read or write; its layout is where
	// the server hold and every Workspace file are looked for.
	const schemaPolicy = options.schemaPolicy ?? PRODUCT_WORKSPACE_SCHEMA_POLICY
	const selection = checkWorkspaceSelection(root, schemaPolicy.currentVersion)
	if (!selection.ok) {
		err(`uiux: ${selection.message}`)
		return 2
	}
	const persistence = new FileNativePersistence({ root, schemaPolicy, layout: selection.layout, ...(options.fault ? { fault: options.fault } : {}) })
	const hold = await readActiveServerHold(root, persistence.layout)
	if (hold && !options.dryRun) {
		err(`uiux: refusing to migrate ${root}: a UIUX server (pid ${hold.pid} on ${hold.hostname}, started ${hold.startedAt}) is serving this Workspace. Stop that server, then run uiux migrate again.`)
		return 1
	}

	let checkpoint: MigrationCheckpointReport | undefined
	let systemVersion: string | undefined
	let systemVersionError: unknown
	try {
		let result
		if (options.dryRun) {
			result = await persistence.planWorkspaceMigration()
		}
		else {
			const home = options.home ?? resolveUiuxHome()
			// Opened only once a step is due, under the migration's lock: an already-current Workspace
			// touches no history.
			const stores = createHistoryStoreFactory({ workspaceRoot: root, persistence, home: () => home })
			const history = createMigrationHistoryRecorder({ persistence, stores: () => stores.open(), log: err })
			result = await persistence.migrateWorkspace({
				async beforeSteps({ toVersion }) {
					try {
						checkpoint = await history.beforeMigrationUnlocked(toVersion)
					}
					catch (error) {
						throw new PreMigrationHistoryError(error)
					}
				},
				async afterCommit() {
					// The migration is committed: a failure here is reported, never turned into a failed migration.
					try {
						systemVersion = await history.afterMigrationUnlocked()
					}
					catch (error) {
						systemVersionError = error
					}
				},
			})
		}
		if (result.steps.length === 0) {
			out(`UIUX Workspace ${root} is already at schemaVersion ${result.version}; nothing to migrate.`)
			return 0
		}
		out(options.dryRun ? `Migration plan for UIUX Workspace ${root} (dry run, nothing written)` : `Migrated UIUX Workspace ${root}`)
		out(`  schemaVersion: ${result.fromVersion} -> ${result.version}`)
		out(`  steps: ${result.steps.join(', ')}`)
		out(`  changedFiles (${result.changedFiles.length}):`)
		for (const file of result.changedFiles) out(`    ${file}`)
		if (options.dryRun) {
			if (hold) out(`  note: a UIUX server (pid ${hold.pid}) is serving this Workspace; stop it before the real run.`)
		}
		else {
			out(`  manifest revision: ${result.revision}`)
			if (checkpoint) printHistory(out, checkpoint, result.version)
			if (systemVersion) out(`  system version: ${systemVersion}`)
			if (systemVersionError !== undefined)
				err(`uiux: warning: the migration is complete, but its system version could not be recorded (${message(systemVersionError)}); the next server start records its changes as changes outside UIUX.`)
		}
		return 0
	}
	catch (error) {
		if (error instanceof PreMigrationHistoryError) {
			err(`uiux: refusing to migrate ${root}: the pre-migration history could not be recorded, so no step ran: ${error.message}`)
			if (error.checkpointId) err(`  The pre-migration Checkpoint ${error.checkpointId} was written and stays in the Workspace.`)
			return 1
		}
		if (error instanceof PersistenceError) {
			err(`uiux: migrate failed (${error.code}): ${error.message}`)
			for (const diagnostic of error.diagnostics) err(`  ${diagnostic.code} ${diagnostic.path || '/'}: ${diagnostic.message}`)
			if (error.cause instanceof Error) err(`  cause: ${error.cause.message}`)
			if (checkpoint) err(`  The pre-migration Checkpoint ${checkpoint.checkpoint} stays in the Workspace.`)
			return 1
		}
		throw error
	}
}

function printHistory(out: (line: string) => void, report: MigrationCheckpointReport, version: number): void {
	if (report.quarantined) out(`  history: moved a corrupt open autosave journal aside as ${report.quarantined}`)
	if (report.boundary.autosave) out(`  history: closed the leftover autosave ${report.boundary.autosave}`)
	if (report.boundary.external) out(`  history: recorded changes outside UIUX as ${report.boundary.external}`)
	out(`  pre-migration Checkpoint: ${report.checkpoint} (${migrationCheckpointName(version)})`)
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
