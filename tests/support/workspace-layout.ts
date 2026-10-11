import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { emptyProductKit } from '../../src/domain/product-kit/schema'
import type { WorkspaceManifest } from '../../src/domain/workspace/schema'
import { canonicalJsonBytes } from '../../src/persistence/file-native'
import { LEGACY_LAYOUT, V5_LAYOUT, type WorkspaceLayout } from '../../src/persistence/paths'
import { defineWorkspaceSchemaPolicy, type WorkspaceMigrationStep, type WorkspaceSchemaPolicy, type WorkspaceSnapshot } from '../../src/persistence/schema-policy'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../../src/product/workspace-schema'

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

/**
 * A test-only stand-in for `uiux.v4-to-v5` on the logical snapshot (the shipped step and its
 * relocation belong to a later unit): the manifest moves from `.uiux/workspace.json` to
 * `workspace.json` without `adapters` at `schemaVersion` 5, and `product-kit.json` gets those
 * Adapters, `./.uiux/kit/<p>` rebased to `./<p>`, with every other member empty (Clause
 * 01a11bb1-8f5f-77ea-817b-46679c5a6475). The data files keep their logical paths.
 */
export const TEST_V4_TO_V5_STEP: WorkspaceMigrationStep = Object.freeze({
	id: 'test.v4-to-v5',
	fromVersion: 4,
	toVersion: 5,
	apply(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
		const next = new Map(snapshot)
		const bytes = next.get(LEGACY_LAYOUT.manifestPath)
		if (!bytes) throw new TypeError('test.v4-to-v5 requires the old-layout manifest.')
		const { adapters = [], ...manifest } = JSON.parse(new TextDecoder().decode(bytes)) as { adapters?: { moduleSpecifier: string }[] }
		next.delete(LEGACY_LAYOUT.manifestPath)
		next.set(V5_LAYOUT.manifestPath, canonicalJsonBytes({ ...manifest, schemaVersion: 5 }))
		const rebased = adapters.map(adapter => adapter.moduleSpecifier.startsWith('./.uiux/kit/') ? { ...adapter, moduleSpecifier: `./${adapter.moduleSpecifier.slice('./.uiux/kit/'.length)}` } : adapter)
		next.set(V5_LAYOUT.productKitPath!, canonicalJsonBytes({ ...emptyProductKit(), adapters: rebased }))
		return next
	},
})

/** The injected policy a dormant `schemaVersion` 5 Workspace is exercised under: current 5, versions 1 to 5. */
export const V5_TEST_SCHEMA_POLICY: WorkspaceSchemaPolicy = defineWorkspaceSchemaPolicy({
	currentVersion: 5,
	recognizedVersions: [1, 2, 3, 4, 5],
	steps: [...PRODUCT_WORKSPACE_SCHEMA_POLICY.steps, TEST_V4_TO_V5_STEP],
})

/** A minimal `schemaVersion` 5 manifest (no `adapters`), with `overrides` merged over it. */
export function v5Manifest(overrides: Readonly<Record<string, unknown>> = {}): WorkspaceManifest {
	return { schemaVersion: 5, i18n: { defaultLocale: 'en-US' }, viewports: {}, themes: {}, ...overrides } as WorkspaceManifest
}
