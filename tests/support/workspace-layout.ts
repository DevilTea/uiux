import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { LEGACY_LAYOUT, type WorkspaceLayout } from '../../src/persistence/paths'
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from '../../src/product/workspace-schema'

/**
 * Test helpers that place Workspace files through the layout seam (`src/persistence/paths.ts`)
 * instead of hard-coding `.uiux/` paths, so test Workspaces follow the layout the product uses.
 * Each helper takes an optional layout; it defaults to the layout of a current-schema Workspace.
 */
export const CURRENT_TEST_LAYOUT: WorkspaceLayout = LEGACY_LAYOUT

function absolute(root: string, relativePath: string): string {
	return join(root, ...relativePath.split('/'))
}

/** The absolute path of the Workspace manifest. */
export function manifestPath(root: string, layout: WorkspaceLayout = CURRENT_TEST_LAYOUT): string {
	return absolute(root, layout.manifestPath)
}

/** The absolute path of the directory that holds the manifest and the runtime files. */
export function metadataPath(root: string, layout: WorkspaceLayout = CURRENT_TEST_LAYOUT): string {
	return absolute(root, layout.metadataDir)
}

/** The absolute path of one stored artifact (`sha256:<hex>`). */
export function artifactPath(root: string, identity: string, layout: WorkspaceLayout = CURRENT_TEST_LAYOUT): string {
	return absolute(root, layout.artifactRelativePath(identity))
}

/** The absolute path of the artifact store's `sha256/` shard directory. */
export function artifactShardsPath(root: string, layout: WorkspaceLayout = CURRENT_TEST_LAYOUT): string {
	return absolute(root, `${layout.artifactsDir}/sha256`)
}

/** The absolute path of the Checkpoints directory. */
export function checkpointsPath(root: string, layout: WorkspaceLayout = CURRENT_TEST_LAYOUT): string {
	return absolute(root, layout.checkpointsDir)
}

/** The absolute path of the persistence transaction directory. */
export function transactionsPath(root: string, layout: WorkspaceLayout = CURRENT_TEST_LAYOUT): string {
	return absolute(root, layout.transactionsDir)
}

/**
 * Writes the manifest, creating its directory. A string or bytes are written as given; any other
 * value is written as pretty-printed JSON with a trailing newline. Resolves to the absolute path.
 */
export async function writeManifest(root: string, manifest: unknown, layout: WorkspaceLayout = CURRENT_TEST_LAYOUT): Promise<string> {
	const path = manifestPath(root, layout)
	await mkdir(dirname(path), { recursive: true })
	const content = typeof manifest === 'string' || manifest instanceof Uint8Array ? manifest : `${JSON.stringify(manifest, null, 2)}\n`
	await writeFile(path, content)
	return path
}

/** A minimal current-schema manifest, with `overrides` merged over it. */
export function currentManifest(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
	return { schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {}, ...overrides }
}
