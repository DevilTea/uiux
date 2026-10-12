import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { builtInAccessPresetsFile } from '../../src/domain/access-presets/schema'
import { emptyProductKit, type ProductKit } from '../../src/domain/product-kit/schema'
import type { WorkspaceAdapterSelection, WorkspaceManifest } from '../../src/domain/workspace/schema'
import type { FileNativePersistence } from '../../src/persistence/file-native'
import { V5_LAYOUT, type WorkspaceLayout } from '../../src/persistence/paths'
import { defineWorkspaceSchemaPolicy, type WorkspaceSchemaPolicy } from '../../src/persistence/schema-policy'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY, WORKSPACE_V4_TO_V5_STEP, WORKSPACE_V5_TO_V6_STEP } from '../../src/product/workspace-schema'

/**
 * Test helpers that place Workspace files through the layout seam (`src/persistence/paths.ts`)
 * instead of hard-coding `.uiux/` paths, so test Workspaces follow the layout the product uses.
 * Each helper takes an optional layout; it defaults to the layout of a current-schema Workspace.
 */
export const CURRENT_TEST_LAYOUT: WorkspaceLayout = V5_LAYOUT

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

/** A minimal current-schema manifest (no `adapters` from `schemaVersion` 5), with `overrides` merged over it. */
export function currentManifest(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
	return { schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, viewports: {}, themes: {}, ...overrides }
}

/** UIUX's own policy, which makes `schemaVersion` 5 current; the name predates the switch to 5. */
export const V5_TEST_SCHEMA_POLICY: WorkspaceSchemaPolicy = PRODUCT_WORKSPACE_SCHEMA_POLICY

/**
 * The policy of a UIUX build before `schemaVersion` 5 (current 4, versions 1 to 4, no
 * `uiux.v4-to-v5`), for tests that keep exercising the old layout on purpose.
 */
export const V4_TEST_SCHEMA_POLICY: WorkspaceSchemaPolicy = defineWorkspaceSchemaPolicy({
	currentVersion: 4,
	recognizedVersions: [1, 2, 3, 4],
	steps: PRODUCT_WORKSPACE_SCHEMA_POLICY.steps.filter(step => step !== WORKSPACE_V4_TO_V5_STEP && step !== WORKSPACE_V5_TO_V6_STEP),
})

/**
 * The policy of a UIUX build before `schemaVersion` 6 (current 5, versions 1 to 5, no
 * `uiux.v5-to-v6`), for tests that exercise a `schemaVersion` 5 Workspace as current.
 */
export const V5_ONLY_TEST_SCHEMA_POLICY: WorkspaceSchemaPolicy = defineWorkspaceSchemaPolicy({
	currentVersion: 5,
	recognizedVersions: [1, 2, 3, 4, 5],
	steps: PRODUCT_WORKSPACE_SCHEMA_POLICY.steps.filter(step => step !== WORKSPACE_V5_TO_V6_STEP),
})

/** A manifest as tests wrote it below `schemaVersion` 5: settings plus an optional `adapters` list. */
export type TestWorkspaceSettings = Readonly<Record<string, unknown> & { adapters?: readonly Readonly<{ moduleSpecifier: string; config?: unknown }>[] }>

/**
 * Splits a test's Workspace settings into the current-schema manifest and the Product Kit file: from
 * `schemaVersion` 5 the `adapters` list lives in `product-kit.json`, not in the manifest.
 */
export function currentWorkspaceFiles(settings: TestWorkspaceSettings = {}): Readonly<{ manifest: WorkspaceManifest; productKit: ProductKit }> {
	const { adapters, ...rest } = settings
	return {
		manifest: currentManifest({ ...rest, schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION }) as WorkspaceManifest,
		productKit: { ...emptyProductKit(), adapters: [...(adapters ?? [])] as WorkspaceAdapterSelection[] },
	}
}

/**
 * Creates a current-schema Workspace through persistence: the manifest, then the Product Kit file
 * holding `settings.adapters`, then the Access presets file holding the built-in presets. Resolves
 * to the manifest's revision.
 */
export async function createCurrentWorkspace(persistence: FileNativePersistence, settings: TestWorkspaceSettings = {}): Promise<string> {
	const { manifest, productKit } = currentWorkspaceFiles(settings)
	const revision = await persistence.workspace.create(manifest)
	await persistence.productKit.create(productKit)
	await persistence.accessPresets.create(builtInAccessPresetsFile())
	return revision
}

/**
 * Writes a current-schema Workspace's manifest, Product Kit file and Access presets file directly,
 * creating the root. Resolves to the manifest's absolute path.
 */
export async function writeCurrentWorkspace(root: string, settings: TestWorkspaceSettings = {}): Promise<string> {
	const { manifest, productKit } = currentWorkspaceFiles(settings)
	const path = await writeManifest(root, manifest, V5_LAYOUT)
	await writeFile(join(root, V5_LAYOUT.productKitPath!), `${JSON.stringify(productKit, null, 2)}\n`)
	await writeFile(join(root, V5_LAYOUT.accessPresetsPath!), `${JSON.stringify(builtInAccessPresetsFile(), null, 2)}\n`)
	return path
}

/** A minimal `schemaVersion` 5 manifest (no `adapters`), with `overrides` merged over it. */
export function v5Manifest(overrides: Readonly<Record<string, unknown>> = {}): WorkspaceManifest {
	return { schemaVersion: 5, i18n: { defaultLocale: 'en-US' }, viewports: {}, themes: {}, ...overrides } as WorkspaceManifest
}
