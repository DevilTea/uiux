import { lstat } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { ArtifactGcRefusal, ArtifactGcSweepError, collectArtifactGarbage, type ArtifactGcBlob } from '../persistence/artifact-gc'
import { FileNativePersistence } from '../persistence/file-native'
import { resolveWorkspacePath } from '../persistence/paths'
import type { WorkspaceSchemaPolicy } from '../persistence/schema-policy'
import { selectWorkspace } from '../persistence/workspace-selection'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../product/workspace-schema'
import { assertHomeOutsideWorkspace, hostHistoryPaths, resolveUiuxHome, workspaceRealRoot } from '../server/access/store'
import { writeStderrLine, writeStdoutLine } from './output'

export const ARTIFACTS_USAGE = 'artifacts gc [--workspace <dir>] [--dry-run]'

export type ArtifactsCommandOptions = Readonly<{
	/** The arguments after `artifacts`. */
	argv: readonly string[]
	cwd?: string
	stdout?: (line: string) => void
	stderr?: (line: string) => void
	/** Test seam: the Workspace schema policy of the entry check (UIUX's own by default). */
	schemaPolicy?: WorkspaceSchemaPolicy
	/** `$UIUX_HOME`, whose host history of the Workspace holds roots; `resolveUiuxHome()` by default. */
	home?: string
}>

/**
 * `uiux artifacts gc [--workspace <dir>] [--dry-run]` (Clauses 01a14e30-30de-70c3-888f-63e8982353d7
 * and 01a14e30-314b-7ee5-b85e-c8a926013beb): artifact cleanup of the selected Workspace
 * (`collectArtifactGarbage`). It prints each deleted blob's `sha256:` identity, then their count and
 * total bytes; `--dry-run` prints the same and deletes nothing.
 *
 * Returns the exit code (Clause 01a1144e-56d6-7b81-a611-25b8ef853abb): 0 on success, 1 when refused
 * (a Workspace a running server holds, a root it cannot read) or failed, and 2 for invalid usage or
 * an unusable Workspace root, which the entry check of Clause 01a126c7-7c2a-7bb7-b4db-c86fa04ac9e9
 * refuses before any lock, server hold, recovery, read or write.
 */
export async function runArtifactsCommand(options: ArtifactsCommandOptions): Promise<number> {
	const out = options.stdout ?? writeStdoutLine
	const err = options.stderr ?? writeStderrLine
	const cwd = options.cwd ?? process.cwd()
	const schemaPolicy = options.schemaPolicy ?? PRODUCT_WORKSPACE_SCHEMA_POLICY
	const usage = (message: string): number => {
		err(`uiux: ${message}`)
		err(`Usage: uiux ${ARTIFACTS_USAGE}`)
		return 2
	}

	const [subcommand, ...args] = options.argv
	if (subcommand !== 'gc') return usage(subcommand === undefined ? 'artifacts takes gc.' : `unknown artifacts command: ${subcommand}.`)
	let values: { workspace?: string; 'dry-run'?: boolean }
	try {
		values = parseArgs({ args: [...args], options: { 'workspace': { type: 'string' }, 'dry-run': { type: 'boolean' } }, allowPositionals: false, strict: true }).values
	}
	catch (error) {
		return usage(error instanceof Error ? error.message : String(error))
	}
	if (values.workspace === '') return usage('--workspace needs a directory.')
	const dryRun = values['dry-run'] === true

	const selection = selectWorkspace({ ...(values.workspace === undefined ? {} : { workspace: values.workspace }), cwd }, schemaPolicy)
	if (!selection.ok) {
		err(`uiux: ${selection.message}`)
		return 2
	}
	const manifest = await lstat(resolveWorkspacePath(selection.root, selection.layout.manifestPath)).catch(() => undefined)
	if (!manifest?.isFile()) {
		err(`uiux: ${selection.root} is not an initialized UIUX Workspace (no ${selection.layout.manifestPath}). Run uiux init first.`)
		return 2
	}

	const persistence = new FileNativePersistence({ root: selection.root, schemaPolicy, layout: selection.layout })
	const home = options.home ?? resolveUiuxHome()
	const line = (blob: ArtifactGcBlob) => out(blob.identity)
	const summary = (count: number, bytes: number) => `${count} blob${count === 1 ? '' : 's'}, ${bytes} byte${bytes === 1 ? '' : 's'}`
	try {
		// The host history of this Workspace on this host (Clause 01a11a5e-1e65-7deb-a89e-6ad021248fe0) holds roots.
		const realRoot = workspaceRealRoot(selection.root)
		try { assertHomeOutsideWorkspace(home, realRoot) }
		catch (error) {
			throw new ArtifactGcRefusal(`${error instanceof Error ? error.message : String(error)} Nothing was deleted.`)
		}
		const result = await collectArtifactGarbage(persistence, { dryRun, hostHistory: hostHistoryPaths(home, realRoot), onDeleted: line })
		if (dryRun) {
			for (const blob of result.blobs) line(blob)
			out(`Would delete ${summary(result.blobs.length, result.totalBytes)} (--dry-run: nothing was deleted).`)
		}
		else {
			out(`Deleted ${summary(result.blobs.length, result.totalBytes)}.`)
		}
		return 0
	}
	catch (error) {
		if (error instanceof ArtifactGcRefusal) {
			err(`uiux: ${error.message}`)
			return 1
		}
		if (error instanceof ArtifactGcSweepError) {
			const bytes = error.deleted.reduce((sum, blob) => sum + blob.bytes, 0)
			out(`Deleted ${summary(error.deleted.length, bytes)} before failing.`)
			err(`uiux: artifacts gc failed: ${error.message}`)
			return 1
		}
		err(`uiux: artifacts gc failed: ${error instanceof Error ? error.message : String(error)}`)
		return 1
	}
}
