import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import { createFormalCaptureService } from '../src/application/services/formal-capture'
import { canonicalJsonBytes, FileNativePersistence } from '../src/persistence/file-native'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { createCurrentWorkspace } from './support/workspace-layout'

/**
 * The Evidence list (issue #318) reads every artifact under ONE shared persistence lock. The first test
 * is the regression guard for the cost (one cross-process lock acquisition per listing, not one per
 * artifact); the others check the snapshot behavior, which the per-artifact locking also satisfied.
 */
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeWorkspace(): Promise<FileNativePersistence> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-evidence-list-')))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence)
	return persistence
}

function record(viewId: string, tag: string): FormalEvidenceRecord {
	return {
		schemaVersion: 1,
		kind: 'formal_capture',
		executionContext: { viewId, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' },
		coverage: { complete: true },
		provenance: {
			workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
			resources: [{ identity: { type: 'view', id: viewId }, revision: `r_${tag}` }],
			versions: { uiux: '0.1.0' },
		},
		artifactRefs: [`sha256:${'a'.repeat(64)}`],
		data: { format: 'png' },
	}
}

/** Stores a batch of Evidence records and a non-JSON blob in ONE exclusive lock section. */
async function writeBatch(persistence: FileNativePersistence, viewId: string, count: number): Promise<void> {
	await persistence.withLock(async () => {
		for (let i = 0; i < count; i++) await persistence.artifacts.putUnlocked(canonicalJsonBytes(record(viewId, `${viewId}-${i}`)))
		await persistence.artifacts.putUnlocked(new Uint8Array([0x89, 0x50, 0x4E, 0x47, ...Buffer.from(viewId)]))
	})
}

describe('Evidence list locking and snapshot', () => {
	it('acquires the cross-process lock once for a listing, whatever the number of artifacts', async () => {
		const persistence = await makeWorkspace()
		await writeBatch(persistence, 'v1', 12)
		const acquire = vi.spyOn(persistence as unknown as { acquireLock: (deadline: number) => Promise<() => Promise<void>> }, 'acquireLock')
		const service = createFormalCaptureService(persistence)

		expect(await service.listEvidence()).toHaveLength(12)
		expect(acquire).toHaveBeenCalledTimes(1)

		acquire.mockClear()
		const kept = await persistence.artifacts.readAllCandidateJson<{ kind?: string }, string>({ select: value => value.kind })
		expect(kept).toHaveLength(12)
		expect(acquire).toHaveBeenCalledTimes(1)
	})

	it('lists only formal captures (select filters inside the read), sorted by digest, skipping blobs', async () => {
		const persistence = await makeWorkspace()
		await writeBatch(persistence, 'v1', 3)
		const items = await createFormalCaptureService(persistence).listEvidence()
		expect(items).toHaveLength(3)
		expect(items.map(item => item.digest)).toEqual(items.map(item => item.digest).sort())
		expect(await createFormalCaptureService(persistence).listEvidence('other')).toEqual([])
	})

	it('does not see a batch written after the listing began, and does not deadlock', async () => {
		const persistence = await makeWorkspace()
		await writeBatch(persistence, 'v1', 3)
		const service = createFormalCaptureService(persistence)

		const listing = service.listEvidence()
		const writing = writeBatch(persistence, 'v2', 4)
		const during = await listing
		await writing

		expect(during.filter(item => item.record.executionContext.viewId === 'v2')).toHaveLength(0)
		expect(during).toHaveLength(3)
		expect(await service.listEvidence()).toHaveLength(7)
	})

	it('sees a batch written before the listing whole, never half', async () => {
		const persistence = await makeWorkspace()
		const service = createFormalCaptureService(persistence)

		const writing = writeBatch(persistence, 'v1', 4)
		const listing = service.listEvidence()
		await writing
		const seen = (await listing).length

		expect([0, 4]).toContain(seen)
		expect(seen).toBe(4)
	})
})
