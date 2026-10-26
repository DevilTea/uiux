import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { canonicalJsonBytes } from '../src/domain/canonical-json'
import {
	checksRunCoverageAndData,
	CHECKS_RUN_SOURCES,
	MAX_CHECKS_RUN_BYTES,
	MAX_CHECKS_RUN_FINDINGS,
	MAX_CHECKS_RUN_MESSAGE_LENGTH,
	validateChecksRunInput,
	type ChecksRunInput,
} from '../src/domain/evidence/checks-run'
import { validateFormalEvidenceRecord } from '../src/domain/evidence/schema'
import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { recordChecksRunForHttp } from '../src/server/checks-http'
import { scoped, testMember, connectMcp } from './support/access'
import { createCurrentWorkspace } from './support/workspace-layout'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const RAN_AT = '2026-10-26T08:30:00.000Z'

function run(overrides: Partial<ChecksRunInput> = {}): ChecksRunInput {
	return {
		ranAt: RAN_AT,
		sources: CHECKS_RUN_SOURCES.map(source => ({ source, state: 'completed' as const })),
		findings: [
			{ source: 'validation', code: 'view.unknown_widget_type', message: 'Unknown Widget type.', path: '/variants/compact/ir', resource: { kind: 'view', key: VIEW_ID, name: 'Home' }, severity: 'error', checkState: 'completed', widgetId: 'w1', variantName: 'compact' },
			{ source: 'product-kit', code: '', message: 'A component declares neither props nor emits.', path: '/components/Card', resource: { kind: 'product-kit', key: 'Card', name: 'Card' }, severity: 'warning', checkState: 'completed' },
		],
		...overrides,
	}
}

function codes(input: unknown): string[] {
	const result = validateChecksRunInput(input)
	return result.ok ? [] : result.diagnostics.map(item => `${item.code} ${item.path}`)
}

describe('checks_run input (Clause 01a17670-d442-7068-8a08-c6e4ab9c09ae)', () => {
	it('accepts a run and derives the coverage of a record from its sources', () => {
		expect(validateChecksRunInput(run()).ok).toBe(true)
		expect(checksRunCoverageAndData(run()).coverage).toEqual({ complete: true, sources: { validation: 'completed', translation: 'completed', catalog: 'completed', 'product-kit': 'completed' } })
		const partial = run({ sources: CHECKS_RUN_SOURCES.map((source, index) => ({ source, state: index === 2 ? 'incomplete' as const : index === 3 ? 'failed' as const : 'completed' as const })) })
		expect(checksRunCoverageAndData(partial).coverage).toEqual({ complete: false, sources: { validation: 'completed', translation: 'completed', catalog: 'incomplete', 'product-kit': 'failed' } })
	})

	it('refuses an input that is not the closed shape, with a diagnostic for each fault', () => {
		expect(codes(undefined)).toEqual(['schema.expected_object '])
		expect(codes({ ...run(), extra: 1 })).toEqual(['schema.unknown_field /extra'])
		expect(codes({ ...run(), ranAt: '2026-10-26T08:30:00+08:00' })).toEqual(['time.invalid_rfc3339_utc /ranAt'])
		expect(codes({ ...run(), ranAt: '2026-02-31T08:30:00Z' })).toEqual(['time.invalid_rfc3339_utc /ranAt'])
		expect(codes({ ...run(), sources: run().sources.slice(0, 3) })).toEqual(['evidence.invalid_checks_run /sources'])
		expect(codes({ ...run(), sources: [...run().sources].reverse() }).every(item => item.startsWith('evidence.invalid_checks_run /sources/'))).toBe(true)
		expect(codes({ ...run(), sources: run().sources.map((entry, index) => index === 0 ? { ...entry, state: 'checking' } : entry) })).toEqual(['evidence.invalid_checks_run /sources/0/state'])
		const finding = run().findings[0]!
		expect(codes({ ...run(), findings: [{ ...finding, severity: 'info' }] })).toEqual(['evidence.invalid_checks_run /findings/0/severity'])
		expect(codes({ ...run(), findings: [{ ...finding, source: 'runtime' }] })).toEqual(['evidence.invalid_checks_run /findings/0/source'])
		expect(codes({ ...run(), findings: [{ ...finding, checkState: 'not_checked' }] })).toEqual(['evidence.invalid_checks_run /findings/0/checkState'])
		expect(codes({ ...run(), findings: [{ ...finding, resource: { kind: 'view', key: '', name: 'Home' } }] })).toEqual(['schema.empty_string /findings/0/resource/key'])
		expect(codes({ ...run(), findings: [{ ...finding, resource: { kind: 'page', key: 'a', name: 'Home' } }] })).toEqual(['evidence.invalid_checks_run /findings/0/resource/kind'])
		expect(codes({ ...run(), findings: [{ ...finding, widgetId: '' }] })).toEqual(['schema.empty_string /findings/0/widgetId'])
		expect(codes({ ...run(), findings: [{ ...finding, hint: 'x' }] })).toEqual(['schema.unknown_field /findings/0/hint'])
		expect(codes({ ...run(), findings: 'none' })).toEqual(['schema.expected_array /findings'])
	})

	it('bounds the number of findings, each string and the whole record', () => {
		const finding = run().findings[0]!
		expect(codes({ ...run(), findings: Array.from({ length: MAX_CHECKS_RUN_FINDINGS }, () => finding) })).toEqual([])
		expect(codes({ ...run(), findings: Array.from({ length: MAX_CHECKS_RUN_FINDINGS + 1 }, () => finding) })).toEqual(['evidence.invalid_checks_run /findings'])
		expect(codes({ ...run(), findings: [{ ...finding, message: 'm'.repeat(MAX_CHECKS_RUN_MESSAGE_LENGTH) }] })).toEqual([])
		expect(codes({ ...run(), findings: [{ ...finding, message: 'm'.repeat(MAX_CHECKS_RUN_MESSAGE_LENGTH + 1) }] })).toEqual(['evidence.invalid_checks_run /findings/0/message'])
		expect(codes({ ...run(), findings: [{ ...finding, code: 'c'.repeat(201) }] })).toEqual(['evidence.invalid_checks_run /findings/0/code'])
		expect(codes({ ...run(), findings: [{ ...finding, path: 'p'.repeat(1001) }] })).toEqual(['evidence.invalid_checks_run /findings/0/path'])
		expect(codes({ ...run(), findings: [{ ...finding, resource: { ...finding.resource, key: 'k'.repeat(513) } }] })).toEqual(['evidence.invalid_checks_run /findings/0/resource/key'])
		expect(codes({ ...run(), findings: [{ ...finding, resource: { ...finding.resource, name: 'n'.repeat(501) } }] })).toEqual(['evidence.invalid_checks_run /findings/0/resource/name'])
		expect(codes({ ...run(), findings: [{ ...finding, variantName: 'v'.repeat(201) }] })).toEqual(['evidence.invalid_checks_run /findings/0/variantName'])
	})

	it('refuses a record that is over its byte bound even when every member is within its own', async () => {
		const { app, persistence } = await seededSession()
		const wide = { ...run().findings[0]!, message: 'm'.repeat(MAX_CHECKS_RUN_MESSAGE_LENGTH), path: 'p'.repeat(1000), resource: { kind: 'view' as const, key: 'k'.repeat(512), name: 'n'.repeat(500) }, widgetId: 'w'.repeat(200), variantName: 'v'.repeat(200) }
		const before = await persistence.artifacts.listIdentities()
		const outcome = await app.recordChecksRun(run({ findings: Array.from({ length: MAX_CHECKS_RUN_FINDINGS }, () => wide) }))
		expect(outcome).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'evidence.invalid_checks_run', path: '' }] })
		expect(await persistence.artifacts.listIdentities()).toEqual(before)
		expect(MAX_CHECKS_RUN_BYTES).toBe(524_288)
	})
})

describe('checks_run record (formal Evidence record validation)', () => {
	async function record() {
		const { app } = await seededSession()
		const outcome = await app.recordChecksRun(run())
		if (outcome.status !== 'recorded') throw new Error('expected a recorded run')
		return outcome.evidence as unknown as Record<string, unknown>
	}

	it('validates the record the server writes, and not a record whose coverage disagrees with its data', async () => {
		const evidence = await record()
		expect(validateFormalEvidenceRecord(evidence).ok).toBe(true)
		const coverage = evidence.coverage as Record<string, unknown>
		const states = (evidence.data as { sources: unknown[] }).sources
		const messages = (changed: Record<string, unknown>) => {
			const result = validateFormalEvidenceRecord({ ...evidence, ...changed })
			return result.ok ? [] : result.diagnostics.map(item => `${item.code} ${item.path}`)
		}
		expect(messages({ coverage: { ...coverage, complete: false } })).toEqual(['evidence.checks_run_mismatch /coverage/complete'])
		expect(messages({ coverage: { ...coverage, sources: { ...(coverage.sources as object), catalog: 'failed' } } })).toEqual(['evidence.checks_run_mismatch /coverage/sources'])
		expect(messages({ schemaVersion: 2 })).toEqual(['evidence.invalid_checks_run /schemaVersion'])
		expect(messages({ executionContext: { ranAt: RAN_AT, locale: 'en-US' } })).toEqual(['schema.unknown_field /executionContext/locale'])
		expect(messages({ artifactRefs: [`sha256:${'a'.repeat(64)}`] })).toEqual(['evidence.invalid_checks_run /artifactRefs'])
		expect(messages({ evidenceRefs: [] })).toEqual(['evidence.invalid_checks_run /evidenceRefs'])
		expect(messages({ provenance: { ...(evidence.provenance as object), resources: [{ identity: { type: 'view', id: VIEW_ID }, revision: 'r_1' }] } })).toEqual(['evidence.invalid_checks_run /provenance/resources'])
		expect(messages({ data: { sources: states } })).toEqual(['schema.expected_array /data/findings'])
		expect(messages({ id: 'x' })).toEqual(['evidence.parallel_identity_forbidden /id'])
	})

	it('has the shape of the owner ruling: ranAt, coverage by source, the sources and findings, no artifacts', async () => {
		expect(await record()).toMatchObject({
			schemaVersion: 1,
			kind: 'checks_run',
			executionContext: { ranAt: RAN_AT },
			coverage: { complete: true, sources: { validation: 'completed', translation: 'completed', catalog: 'completed', 'product-kit': 'completed' } },
			artifactRefs: [],
			data: { sources: [{ source: 'validation', state: 'completed' }, { source: 'translation', state: 'completed' }, { source: 'catalog', state: 'completed' }, { source: 'product-kit', state: 'completed' }], findings: run().findings },
		})
	})
})

describe('record_checks_run and POST /api/checks/runs (Clause 01a17671-11bf-7711-887b-121a02602cf4)', () => {
	it('records the same result through the application, the HTTP helper and MCP, as one immutable record', async () => {
		const { app, persistence } = await seededSession()
		const owner = scoped(app)
		const before = await persistence.artifacts.listIdentities()
		const direct = await owner.recordChecksRun(run())
		if (direct.status !== 'recorded') throw new Error('expected a recorded run')
		expect(await persistence.artifacts.listIdentities()).toEqual([...before, direct.evidenceDigest].sort())
		// The identity is the digest of the canonical bytes of the record, and the record reads back from the store.
		const bytes = await persistence.artifacts.read(direct.evidenceDigest)
		expect(new TextDecoder().decode(bytes!)).toBe(new TextDecoder().decode(canonicalJsonBytes(direct.evidence)))

		// The same run again is the same bytes, so the same identity and no second record.
		expect(await recordChecksRunForHttp(owner, run())).toEqual({ status: 200, body: direct })
		const mcp = await connectMcp(app, testMember({ kind: 'agent', preset: 'editor' }))
		try {
			expect((await mcp.client.listTools()).tools.map(tool => tool.name)).toContain('record_checks_run')
			const result = await mcp.client.callTool({ name: 'record_checks_run', arguments: JSON.parse(JSON.stringify(run())) })
			expect(result.isError).toBeUndefined()
			expect(result.structuredContent).toEqual(JSON.parse(JSON.stringify(direct)))
		}
		finally { await mcp.close() }
		expect(await persistence.artifacts.listIdentities()).toEqual([...before, direct.evidenceDigest].sort())
	})

	it('makes two runs with identical results two records, because ranAt differs', async () => {
		const { app, persistence } = await seededSession()
		const first = await app.recordChecksRun(run())
		const second = await app.recordChecksRun(run({ ranAt: '2026-10-26T08:30:01.250Z' }))
		if (first.status !== 'recorded' || second.status !== 'recorded') throw new Error('expected recorded runs')
		expect(first.evidenceDigest).not.toBe(second.evidenceDigest)
		expect((await persistence.artifacts.listIdentities()).filter(identity => [first.evidenceDigest, second.evidenceDigest].includes(identity))).toHaveLength(2)
		expect({ ...first.evidence, executionContext: null }).toEqual({ ...second.evidence, executionContext: null })
	})

	it('refuses an invalid input with its diagnostics over every transport, and writes nothing', async () => {
		const { app, persistence } = await seededSession()
		const owner = scoped(app)
		const before = await persistence.artifacts.listIdentities()
		const bad = { ...run(), ranAt: 'yesterday' }
		const direct = await owner.recordChecksRun(bad)
		expect(direct).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'time.invalid_rfc3339_utc', path: '/ranAt' }] })
		expect(await recordChecksRunForHttp(owner, bad)).toEqual({ status: 422, body: direct })
		expect(await recordChecksRunForHttp(owner, undefined)).toMatchObject({ status: 422, body: { status: 'invalid' } })
		const mcp = await connectMcp(app, testMember({ kind: 'agent', preset: 'editor' }))
		try {
			const result = await mcp.client.callTool({ name: 'record_checks_run', arguments: bad })
			expect(result.isError).toBe(true)
			expect(result.structuredContent).toEqual(JSON.parse(JSON.stringify(direct)))
		}
		finally { await mcp.close() }
		expect(await persistence.artifacts.listIdentities()).toEqual(before)
	})

	it('writes nothing for a member without evidence.capture, and checks the key before the input', async () => {
		const { app, persistence } = await seededSession()
		const before = await persistence.artifacts.listIdentities()
		const viewer = scoped(app, testMember({ nickname: 'vera', preset: 'viewer' }))
		const refused = await viewer.recordChecksRun(run())
		expect(refused).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['evidence.capture'] })
		expect(await viewer.recordChecksRun({ garbage: true })).toEqual(refused)
		expect(await recordChecksRunForHttp(viewer, run())).toEqual({ status: 403, body: refused })
		const mcp = await connectMcp(app, testMember({ kind: 'agent', preset: 'viewer' }))
		try {
			const result = await mcp.client.callTool({ name: 'record_checks_run', arguments: JSON.parse(JSON.stringify(run())) })
			expect(result.isError).toBe(true)
			expect(result.structuredContent).toMatchObject({ status: 'blocked', requiredKeys: ['evidence.capture'] })
		}
		finally { await mcp.close() }
		expect(await persistence.artifacts.listIdentities()).toEqual(before)
	})

	it('is read by no consumer of formal captures: not listed as Evidence, and not in a Handoff assessment', async () => {
		const { app } = await seededSession()
		expect(await app.listEvidence()).toEqual([])
		const recorded = await app.recordChecksRun(run())
		if (recorded.status !== 'recorded') throw new Error('expected a recorded run')
		expect(await app.listEvidence()).toEqual([])
		expect(await app.listEvidence(VIEW_ID)).toEqual([])
		const assessment = JSON.stringify(await app.assessHandoffReadiness({ roots: [{ type: 'view', viewId: VIEW_ID }] }))
		expect(assessment).not.toContain(recorded.evidenceDigest)
		expect(assessment).not.toContain('checks_run')
	})
})

async function seededSession() {
	const root = await mkdtemp(join(tmpdir(), 'uiux-checks-run-'))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence, { i18n: { defaultLocale: 'en-US' }, viewports: { desktop: { dimensions: { width: 1280, height: 800 } } }, themes: { light: {} } })
	await persistence.views.create(VIEW_ID, {
		id: VIEW_ID,
		name: 'Home',
		ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
		variants: {},
		spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	})
	await persistence.locales.create('en-US', { title: 'Title' })
	return { root, persistence, app: createWorkspaceApplicationSession(persistence) }
}
