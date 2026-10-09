import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { WorkspaceManifest } from '../src/domain/workspace/schema'
import { FileNativePersistence } from '../src/persistence/file-native'
import { workspaceRelativePath } from '../src/persistence/paths'
import {
	CURRENT_WORKSPACE_SCHEMA_VERSION,
	PRODUCT_WORKSPACE_SCHEMA_POLICY,
} from '../src/product/workspace-schema'

const temporaryRoots: string[] = []

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('product Workspace schema authority', () => {
	it('defines the product format as version 4, recognizing versions 1 to 3 through the chained migration steps', () => {
		expect(CURRENT_WORKSPACE_SCHEMA_VERSION).toBe(4)
		expect(PRODUCT_WORKSPACE_SCHEMA_POLICY.currentVersion).toBe(4)
		expect(PRODUCT_WORKSPACE_SCHEMA_POLICY.recognizedVersions).toEqual([1, 2, 3, 4])
		expect(PRODUCT_WORKSPACE_SCHEMA_POLICY.steps.map(step => step.id)).toEqual(['uiux.v1-to-v2', 'uiux.v2-to-v3', 'uiux.v3-to-v4'])
	})

	it('treats the current schemaVersion as current through the real file-native persistence boundary', async () => {
		const root = await makeRoot()
		const persistence = new FileNativePersistence({
			root,
			schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY,
		})

		await persistence.workspace.create(workspaceFixture(CURRENT_WORKSPACE_SCHEMA_VERSION))

		const inspected = await persistence.inspectWorkspace()
		expect(inspected.inspection).toMatchObject({
			state: 'current',
			version: CURRENT_WORKSPACE_SCHEMA_VERSION,
			targetVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
		})
		expect(JSON.parse(await readFile(join(root, workspaceRelativePath()), 'utf8')).schemaVersion).toBe(CURRENT_WORKSPACE_SCHEMA_VERSION)
	})

	it('does not infer a newer opened Workspace version as the product current version', async () => {
		const root = await makeRoot()
		await mkdir(join(root, '.uiux'), { recursive: true })
		const future = workspaceFixture(CURRENT_WORKSPACE_SCHEMA_VERSION + 1)
		const originalBytes = JSON.stringify(future, null, 2) + '\n'
		await writeFile(join(root, workspaceRelativePath()), originalBytes)

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
		expect(await readFile(join(root, workspaceRelativePath()), 'utf8')).toBe(originalBytes)
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
