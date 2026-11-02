import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createFormalCaptureService } from '../src/application/services/formal-capture'
import { evidenceRecordOfKinds } from '../src/application/services/evidence-selection'
import { readImpactEvidence } from '../src/application/services/impact-picture'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { canonicalJsonBytes } from '../src/domain/canonical-json'
import { CHECKS_RUN_SOURCES, MAX_CHECKS_RUN_MESSAGE_LENGTH } from '../src/domain/evidence/checks-run'
import { validateFormalEvidenceRecord } from '../src/domain/evidence/schema'
import { FileNativePersistence } from '../src/persistence/file-native'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { flowTraceRecord } from './support/evidence-record'
import { createCurrentWorkspace } from './support/workspace-layout'

// The full record validator wrapped in a spy, to count which artifacts reach it (issue #367).
vi.mock('../src/domain/evidence/schema', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/domain/evidence/schema')>()
	return { ...actual, validateFormalEvidenceRecord: vi.fn(actual.validateFormalEvidenceRecord) }
})

/**
 * Evidence scans compare the parsed `kind` with the wanted kinds before running the full record
 * validator (issue #367): a large `checks_run` or a blob is never validated by a scan that does not
 * want it, while the result of every scan stays what it was.
 */

const VIEW = '11111111-1111-4111-8111-111111111111'
const FLOW = '22222222-2222-4222-8222-222222222222'
const STEP = '33333333-3333-4333-8333-333333333333'
const roots: string[] = []
const validator = vi.mocked(validateFormalEvidenceRecord)

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function formalCapture(tag: string): Record<string, unknown> {
	return {
		schemaVersion: 1,
		kind: 'formal_capture',
		executionContext: { viewId: VIEW, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' },
		coverage: { complete: true },
		provenance: {
			workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
			resources: [{ identity: { type: 'view', id: VIEW }, revision: `r_${tag}` }],
			versions: { uiux: '0.1.0' },
		},
		artifactRefs: [`sha256:${'a'.repeat(64)}`],
		data: { format: 'png' },
	}
}

/** A Workspace holding a formal capture, an invalid one, a `flow_trace`, a PNG and `runs` large `checks_run` records. */
async function mixedStore(runs: number): Promise<Readonly<{ persistence: FileNativePersistence; capture: string; trace: string; checks: readonly string[] }>> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-evidence-kind-filter-')))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence)
	const app = createWorkspaceApplicationSession(persistence)
	const finding = (index: number) => ({
		source: 'validation' as const,
		code: 'view.unknown_widget_type',
		message: 'm'.repeat(MAX_CHECKS_RUN_MESSAGE_LENGTH - 8) + String(index).padStart(8, '0'),
		path: '/variants/compact/ir',
		resource: { kind: 'view' as const, key: VIEW, name: 'Home' },
		severity: 'error' as const,
		checkState: 'completed' as const,
	})
	const checks: string[] = []
	for (let index = 0; index < runs; index++) {
		const recorded = await app.recordChecksRun({
			ranAt: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(),
			sources: CHECKS_RUN_SOURCES.map(source => ({ source, state: 'completed' as const })),
			findings: Array.from({ length: 150 }, (_, i) => finding(index * 1000 + i)),
		})
		if (recorded.status !== 'recorded') throw new Error('The Run Checks record was not stored.')
		checks.push(recorded.evidenceDigest)
	}
	const capture = (await persistence.artifacts.put(canonicalJsonBytes(formalCapture('ok')))).identity
	// A formal capture that is not valid (no `coverage`): a wanted kind, so it is validated and dropped.
	const invalidCapture = { ...formalCapture('bad'), coverage: undefined }
	await persistence.artifacts.put(canonicalJsonBytes(invalidCapture))
	const trace = (await persistence.artifacts.put(canonicalJsonBytes(flowTraceRecord({ flowId: FLOW, flowRevision: 'r_1', stepId: STEP, viewId: VIEW }, `sha256:${'c'.repeat(64)}`)))).identity
	await persistence.artifacts.put(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]))
	return { persistence, capture, trace, checks }
}

describe('Evidence scans select by kind before validating', () => {
	it('lists the same items for the default scan and for ?kinds=, without validating unwanted kinds', async () => {
		const { persistence, capture, trace, checks } = await mixedStore(3)
		const service = createFormalCaptureService(persistence)

		validator.mockClear()
		expect((await service.listEvidence()).map(item => item.digest)).toEqual([capture])
		// Only the two `formal_capture` artifacts (one valid, one not) are validated: not the
		// `checks_run` records, the `flow_trace` or the PNG.
		expect(validator).toHaveBeenCalledTimes(2)
		for (const [value] of validator.mock.calls) expect((value as { kind: string }).kind).toBe('formal_capture')

		validator.mockClear()
		expect((await service.listEvidence(undefined, ['checks_run'])).map(item => item.digest).sort()).toEqual([...checks].sort())
		expect(validator).toHaveBeenCalledTimes(checks.length)

		expect((await service.listEvidence(undefined, ['formal_capture', 'flow_trace', 'checks_run'])).map(item => item.digest).sort()).toEqual([capture, trace, ...checks].sort())
	})

	it('keeps the checks_run retention result and the View filter', async () => {
		const { persistence, capture, checks } = await mixedStore(22)
		const service = createFormalCaptureService(persistence)

		// The newest 20 of 22 runs are listed, as the cleanup keeps them (the two oldest are not).
		const listed = await service.listEvidence(undefined, ['checks_run'])
		expect(listed.map(item => item.digest).sort()).toEqual(checks.slice(2).sort())
		expect((await service.listEvidence(VIEW)).map(item => item.digest)).toEqual([capture])
		expect(await service.listEvidence('other-view')).toEqual([])
	})

	it('still rejects an invalid record of a wanted kind', async () => {
		const { persistence, capture } = await mixedStore(1)
		const service = createFormalCaptureService(persistence)
		// An invalid `checks_run` (a finding with an unknown severity) is not listed when `checks_run` is wanted.
		await persistence.artifacts.put(canonicalJsonBytes({
			schemaVersion: 1,
			kind: 'checks_run',
			executionContext: { ranAt: '2026-11-02T00:00:00.000Z' },
			coverage: { complete: true },
			provenance: { workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, resources: [], versions: { uiux: '0.1.0' } },
			artifactRefs: [],
			data: { sources: [], findings: [{ severity: 'info' }] },
		}))

		expect((await service.listEvidence()).map(item => item.digest)).toEqual([capture])
		expect((await service.listEvidence(undefined, ['checks_run'])).map(item => item.record.kind)).toEqual(['checks_run'])
		expect(await readImpactEvidence(persistence)).toHaveLength(1)
	})

	it('reads the impact Evidence without validating unwanted kinds', async () => {
		const { persistence, capture } = await mixedStore(3)

		validator.mockClear()
		expect((await readImpactEvidence(persistence)).map(item => item.digest)).toEqual([capture])
		expect(validator).toHaveBeenCalledTimes(2)
	})
})

describe('evidenceRecordOfKinds', () => {
	it('does not call the validator for a value that is not an object of a wanted kind', () => {
		validator.mockClear()
		for (const value of [null, 7, 'formal_capture', [], [{ kind: 'formal_capture' }], {}, { kind: 3 }, { kind: 'checks_run' }])
			expect(evidenceRecordOfKinds(value, ['formal_capture'])).toBeUndefined()
		expect(validator).not.toHaveBeenCalled()
	})

	it('validates a value of a wanted kind and returns it only when valid', () => {
		validator.mockClear()
		const valid = formalCapture('ok')
		expect(evidenceRecordOfKinds(valid, ['formal_capture', 'flow_trace'])).toEqual(valid)
		expect(evidenceRecordOfKinds({ ...valid, id: 'x' }, ['formal_capture'])).toBeUndefined()
		expect(validator).toHaveBeenCalledTimes(2)
	})
})
