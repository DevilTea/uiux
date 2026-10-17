import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { WorkspaceManifest } from '../src/domain/workspace/schema'
import { FileNativePersistence } from '../src/persistence/file-native'
import {
	CURRENT_WORKSPACE_SCHEMA_VERSION,
	PRODUCT_WORKSPACE_SCHEMA_POLICY,
} from '../src/product/workspace-schema'
import { createCurrentWorkspace, manifestPath, writeManifest } from './support/workspace-layout'

const temporaryRoots: string[] = []

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('product Workspace schema authority', () => {
	it('defines the product format as version 6, the only version it recognizes, with no migration steps (Clause 01a1144e-534c, Rule 01a1144e-5079)', () => {
		expect(CURRENT_WORKSPACE_SCHEMA_VERSION).toBe(6)
		expect(PRODUCT_WORKSPACE_SCHEMA_POLICY.currentVersion).toBe(6)
		expect(PRODUCT_WORKSPACE_SCHEMA_POLICY.recognizedVersions).toEqual([6])
		expect(PRODUCT_WORKSPACE_SCHEMA_POLICY.steps).toEqual([])
	})

	it('treats the current schemaVersion as current through the real file-native persistence boundary', async () => {
		const root = await makeRoot()
		const persistence = new FileNativePersistence({
			root,
			schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY,
		})

		await createCurrentWorkspace(persistence, workspaceFixture(CURRENT_WORKSPACE_SCHEMA_VERSION))

		const inspected = await persistence.inspectWorkspace()
		expect(inspected.inspection).toMatchObject({
			state: 'current',
			version: CURRENT_WORKSPACE_SCHEMA_VERSION,
			targetVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
		})
		expect(JSON.parse(await readFile(manifestPath(root), 'utf8')).schemaVersion).toBe(CURRENT_WORKSPACE_SCHEMA_VERSION)
	})

	it('does not infer a newer opened Workspace version as the product current version', async () => {
		const root = await makeRoot()
		const future = workspaceFixture(CURRENT_WORKSPACE_SCHEMA_VERSION + 1)
		const originalBytes = JSON.stringify(future, null, 2) + '\n'
		await writeManifest(root, originalBytes)

		const persistence = new FileNativePersistence({
			root,
			schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY,
		})
		const inspected = await persistence.inspectWorkspace()

		expect(inspected.inspection).toMatchObject({
			state: 'unsupported',
			version: CURRENT_WORKSPACE_SCHEMA_VERSION + 1,
			targetVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
		})
		expect(inspected.inspection.diagnostics.some(item => item.code === 'workspace.schema_unsupported')).toBe(true)
		expect(await readFile(manifestPath(root), 'utf8')).toBe(originalBytes)
	})
})

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-product-workspace-schema-'))
	temporaryRoots.push(root)
	return root
}

function workspaceFixture(schemaVersion: number): WorkspaceManifest {
	return {
		schemaVersion,
		i18n: { defaultLocale: 'en-US' },
		adapters: [],
		viewports: {},
		themes: {},
	}
}
