import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { createMigrationHistoryRecorder, type MigrationCheckpointReport } from '../application/services/history-recorder'
import { migrationCheckpointName } from '../domain/history/constants'
import { FileNativePersistence, type PersistenceFaultHook, type WorkspaceRelocation } from '../persistence/file-native'
import { CheckpointHostBlobsError } from '../persistence/history/snapshot-checkpoint'
import { PersistenceError } from '../persistence/errors'
import { layoutForSchemaVersion } from '../persistence/paths'
import type { WorkspaceSchemaPolicy } from '../persistence/schema-policy'
import { readActiveServerHold, type ServerHold } from '../persistence/server-hold'
import { checkWorkspaceSelection, selectWorkspace } from '../persistence/workspace-selection'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY, WORKSPACE_GITIGNORE_RULES } from '../product/workspace-schema'
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

/** A UIUX server started serving the Workspace after the first check; no step ran. */
class ServedWorkspaceError extends Error {
	constructor(readonly hold: ServerHold) {
		super(`a UIUX server (pid ${hold.pid} on ${hold.hostname}) is serving this Workspace`)
		this.name = 'ServedWorkspaceError'
	}
}

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
 * `uiux migrate [--workspace <dir>] [--dry-run]` on a selected root: the only entrypoint that applies the product
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
 * A run that includes `uiux.v4-to-v5` moves the Workspace root into the selected directory's
 * `.uiux/`. Its refusals are checked before anything, the Checkpoint included, is written (Rule
 * 01a11bb1-9658-7f9e-972e-bd09136a5735, Clause 01a12626-e5c9-7753-8019-cdf82a5410ce); its host
 * versions stay in the selected (old) root's host history (Rule 01a12626-5a0c-7c1a-942f-666101981e29),
 * and it prints the new root, the `uiux access copy` command and the suggested `.gitignore` rules.
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
	const selection = checkWorkspaceSelection(root, schemaPolicy)
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
					// Under the migration's lock: a server that started since the check above is refused too.
					const late = await readActiveServerHold(root, persistence.layout)
					if (late) throw new ServedWorkspaceError(late)
					try {
						checkpoint = await history.beforeMigrationUnlocked(toVersion)
					}
					catch (error) {
						throw new PreMigrationHistoryError(error)
					}
				},
				async afterCommit(committed) {
					// The migration is committed: a failure here is reported, never turned into a failed migration.
					try {
						// After `uiux.v4-to-v5` the version is taken in the new root, with its layout, and still
						// recorded in the old root's host history (Rule 01a12626-5a0c-7c1a-942f-666101981e29).
						const migrated = committed.relocation
							? new FileNativePersistence({ root: committed.relocation.root, schemaPolicy, layout: layoutForSchemaVersion(committed.version) })
							: undefined
						systemVersion = await history.afterMigrationUnlocked(migrated)
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
		if (result.relocation) {
			out(`  moved (${result.relocation.moved.length}):`)
			for (const directory of result.relocation.moved) out(`    ${directory}/ -> ${result.relocation.metadataDir}/${directory}/`)
		}
		out(`  changedFiles (${result.changedFiles.length}):`)
		for (const file of result.changedFiles) out(`    ${file}`)
		if (options.dryRun) {
			if (result.relocation) out(`  new Workspace root (after a real run): ${result.relocation.root}`)
			if (hold) out(`  note: a UIUX server (pid ${hold.pid}) is serving this Workspace; stop it before the real run.`)
		}
		else {
			out(`  manifest revision: ${result.revision}`)
			if (checkpoint) printHistory(out, checkpoint, result.version)
			if (systemVersion) out(`  system version: ${systemVersion}`)
			if (systemVersionError !== undefined)
				err(`uiux: warning: the migration is complete, but its system version could not be recorded (${message(systemVersionError)}); the next server start records its changes as changes outside UIUX.`)
			if (result.relocation) printRelocation(out, root, result.relocation)
		}
		return 0
	}
	catch (error) {
		if (error instanceof ServedWorkspaceError) {
			err(`uiux: refusing to migrate ${root}: ${error.message} (started ${error.hold.startedAt}). Stop that server, then run uiux migrate again.`)
			return 1
		}
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

export type SelectedMigrateCommandOptions = Omit<MigrateCommandOptions, 'workspaceRoot'> & Readonly<{
	/** `--workspace <dir>` as given; omitted, the Workspace is discovered from `cwd`. */
	workspace?: string
	cwd: string
}>

/**
 * `uiux migrate [--workspace <dir>] [--dry-run]`: selects the Workspace (`selectWorkspace`: the
 * given directory, or discovery, which maps a found old-layout `.uiux/` to its parent, Clauses
 * 01a1144e-5584-7101-98c0-dc3cbadbacdf, 01a11bb1-9847-751f-a1ba-943ad111a02a and
 * 01a11bb1-98a9-7881-8fa0-ee1e355a3a9a), then runs `runMigrateCommand` on it.
 */
export async function runSelectedMigrateCommand(options: SelectedMigrateCommandOptions): Promise<number> {
	const { workspace, cwd, ...rest } = options
	const selection = selectWorkspace({ ...(workspace === undefined ? {} : { workspace }), cwd }, options.schemaPolicy ?? PRODUCT_WORKSPACE_SCHEMA_POLICY)
	if (!selection.ok) {
		(options.stderr ?? (line => console.error(line)))(`uiux: ${selection.message}`)
		return 2
	}
	return runMigrateCommand({ ...rest, workspaceRoot: selection.root })
}

function printHistory(out: (line: string) => void, report: MigrationCheckpointReport, version: number): void {
	if (report.quarantined) out(`  history: moved a corrupt open autosave journal aside as ${report.quarantined}`)
	if (report.boundary.autosave) out(`  history: closed the leftover autosave ${report.boundary.autosave}`)
	if (report.boundary.external) out(`  history: recorded changes outside UIUX as ${report.boundary.external}`)
	out(`  pre-migration Checkpoint: ${report.checkpoint} (${migrationCheckpointName(version)})`)
}

/**
 * After `uiux.v4-to-v5`: the new Workspace root, the `uiux access copy` command that carries the
 * roster and the host history over to it (Clause 01a1144e-5605-722c-a662-2b483ddaad73), and the
 * suggested `.gitignore` rules, which migrate never writes (Clause 01a12626-e8fe-7354-aa20-31dd8491f841).
 */
function printRelocation(out: (line: string) => void, oldRoot: string, relocation: WorkspaceRelocation): void {
	out(`  new Workspace root: ${relocation.root}`)
	out('  Next, before the first uiux dev there, carry the roster and the host history over:')
	out(`    uiux access copy --from ${shellQuote(oldRoot)} --workspace ${shellQuote(relocation.root)}`)
	out(`  Suggested .gitignore rules for ${relocation.root} (uiux migrate writes no .gitignore):`)
	for (const rule of WORKSPACE_GITIGNORE_RULES) out(`    ${rule}`)
}

/** A path as one POSIX shell word: unchanged when it holds only safe characters, single-quoted otherwise. */
function shellQuote(path: string): string {
	return /^[\w@%+=:,./-]+$/u.test(path) ? path : `'${path.replaceAll('\'', '\'\\\'\'')}'`
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
