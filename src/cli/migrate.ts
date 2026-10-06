import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { FileNativePersistence } from '../persistence/file-native'
import { PersistenceError } from '../persistence/errors'
import { readActiveServerHold } from '../persistence/server-hold'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../product/workspace-schema'

export type MigrateCommandOptions = Readonly<{
	workspaceRoot: string
	dryRun: boolean
	stdout?: (line: string) => void
	stderr?: (line: string) => void
}>

/**
 * `uiux migrate --workspace <dir> [--dry-run]`: the only entrypoint that applies the product
 * Workspace schema migration (CLI-only by decision; there is no MCP tool and no HTTP route).
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

	const hold = await readActiveServerHold(root)
	if (hold && !options.dryRun) {
		err(`uiux: refusing to migrate ${root}: a UIUX server (pid ${hold.pid} on ${hold.hostname}, started ${hold.startedAt}) is serving this Workspace. Stop that server, then run uiux migrate again.`)
		return 1
	}

	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	try {
		const result = options.dryRun ? await persistence.planWorkspaceMigration() : await persistence.migrateWorkspace()
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
		}
		return 0
	}
	catch (error) {
		if (error instanceof PersistenceError) {
			err(`uiux: migrate failed (${error.code}): ${error.message}`)
			for (const diagnostic of error.diagnostics) err(`  ${diagnostic.code} ${diagnostic.path || '/'}: ${diagnostic.message}`)
			if (error.cause instanceof Error) err(`  cause: ${error.cause.message}`)
			return 1
		}
		throw error
	}
}
