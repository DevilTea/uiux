import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createFormalCaptureService } from '../src/application/services/formal-capture'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { canonicalJsonBytes } from '../src/domain/canonical-json'
import { CHECKS_RUN_SOURCES } from '../src/domain/evidence/checks-run'
import { CHECKS_RUN_RETENTION } from '../src/persistence/artifact-gc'
import { FileNativePersistence } from '../src/persistence/file-native'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { flowTraceRecord, interactionReplayRecord } from './support/evidence-record'
import { createCurrentWorkspace } from './support/workspace-layout'

/**
 * The Evidence the "Submit for review" picker lists (issue #61; Rule 01a11544-55b0-…): the Evidence list
 * reads the formal captures by default, and exactly the requested kinds on request, as one narrow read
 * over the same artifacts. A record that is not valid Evidence of its own kind is never listed.
 */

const VIEW = '11111111-1111-4111-8111-111111111111'
const FLOW = '22222222-2222-4222-8222-222222222222'
const STEP = '33333333-3333-4333-8333-333333333333'
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('listing Evidence of requested kinds', () => {
	it('lists checks_run, flow_trace and interaction_replay records on request, and only formal captures by default', async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-evidence-kinds-')))
		roots.push(root)
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		await createCurrentWorkspace(persistence)
		const app = createWorkspaceApplicationSession(persistence)
		const checks = await app.recordChecksRun({ ranAt: '2026-10-26T08:30:00.000Z', sources: CHECKS_RUN_SOURCES.map(source => ({ source, state: 'completed' as const })), findings: [] })
		if (checks.status !== 'recorded') throw new Error('The Run Checks record was not stored.')
		const capture = `sha256:${'c'.repeat(64)}`
		const trace = (await persistence.artifacts.put(canonicalJsonBytes(flowTraceRecord({ flowId: FLOW, flowRevision: 'r_1', stepId: STEP, viewId: VIEW }, capture)))).identity
		const replay = (await persistence.artifacts.put(canonicalJsonBytes(interactionReplayRecord(VIEW, 'pass', capture)))).identity
		// Not valid Evidence of its kind: never listed, whatever kind it declares.
		await persistence.artifacts.put(canonicalJsonBytes({ ...interactionReplayRecord(VIEW), data: { steps: [] } }))
		const service = createFormalCaptureService(persistence)

		expect(await service.listEvidence()).toEqual([])
		const kinds = ['checks_run', 'flow_trace', 'interaction_replay']
		expect((await service.listEvidence(undefined, kinds)).map(item => [item.record.kind, item.digest]).sort()).toEqual([
			['checks_run', checks.evidenceDigest],
			['flow_trace', trace],
			['interaction_replay', replay],
		])
		expect((await service.listEvidence(undefined, ['checks_run'])).map(item => item.digest)).toEqual([checks.evidenceDigest])
		// A View filter narrows by the record's View: a run of checks names none, a replay names its View.
		expect((await service.listEvidence(VIEW, kinds)).map(item => item.record.kind)).toEqual(['interaction_replay'])
	})

	it('lists only the newest CHECKS_RUN_RETENTION Run Checks records, as the cleanup keeps them', async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-evidence-kinds-cap-')))
		roots.push(root)
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		await createCurrentWorkspace(persistence)
		const app = createWorkspaceApplicationSession(persistence)
		const digests: string[] = []
		for (let index = 0; index < CHECKS_RUN_RETENTION + 2; index++) {
			const ranAt = new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString()
			const recorded = await app.recordChecksRun({ ranAt, sources: CHECKS_RUN_SOURCES.map(source => ({ source, state: 'completed' as const })), findings: [] })
			if (recorded.status !== 'recorded') throw new Error('The Run Checks record was not stored.')
			digests.push(recorded.evidenceDigest)
		}
		const listed = await createFormalCaptureService(persistence).listEvidence(undefined, ['checks_run'])
		// The two oldest runs are not listed; the others are.
		expect(listed.map(item => item.digest).sort()).toEqual(digests.slice(2).sort())
	})
})
