import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FlowResource } from '../src/domain/flows/schema'
import type { ViewResource } from '../src/domain/views/schema'
import { createFormalCaptureService } from '../src/application/services/formal-capture'
import { createHandoffExportService } from '../src/application/services/handoff-export'
import { FileNativePersistence, settledValue } from '../src/persistence/file-native'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { createCurrentWorkspace } from './support/workspace-layout'

/**
 * Issue #322: loops that read one resource per iteration took one cross-process lock acquisition per
 * resource. The reads of a kind now share ONE lock, so the number of acquisitions stays the same
 * whatever the number of Views, Flows or Locales. The count is observed on `acquireLock`, the way
 * tests/evidence-list-snapshot.test.ts does.
 */
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeWorkspace(): Promise<FileNativePersistence> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-batched-reads-')))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence)
	return persistence
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function view(id: string): ViewResource {
	return {
		id,
		name: `View ${id}`,
		feature: 'checkout',
		ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
		spec: { intent: 'Test', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	} as unknown as ViewResource
}

function flow(id: string, viewId: string): FlowResource {
	return { id, name: 'Flow', entryStepId: 'step-entry-0001', steps: { 'step-entry-0001': { target: { viewId }, transitions: [] } } } as unknown as FlowResource
}

async function populate(persistence: FileNativePersistence, views: number, flows: number): Promise<void> {
	for (let i = 1; i <= views; i++) await persistence.views.create(uuid(i), view(uuid(i)))
	for (let i = 1; i <= flows; i++) await persistence.flows.create(uuid(100 + i), flow(uuid(100 + i), uuid(1)))
}

function spyAcquire(persistence: FileNativePersistence) {
	return vi.spyOn(persistence as unknown as { acquireLock: (deadline: number) => Promise<() => Promise<void>> }, 'acquireLock')
}

describe('batched reads share one lock (issue #322)', () => {
	it('reads every View render input under one lock acquisition', async () => {
		const persistence = await makeWorkspace()
		await populate(persistence, 6, 0)
		const acquire = spyAcquire(persistence)
		const inputs = await createFormalCaptureService(persistence).viewRenderInputs()
		expect(inputs.map(input => input.key)).toEqual([1, 2, 3, 4, 5, 6].map(uuid))
		expect(acquire).toHaveBeenCalledTimes(1)
	})

	it('skips a View file with invalid JSON and keeps the other render inputs, as a per-View read did', async () => {
		const persistence = await makeWorkspace()
		await populate(persistence, 2, 0)
		await mkdir(join(persistence.root, 'views'), { recursive: true })
		await writeFile(join(persistence.root, 'views', `${uuid(3)}.view.json`), '{ not json')
		const acquire = spyAcquire(persistence)
		const inputs = await createFormalCaptureService(persistence).viewRenderInputs()
		expect(inputs.map(input => input.key)).toEqual([uuid(1), uuid(2)])
		expect(acquire).toHaveBeenCalledTimes(1)
	})

	it('reports each key of a batch with its own outcome and rethrows an error only where it is taken', async () => {
		const persistence = await makeWorkspace()
		await populate(persistence, 2, 0)
		await writeFile(join(persistence.root, 'views', `${uuid(3)}.view.json`), '{ not json')
		const acquire = spyAcquire(persistence)
		const reads = await persistence.views.readManyInspected([uuid(1), uuid(9), uuid(3), uuid(2)])
		expect(acquire).toHaveBeenCalledTimes(1)
		expect(settledValue(reads[0]!)?.resource.id).toBe(uuid(1))
		expect(settledValue(reads[1]!)).toBeUndefined()
		expect(reads[2]).toMatchObject({ ok: false })
		expect(() => settledValue(reads[2]!)).toThrow()
		expect(settledValue(reads[3]!)?.resource.id).toBe(uuid(2))
	})

	it('acquires a Handoff readiness assessment\'s locks independently of the number of Views and Flows', async () => {
		const small = await makeWorkspace()
		await populate(small, 1, 1)
		const large = await makeWorkspace()
		await populate(large, 6, 4)

		const count = async (persistence: FileNativePersistence) => {
			const acquire = spyAcquire(persistence)
			const result = await createHandoffExportService(persistence).assessReadiness({ roots: [{ type: 'workspace' }] })
			expect(result.status).not.toBe('blocked')
			return acquire.mock.calls.length
		}
		const smallCount = await count(small)
		expect(await count(large)).toBe(smallCount)
	})

	it('still rejects a Handoff assessment when a View file is not valid JSON', async () => {
		const persistence = await makeWorkspace()
		await populate(persistence, 1, 0)
		await writeFile(join(persistence.root, 'views', `${uuid(3)}.view.json`), '{ not json')
		await expect(createHandoffExportService(persistence).assessReadiness({ roots: [{ type: 'workspace' }] })).rejects.toMatchObject({ code: 'persistence.invalid_json' })
	})
})
