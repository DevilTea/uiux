import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSpecClient } from '@deviltea/spec-tool'
import { afterEach, describe, expect, it } from 'vitest'

import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { computeRequirementsCoverage, collectRequirementReferences } from '../src/application/services/requirements'
import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import { renderInputDigest } from '../src/domain/evidence/render-input-digest'
import { evaluateFlowTraceStaleness, FLOW_CHANGED_REASON, FLOW_PROVENANCE_MISSING_REASON } from '../src/domain/evidence/staleness'
import { flowInputDigest } from '../src/domain/flows/input-digest'
import { changeAffectsFlowEvidence, changeAffectsFormalCapture } from '../src/domain/reviews/change-domains'
import { validateFlowResource } from '../src/domain/flows/schema'
import { requirementLink, trimNoUi, trimRequirementsSetting } from '../src/domain/requirements/schema'
import { requirementHref } from '../app/utils/requirements'
import { createRequirementsService } from '../src/application/services/requirements'
import { readRequirementsProvider } from '../src/application/services/requirements-provider'
import { resolveSelectedWorkspaceAdapters } from '../src/server/workspace-adapters'
import { validateViewResource } from '../src/domain/views/schema'
import { validateWorkspaceManifest } from '../src/domain/workspace/schema'
import { FileNativePersistence } from '../src/persistence'
import { inspectWorkspaceManifest } from '../src/persistence/schema-policy'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { AGENT_EDITOR, connectMcp, HUMAN_OWNER, scoped } from './support/access'
import { currentManifest, createCurrentWorkspace, writeManifest } from './support/workspace-layout'

const VIEW = '11111111-1111-4111-8111-111111111111'
const OTHER_VIEW = '22222222-2222-4222-8222-222222222222'
const FLOW = '33333333-3333-4333-8333-333333333333'
const STEP = '44444444-4444-4444-8444-444444444444'
const temporary: string[] = []

afterEach(async () => {
	await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function viewFixture(overrides: Readonly<Record<string, unknown>> = {}, spec: Readonly<Record<string, unknown>> = {}) {
	return {
		id: VIEW,
		name: 'Checkout',
		ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
		variants: {},
		spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], requirements: [], decisions: [], ...spec },
		...overrides,
	}
}

function flowFixture(overrides: Readonly<Record<string, unknown>> = {}) {
	return { id: FLOW, name: 'Pay', entryStepId: STEP, requirements: [], steps: { [STEP]: { target: { viewId: VIEW }, transitions: [] } }, ...overrides }
}

function codes(result: { ok: boolean; diagnostics: readonly { code: string; path: string }[] }): string[] {
	return result.diagnostics.map(diagnostic => `${diagnostic.code} ${diagnostic.path}`)
}

// Clauses 01a18120-f403-796d-9ae7-7889fa233bca, 01a1144e-543a-74ba-a4b6-a1804d1d0299,
// 01a1144e-5423-7def-a70a-7962ad2d2af7 and 01a11544-68af-7a67-9983-0d5045ba70cd.
describe('requirement references in the canonical shapes (schemaVersion 7)', () => {
	it('requires a Spec to list `requirements` and lets a Variant entry and a Flow list them', () => {
		expect(validateViewResource(viewFixture()).ok).toBe(true)
		const withoutRequirements = Object.fromEntries(Object.entries(viewFixture().spec).filter(([key]) => key !== 'requirements'))
		expect(codes(validateViewResource(viewFixture({ spec: withoutRequirements })))).toEqual(['schema.expected_array /spec/requirements'])
		expect(validateViewResource(viewFixture({ variants: { Empty: { state: {}, requirements: ['r-1'] }, Plain: { state: {} } } }, { requirements: ['r-1', 'r-2'] })).ok).toBe(true)
		// An entry key other than state and requirements is still refused.
		expect(validateViewResource(viewFixture({ variants: { Empty: { state: {}, config: {} } } })).ok).toBe(false)
		expect(validateFlowResource(flowFixture({ requirements: ['r-1'] })).ok).toBe(true)
		const flowWithoutRequirements = Object.fromEntries(Object.entries(flowFixture()).filter(([key]) => key !== 'requirements'))
		expect(codes(validateFlowResource(flowWithoutRequirements))).toEqual(['schema.expected_array /requirements'])
		// Rule 01a18120-faa6-72e1-8e56-12d44df08b52: a Flow step carries no reference; only the Flow lists them.
		expect(validateFlowResource(flowFixture({ steps: { [STEP]: { target: { viewId: VIEW }, transitions: [], requirements: ['r-1'] } } })).ok).toBe(false)
	})

	it('limits an ID to 1 to 200 trimmed characters, unique within an array of at most 100', () => {
		const check = (requirements: unknown) => codes(validateViewResource(viewFixture({}, { requirements })))
		expect(check(['a'.repeat(200)])).toEqual([])
		expect(check([''])).toEqual(['requirements.invalid_id /spec/requirements/0'])
		expect(check([' padded'])).toEqual(['requirements.invalid_id /spec/requirements/0'])
		expect(check(['a'.repeat(201)])).toEqual(['requirements.invalid_id /spec/requirements/0'])
		expect(check([7])).toEqual(['requirements.invalid_id /spec/requirements/0'])
		expect(check(['a', 'b', 'a'])).toEqual(['requirements.duplicate_id /spec/requirements/2'])
		expect(check(Array.from({ length: 100 }, (_, index) => `r-${index}`))).toEqual([])
		expect(check(Array.from({ length: 101 }, (_, index) => `r-${index}`))).toEqual(['requirements.too_many /spec/requirements'])
		// Variant entries and Flows follow the same Clause, at their own paths.
		expect(codes(validateViewResource(viewFixture({ variants: { Empty: { state: {}, requirements: ['x', 'x'] } } })))).toEqual(['requirements.duplicate_id /variants/Empty/requirements/1'])
		expect(codes(validateFlowResource(flowFixture({ requirements: [''] })))).toEqual(['requirements.invalid_id /requirements/0'])
	})

	// Clauses 01a18120-f49d-7b42-bad5-69d727f6a33a and 01a18120-f52d-7448-bf25-13e37a8d791c.
	it('accepts a spec or url provider with a noUi map, and refuses any other shape as requirements.provider_invalid', () => {
		const manifest = (requirements: unknown) => validateWorkspaceManifest({ ...currentManifest(), requirements })
		expect(manifest({ provider: 'spec', path: '../.spec', noUi: { 'r-1': 'Internal.' } }).ok).toBe(true)
		expect(manifest({ provider: 'url', template: 'https://example.com/req/{id}' }).ok).toBe(true)
		for (const invalid of [
			{ provider: 'spec' },
			{ provider: 'spec', path: '' },
			{ provider: 'spec', path: '/abs/.spec' },
			{ provider: 'spec', path: 'a\\b' },
			{ provider: 'spec', path: 'a//b' },
			{ provider: 'spec', path: '.spec', template: 'https://example.com/{id}' },
			{ provider: 'url', template: 'ftp://example.com/{id}' },
			{ provider: 'url', template: 'https://example.com/none' },
			{ provider: 'url', template: 'https://example.com/{id}/{id}' },
			{ provider: 'other' },
			{ path: '.spec' },
			'spec',
		]) expect(codes(manifest(invalid)).some(code => code.startsWith('requirements.provider_invalid')), JSON.stringify(invalid)).toBe(true)
		const noUi = (value: unknown) => codes(manifest({ provider: 'spec', path: '.spec', noUi: value }))
		expect(noUi({ 'r-1': 'a'.repeat(500) })).toEqual([])
		expect(noUi({ 'r-1': '' })).toEqual(['requirements.no_ui_invalid /requirements/noUi/r-1'])
		expect(noUi({ 'r-1': ' padded ' })).toEqual(['requirements.no_ui_invalid /requirements/noUi/r-1'])
		expect(noUi({ 'r-1': 'a'.repeat(501) })).toEqual(['requirements.no_ui_invalid /requirements/noUi/r-1'])
		expect(noUi({ ' r-1': 'reason' })).toEqual(['requirements.no_ui_invalid /requirements/noUi/ r-1'])
		expect(noUi({ 'r-1': 7 })).toEqual(['requirements.no_ui_invalid /requirements/noUi/r-1'])
		expect(noUi('none')).toEqual(['requirements.no_ui_invalid /requirements/noUi'])
		expect(noUi(Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [`r-${index}`, 'x'])))).toEqual(['requirements.no_ui_invalid /requirements/noUi'])
	})

	it('builds a url provider link with the percent-encoded ID', () => {
		expect(requirementLink('https://example.com/req/{id}', 'a b/ü')).toBe('https://example.com/req/a%20b%2F%C3%BC')
	})
})

describe('hardening of what a hand-edited manifest can hold', () => {
	// Rule 01a18120-fc4e-…: a link is built from the template only when it is an http or https URL template.
	it('builds no href from a url template that is not an http or https URL template', () => {
		const url = (template: string) => ({ provider: 'url', template }) as const
		expect(requirementHref(url('https://example.com/req/{id}'), 'R 1')).toBe('https://example.com/req/R%201')
		expect(requirementHref(url('javascript:alert(1)//{id}'), 'R-1')).toBeUndefined()
		expect(requirementHref(url('data:text/html,{id}'), 'R-1')).toBeUndefined()
		expect(requirementHref(url('https://example.com/none'), 'R-1')).toBeUndefined()
		expect(requirementHref(url('https://example.com/{id}/{id}'), 'R-1')).toBeUndefined()
		expect(requirementHref({ provider: 'spec', path: '..' }, 'R-1')).toBeUndefined()
		expect(requirementHref(undefined, 'R-1')).toBeUndefined()
	})

	it('reads a provider whose noUi is not a map as one without noUi, and computes the coverage', async () => {
		const url = { provider: 'url', template: 'https://example.com/req/{id}' }
		for (const noUi of [null, 'none', 7, ['r-1']])
			expect((await readRequirementsProvider('/nowhere', { ...url, noUi } as never) as { noUi: unknown }).noUi).toEqual({})
		const { persistence, repo } = await workspaceInRepo()
		await specWorkspace(repo, 1)
		await writeManifest(persistence.root, currentManifest({ requirements: { provider: 'spec', path: '../.spec', noUi: null } }))
		expect(await createRequirementsService(persistence).readCoverage()).toMatchObject({ status: 'ok', counts: { unreferenced: 1, noUi: 0 } })
	})

	it('keeps a noUi entry named __proto__ when a write trims the map', () => {
		const parsed = JSON.parse('{"__proto__": " Reason. ", " r-1 ": "Other."}') as Record<string, string>
		const trimmed = trimNoUi(parsed)
		expect(Object.hasOwn(trimmed, '__proto__')).toBe(true)
		expect(Object.entries(trimmed)).toEqual([['__proto__', 'Reason.'], ['r-1', 'Other.']])
		const setting = trimRequirementsSetting({ provider: 'url', template: 'https://example.com/{id}', noUi: parsed })
		expect(Object.hasOwn(setting.noUi, '__proto__')).toBe(true)
	})

	// Rule 01a18121-0018-7013-9c5d-16e1efbb55a0: a requirement diagnostic in workspace.json never stops the Adapters resolving.
	it('still resolves the Adapters when workspace.json holds a requirement diagnostic, and not for another invalid setting', async () => {
		const { persistence } = await workspaceInRepo()
		const resolve = async (manifest: Record<string, unknown>) => {
			await writeManifest(persistence.root, currentManifest(manifest))
			return await resolveSelectedWorkspaceAdapters(persistence.root, persistence.layout)
		}
		for (const requirements of [
			{ provider: 'spec', path: '..', noUi: { 'r-1': 'Trailing space. ' } },
			{ provider: 'url', template: 'ftp://example.com/{id}' },
		]) {
			const resolution = await resolve({ requirements })
			expect(resolution.diagnostics.map(diagnostic => diagnostic.code), JSON.stringify(requirements)).not.toContain('workspace.manifest_missing')
			expect(resolution.state).not.toBe('invalid')
		}
		const broken = await resolve({ i18n: { defaultLocale: 'not a tag' } })
		expect(broken.diagnostics.map(diagnostic => diagnostic.code)).toContain('workspace.manifest_missing')
	})
})

// Clause 01a1144e-534c-7087-a504-76075f73df0d and Rule 01a1144e-4fe2-7bbe-82f2-e846e43def27.
describe('schemaVersion 7 is the only version read', () => {
	it('refuses a manifest at schemaVersion 6 with workspace.schema_unsupported', () => {
		const inspection = inspectWorkspaceManifest(currentManifest({ schemaVersion: 6 }), PRODUCT_WORKSPACE_SCHEMA_POLICY)
		expect(inspection).toMatchObject({ state: 'unsupported', version: 6, targetVersion: 7 })
		expect(inspection.diagnostics.map(diagnostic => diagnostic.code)).toContain('workspace.schema_unsupported')
		expect(inspectWorkspaceManifest(currentManifest(), PRODUCT_WORKSPACE_SCHEMA_POLICY)).toMatchObject({ state: 'current', version: 7 })
	})
})

// Clause 01a14e30-2d4a-7ce9-ad68-58db56f36f47 and Rules 01a18121-00a2-7263-a1e6-3729863eb0f6, 01a1814f-8256-7927-92d9-b3d2ba9e5719.
describe('digests leave out requirement references', () => {
	it('keeps the render-input digest when only a Variant\'s requirements change, and changes it with its State', () => {
		const base = viewFixture({ variants: { Empty: { state: { pay: { disabled: true } } } } })
		const referenced = viewFixture({ variants: { Empty: { state: { pay: { disabled: true } }, requirements: ['r-1'] } } }, { requirements: ['r-2'] })
		expect(renderInputDigest(referenced)).toBe(renderInputDigest(base))
		const restated = viewFixture({ variants: { Empty: { state: { pay: { disabled: false } }, requirements: ['r-1'] } } })
		expect(renderInputDigest(restated)).not.toBe(renderInputDigest(base))
		// A View without Variant requirements keeps the digest it had before the member existed.
		expect(renderInputDigest({ ir: base.ir, variants: { Empty: { state: { pay: { disabled: true } } } } })).toBe(renderInputDigest(base))
	})

	it('keeps the Flow input digest when only the Flow\'s requirements change, and changes it with anything else', () => {
		expect(flowInputDigest(flowFixture({ requirements: ['r-1', 'r-2'] }))).toBe(flowInputDigest(flowFixture()))
		expect(flowInputDigest(flowFixture({ name: 'Renamed' }))).not.toBe(flowInputDigest(flowFixture()))
		expect(flowInputDigest(flowFixture())).toMatch(/^sha256:[0-9a-f]{64}$/u)
	})

	// Clause 01a14e30-2e43-75a7-aca8-c8df28915f4e: the `spec` domain, a View's or a Variant's references included, affects no Evidence.
	it('maps a change that names the spec domain to no formal capture and no Flow Evidence', () => {
		const scope = { domains: ['spec'], views: new Set([VIEW]), flows: new Set([FLOW]) }
		expect(changeAffectsFormalCapture(scope, { viewId: VIEW, locale: 'en-US', viewportId: 'desktop', themeId: 'light' })).toBe(false)
		expect(changeAffectsFlowEvidence(scope, FLOW)).toBe(false)
		// A change that names the View's structure still does.
		expect(changeAffectsFormalCapture({ ...scope, domains: ['variant'] }, { viewId: VIEW })).toBe(true)
	})

	it('judges a flow_trace by the recorded Flow input digest: a missing one is stale, a differing one is stale, an equal one is fresh', () => {
		const digest = flowInputDigest(flowFixture())
		const trace = (provenance: Record<string, unknown>): FormalEvidenceRecord => ({
			schemaVersion: 1,
			kind: 'flow_trace',
			executionContext: { flowId: FLOW, locale: 'en-US', viewportId: 'desktop', themeId: 'light' },
			coverage: { complete: true },
			provenance: { workspaceSchemaVersion: 7, resources: [{ identity: { type: 'flow', id: FLOW }, revision: 'r_1' }], versions: { uiux: '0.1.0' }, ...provenance },
			artifactRefs: [],
		})
		const context = (flowDigest: string) => ({ allViews: [], flows: [{ key: FLOW, flowInputDigest: flowDigest }], captures: new Map() })
		expect(evaluateFlowTraceStaleness(trace({ flowInputDigest: digest }), context(digest))).toEqual({ isStale: false })
		expect(evaluateFlowTraceStaleness(trace({}), context(digest))).toEqual({ isStale: true, reason: FLOW_PROVENANCE_MISSING_REASON })
		expect(evaluateFlowTraceStaleness(trace({ flowInputDigest: digest }), context(flowInputDigest(flowFixture({ name: 'Other' }))))).toEqual({ isStale: true, reason: FLOW_CHANGED_REASON })
		// A reference-only edit of the Flow: the digest of the edited Flow is the recorded one.
		expect(evaluateFlowTraceStaleness(trace({ flowInputDigest: digest }), context(flowInputDigest(flowFixture({ requirements: ['r-9'] }))))).toEqual({ isStale: false })
	})
})

// ---------------------------------------------------------------------------------------------
// MCP authoring and the coverage Resource, against a Workspace inside a Git work tree.
// ---------------------------------------------------------------------------------------------

type Repo = Readonly<{ repo: string; root: string; persistence: FileNativePersistence; app: ReturnType<typeof createWorkspaceApplicationSession> }>

async function workspaceInRepo(options: Readonly<{ git?: boolean }> = {}): Promise<Repo> {
	const repo = await mkdtemp(join(tmpdir(), 'uiux-requirements-'))
	temporary.push(repo)
	if (options.git !== false) execFileSync('git', ['init', '-q'], { cwd: repo })
	const root = join(repo, '.uiux')
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence, { i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	return { repo, root, persistence, app: createWorkspaceApplicationSession(persistence) }
}

/** A Spec Tool workspace at `<repo>/.spec` with `count` Rules; resolves to their IDs. */
async function specWorkspace(repo: string, count: number): Promise<readonly string[]> {
	const client = createSpecClient(repo)
	let response = await client.workspace.init()
	response = await client.feature.create({ expectedRevision: response.revision, title: 'Feature', summary: 'A feature.' })
	const feature = response.changedNodes[0]!.id
	const ids: string[] = []
	for (let index = 1; index <= count; index++) {
		response = await client.rule.create({ expectedRevision: response.revision, ownerId: feature, statement: `Rule ${index} states a behavior.` })
		ids.push(response.changedNodes.find(node => node.kind === 'rule')!.id)
	}
	return ids
}

// A tool result's structured content is read member by member.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>
type ToolResult = Readonly<{ isError?: boolean; structuredContent: Loose }>

async function callTool(client: Awaited<ReturnType<typeof connectMcp>>['client'], name: string, args: Record<string, unknown>): Promise<ToolResult> {
	return await client.callTool({ name, arguments: args }) as ToolResult
}

const spec = (requirements?: readonly unknown[]) => ({
	intent: 'Pay.',
	entryConditions: [],
	interactionRules: [],
	constraints: [],
	accessibility: [],
	references: [],
	...(requirements === undefined ? {} : { requirements }),
})

async function readCoverage(client: Awaited<ReturnType<typeof connectMcp>>['client']) {
	const read = await client.readResource({ uri: 'uiux://requirements' })
	return JSON.parse((read.contents[0] as { text: string }).text) as Loose
}

async function readView(app: Repo['app'], viewId = VIEW) {
	const read = await app.readPointResource('view', viewId)
	if (read?.kind !== 'view') throw new Error('View missing.')
	return read
}

// Clause 01a1814f-83f2-76d7-8a6d-c365b548c21c and Rules 01a18120-f98f-70d6-9b2f-1f0f835efaa7, 01a18120-faa6-72e1-8e56-12d44df08b52.
describe('MCP authoring of requirement references', () => {
	it('create_view stores the given references trimmed, or [] when omitted; update_view_spec keeps them when omitted and clears them for []', async () => {
		const { app } = await workspaceInRepo()
		const { client, close } = await connectMcp(app, AGENT_EDITOR)
		try {
			const bare = await callTool(client, 'create_view', { id: OTHER_VIEW, name: 'Bare', spec: spec() })
			expect(bare.structuredContent.status).toBe('created')
			expect((await readView(app, OTHER_VIEW)).resource.spec.requirements).toEqual([])

			const created = await callTool(client, 'create_view', { id: VIEW, name: 'Checkout', spec: spec([' r-1 ', 'r-2']) })
			expect(created.structuredContent.status).toBe('created')
			expect((await readView(app)).resource.spec.requirements).toEqual(['r-1', 'r-2'])

			const kept = await callTool(client, 'update_view_spec', { viewId: VIEW, expectedRevision: created.structuredContent.revision, spec: spec() })
			expect(kept.structuredContent.status).toBe('updated')
			expect((await readView(app)).resource.spec.requirements).toEqual(['r-1', 'r-2'])

			const replaced = await callTool(client, 'update_view_spec', { viewId: VIEW, expectedRevision: kept.structuredContent.revision, spec: spec(['r-3']) })
			expect((await readView(app)).resource.spec.requirements).toEqual(['r-3'])

			const cleared = await callTool(client, 'update_view_spec', { viewId: VIEW, expectedRevision: replaced.structuredContent.revision, spec: spec([]) })
			expect(cleared.structuredContent.status).toBe('updated')
			expect((await readView(app)).resource.spec.requirements).toEqual([])
		}
		finally { await close() }
	})

	it('refuses an ID that breaks the limits with requirements.invalid_id, requirements.duplicate_id or requirements.too_many, and writes nothing', async () => {
		const { app } = await workspaceInRepo()
		const { client, close } = await connectMcp(app, AGENT_EDITOR)
		try {
			const refused = async (requirements: readonly unknown[]) => {
				const result = await callTool(client, 'create_view', { id: VIEW, name: 'Checkout', spec: spec(requirements) })
				expect(result.isError).toBe(true)
				expect(result.structuredContent.status).toBe('invalid')
				return (result.structuredContent.diagnostics as { code: string }[]).map(diagnostic => diagnostic.code)
			}
			expect(await refused(['   '])).toEqual(['requirements.invalid_id'])
			expect(await refused(['a'.repeat(201)])).toEqual(['requirements.invalid_id'])
			expect(await refused([5])).toEqual(['requirements.invalid_id'])
			expect(await refused(['a', ' a '])).toEqual(['requirements.duplicate_id'])
			expect(await refused(Array.from({ length: 101 }, (_, index) => `r-${index}`))).toEqual(['requirements.too_many'])
			expect(await app.readPointResource('view', VIEW)).toBeUndefined()
		}
		finally { await close() }
	})

	it('update_view_structure keeps each Variant entry\'s references by name when it gives none, clears them for [], and starts a new name with none', async () => {
		const { app } = await workspaceInRepo()
		const { client, close } = await connectMcp(app, AGENT_EDITOR)
		try {
			const created = await callTool(client, 'create_view', { id: VIEW, name: 'Checkout', spec: spec() })
			const ir = { type: 'RootShell', id: 'root', slots: { content: [] } }
			const first = await callTool(client, 'update_view_structure', { viewId: VIEW, expectedRevision: created.structuredContent.revision, ir, variants: { A: { state: {}, requirements: ['r-a'] }, B: { state: {}, requirements: ['r-b'] }, C: { state: {} } } })
			expect(first.structuredContent.status).toBe('updated')
			expect((await readView(app)).resource.variants).toEqual({ A: { state: {}, requirements: ['r-a'] }, B: { state: {}, requirements: ['r-b'] }, C: { state: {} } })

			const second = await callTool(client, 'update_view_structure', { viewId: VIEW, expectedRevision: first.structuredContent.revision, ir, variants: { A: { state: { root: { x: 1 } } }, B: { state: {}, requirements: [] }, C: { state: {} }, D: { state: {} } } })
			expect(second.structuredContent.status).toBe('updated')
			expect((await readView(app)).resource.variants).toEqual({ A: { state: { root: { x: 1 } }, requirements: ['r-a'] }, B: { state: {}, requirements: [] }, C: { state: {} }, D: { state: {} } })
		}
		finally { await close() }
	})

	it('create_flow stores [] when omitted; update_flow keeps the Flow\'s references when omitted and clears them for []', async () => {
		const { app } = await workspaceInRepo()
		const { client, close } = await connectMcp(app, AGENT_EDITOR)
		try {
			await callTool(client, 'create_view', { id: VIEW, name: 'Checkout', spec: spec() })
			const step = { target: { viewId: VIEW }, transitions: [] }
			const bare = await callTool(client, 'create_flow', { id: FLOW, name: 'Pay', entryStepId: STEP, steps: { [STEP]: step } })
			expect(bare.structuredContent.status).toBe('created')
			const read = async () => (await app.readPointResource('flow', FLOW)) as unknown as { resource: { requirements: string[] } }
			expect((await read()).resource.requirements).toEqual([])

			const set = await callTool(client, 'update_flow', { flowId: FLOW, expectedRevision: bare.structuredContent.revision, name: 'Pay', entryStepId: STEP, steps: { [STEP]: step }, requirements: ['r-1'] })
			expect((await read()).resource.requirements).toEqual(['r-1'])
			const kept = await callTool(client, 'update_flow', { flowId: FLOW, expectedRevision: set.structuredContent.revision, name: 'Pay now', entryStepId: STEP, steps: { [STEP]: step } })
			expect(kept.structuredContent.status).toBe('updated')
			expect((await read()).resource.requirements).toEqual(['r-1'])
			const cleared = await callTool(client, 'update_flow', { flowId: FLOW, expectedRevision: kept.structuredContent.revision, name: 'Pay now', entryStepId: STEP, steps: { [STEP]: step }, requirements: [] })
			expect(cleared.structuredContent.status).toBe('updated')
			expect((await read()).resource.requirements).toEqual([])
			const refused = await callTool(client, 'update_flow', { flowId: FLOW, expectedRevision: cleared.structuredContent.revision, name: 'Pay now', entryStepId: STEP, steps: { [STEP]: step }, requirements: ['x', 'x'] })
			expect(refused.structuredContent).toMatchObject({ status: 'invalid' })
		}
		finally { await close() }
	})

	it('keeps requirements when the HTTP-shaped Spec editor sends none (omission is a keep on every transport)', async () => {
		const { app } = await workspaceInRepo()
		const session = scoped(app, HUMAN_OWNER)
		const created = await session.createView({ id: VIEW, name: 'Checkout', spec: { ...spec(['r-1']), references: [] } as never })
		if (created.status !== 'created') throw new Error('create failed')
		const updated = await session.updateViewSpec({ key: VIEW, expectedRevision: created.revision, spec: spec() as never })
		expect(updated.status).toBe('updated')
		expect((await readView(app)).resource.spec.requirements).toEqual(['r-1'])
	})
})

// Clauses 01a11485-f769-727c-8eda-c33cff801911, 01a18120-f49d-… and 01a18120-f5b9-75e2-83a6-8048dc5d6fba.
describe('update_workspace_settings and the requirements setting', () => {
	const settings = (extra: Record<string, unknown> = {}) => ({ i18n: { defaultLocale: 'en-US' }, viewports: {}, themes: {}, ...extra })

	async function manifestRevision(app: Repo['app']): Promise<string> {
		const read = await app.readPointResource('workspace', 'workspace')
		if (read?.kind !== 'workspace') throw new Error('Workspace missing.')
		return read.revision
	}

	it('replaces the whole setting when given, keeps it when omitted and removes it for null', async () => {
		const { app } = await workspaceInRepo()
		const { client, close } = await connectMcp(app, AGENT_EDITOR)
		try {
			const url = { provider: 'url', template: 'https://example.com/req/{id}', noUi: { ' r-1 ': ' Internal. ' } }
			const set = await callTool(client, 'update_workspace_settings', { expectedRevision: await manifestRevision(app), settings: settings({ requirements: url }) })
			expect(set.structuredContent.status).toBe('updated')
			const manifest = async () => (await app.readPointResource('workspace', 'workspace')) as unknown as { resource: { schemaVersion: number; requirements?: unknown } }
			// IDs and reasons are stored trimmed.
			expect((await manifest()).resource.requirements).toEqual({ provider: 'url', template: 'https://example.com/req/{id}', noUi: { 'r-1': 'Internal.' } })
			expect((await manifest()).resource.schemaVersion).toBe(7)

			const kept = await callTool(client, 'update_workspace_settings', { expectedRevision: await manifestRevision(app), settings: settings() })
			expect(kept.structuredContent.status).toBe('updated')
			expect((await manifest()).resource.requirements).toMatchObject({ provider: 'url' })

			const removed = await callTool(client, 'update_workspace_settings', { expectedRevision: await manifestRevision(app), settings: settings({ requirements: null }) })
			expect(removed.structuredContent.status).toBe('updated')
			expect((await manifest()).resource.requirements).toBeUndefined()
		}
		finally { await close() }
	})

	it('refuses a malformed setting with requirements.provider_invalid or requirements.no_ui_invalid, and a spec path outside the Git work tree', async () => {
		const { app, repo } = await workspaceInRepo()
		const { client, close } = await connectMcp(app, AGENT_EDITOR)
		try {
			const refused = async (requirements: unknown) => {
				const result = await callTool(client, 'update_workspace_settings', { expectedRevision: await manifestRevision(app), settings: settings({ requirements }) })
				expect(result.isError, JSON.stringify(requirements)).toBe(true)
				expect(result.structuredContent.status).toBe('invalid')
				return (result.structuredContent.diagnostics as { code: string }[]).map(diagnostic => diagnostic.code)
			}
			expect(await refused({ provider: 'spec', path: '' })).toContain('requirements.provider_invalid')
			expect(await refused({ provider: 'url', template: 'https://example.com/none' })).toContain('requirements.provider_invalid')
			expect(await refused('spec')).toContain('requirements.provider_invalid')
			expect(await refused({ provider: 'spec', path: '../..', noUi: {} })).toEqual(['requirements.provider_invalid'])
			expect(await refused({ provider: 'spec', path: '..', noUi: { 'r-1': '' } })).toEqual(['requirements.no_ui_invalid'])
			// A link out of the work tree is refused by its real path.
			const outside = await mkdtemp(join(tmpdir(), 'uiux-requirements-outside-'))
			temporary.push(outside)
			await symlink(outside, join(repo, 'escape'))
			expect(await refused({ provider: 'spec', path: '../escape' })).toEqual(['requirements.provider_invalid'])
		}
		finally { await close() }
	})

	it('refuses a spec provider in a Workspace that is in no Git work tree', async () => {
		const { app } = await workspaceInRepo({ git: false })
		const { client, close } = await connectMcp(app, AGENT_EDITOR)
		try {
			const result = await callTool(client, 'update_workspace_settings', { expectedRevision: await manifestRevision(app), settings: settings({ requirements: { provider: 'spec', path: '..' } }) })
			expect(result.structuredContent).toMatchObject({ status: 'invalid' })
			expect((result.structuredContent.diagnostics as { code: string }[]).map(diagnostic => diagnostic.code)).toEqual(['requirements.provider_invalid'])
		}
		finally { await close() }
	})
})

// Clause 01a18120-f903-7f8d-9b44-d581ab520c0d, Rules 01a18120-fd5d-…, fde6-…, fb3a-…, fbc4-…, 01a1814f-8133-….
describe('the Resource uiux://requirements', () => {
	const settings = (requirements: unknown) => ({ i18n: { defaultLocale: 'en-US' }, viewports: {}, themes: {}, requirements })

	async function setProvider(app: Repo['app'], client: Awaited<ReturnType<typeof connectMcp>>['client'], requirements: unknown) {
		const read = await app.readPointResource('workspace', 'workspace')
		if (read?.kind !== 'workspace') throw new Error('Workspace missing.')
		const result = await callTool(client, 'update_workspace_settings', { expectedRevision: read.revision, settings: settings(requirements) })
		if (result.structuredContent.status !== 'updated') throw new Error(JSON.stringify(result.structuredContent))
		return result
	}

	it('reports status none and lists every referenced ID as unverified, when there is no provider', async () => {
		const { app } = await workspaceInRepo()
		const { client, close } = await connectMcp(app, AGENT_EDITOR)
		try {
			await callTool(client, 'create_view', { id: VIEW, name: 'Checkout', spec: spec(['r-1']) })
			const coverage = await readCoverage(client)
			expect(coverage).toEqual({
				provider: null,
				status: 'none',
				counts: { referenced: 0, unreferenced: 0, noUi: 0, unresolved: 0, unverified: 1 },
				requirements: [],
				unresolved: [],
				unverified: [{ id: 'r-1', referencedBy: [{ kind: 'view', viewId: VIEW }] }],
			})
		}
		finally { await close() }
	})

	it('reports status url without coverage, the references still unverified', async () => {
		const { app } = await workspaceInRepo()
		const { client, close } = await connectMcp(app, AGENT_EDITOR)
		try {
			await setProvider(app, client, { provider: 'url', template: 'https://example.com/req/{id}', noUi: { 'r-9': 'No UI.' } })
			await callTool(client, 'create_view', { id: VIEW, name: 'Checkout', spec: spec(['r-1']) })
			const coverage = await readCoverage(client)
			expect(coverage).toMatchObject({ provider: { provider: 'url', template: 'https://example.com/req/{id}' }, status: 'url', requirements: [], unresolved: [] })
			expect(coverage.counts).toMatchObject({ referenced: 0, unreferenced: 0, noUi: 0, unverified: 1 })
			expect(coverage.provider).not.toHaveProperty('noUi')
		}
		finally { await close() }
	})

	// Scenario 01a18121-7c11-7a8a-8952-45198dd8ee7f.
	it('counts a requirement that only a Variant references as referenced, with referencedBy naming the Variant', async () => {
		const { app, repo } = await workspaceInRepo()
		const ids = await specWorkspace(repo, 4)
		const { client, close } = await connectMcp(app, AGENT_EDITOR)
		try {
			await setProvider(app, client, { provider: 'spec', path: '../.spec', noUi: { [ids[3]!]: 'Telemetry only.' } })
			const created = await callTool(client, 'create_view', { id: VIEW, name: 'Checkout', spec: spec([ids[0]]) })
			await callTool(client, 'update_view_structure', { viewId: VIEW, expectedRevision: created.structuredContent.revision, ir: { type: 'RootShell', id: 'root', slots: { content: [] } }, variants: { Empty: { state: {}, requirements: [ids[1]] } } })
			const coverage = await readCoverage(client)
			expect(coverage.status).toBe('ok')
			expect(coverage.provider).toEqual({ provider: 'spec', path: '../.spec' })
			expect(coverage.counts).toEqual({ referenced: 2, unreferenced: 1, noUi: 1, unresolved: 0, unverified: 0 })
			const byId = new Map((coverage.requirements as { id: string; state: string; statement: string; reason?: string; referencedBy: unknown[] }[]).map(entry => [entry.id, entry]))
			expect(byId.get(ids[0]!)).toMatchObject({ state: 'referenced', statement: 'Rule 1 states a behavior.', referencedBy: [{ kind: 'view', viewId: VIEW }] })
			expect(byId.get(ids[1]!)).toMatchObject({ state: 'referenced', referencedBy: [{ kind: 'variant', viewId: VIEW, variantName: 'Empty' }] })
			expect(byId.get(ids[2]!)).toMatchObject({ state: 'unreferenced', referencedBy: [] })
			expect(byId.get(ids[3]!)).toMatchObject({ state: 'noUi', reason: 'Telemetry only.', referencedBy: [] })
			expect(coverage.unresolved).toEqual([])
			expect(coverage.unverified).toEqual([])
		}
		finally { await close() }
	})

	// Scenario 01a18121-7ca1-7951-ae10-4846d9550a98.
	it('keeps an ID the provider lacks as written, reports requirements.unresolved in the write result and lists it as unresolved; a noUi entry the provider lacks too', async () => {
		const { app, repo } = await workspaceInRepo()
		const ids = await specWorkspace(repo, 2)
		const { client, close } = await connectMcp(app, AGENT_EDITOR)
		try {
			const unknown = '01a00000-0000-7000-8000-000000000000'
			const settingsResult = await setProvider(app, client, { provider: 'spec', path: '../.spec', noUi: { [unknown]: 'Gone.' } })
			expect(settingsResult.structuredContent.diagnostics).toContainEqual(expect.objectContaining({ code: 'requirements.unresolved', path: `/requirements/noUi/${unknown}` }))

			const created = await callTool(client, 'create_view', { id: VIEW, name: 'Checkout', spec: spec([ids[0], 'not-a-rule']) })
			expect(created.structuredContent.status).toBe('created')
			expect(created.structuredContent.diagnostics).toEqual([expect.objectContaining({ code: 'requirements.unresolved', path: '/spec/requirements/1' })])
			expect((await readView(app)).resource.spec.requirements).toEqual([ids[0], 'not-a-rule'])

			const step = { target: { viewId: VIEW }, transitions: [] }
			const flow = await callTool(client, 'create_flow', { id: FLOW, name: 'Pay', entryStepId: STEP, steps: { [STEP]: step }, requirements: ['also-missing'] })
			expect(flow.structuredContent.diagnostics).toEqual([expect.objectContaining({ code: 'requirements.unresolved', path: '/requirements/0' })])

			const coverage = await readCoverage(client)
			expect(coverage.counts).toMatchObject({ referenced: 1, unreferenced: 1, noUi: 0, unresolved: 3, unverified: 0 })
			expect(new Map((coverage.unresolved as { id: string; referencedBy: unknown[] }[]).map(entry => [entry.id, entry.referencedBy]))).toEqual(new Map([
				[unknown, []],
				['not-a-rule', [{ kind: 'view', viewId: VIEW }]],
				['also-missing', [{ kind: 'flow', flowId: FLOW }]],
			]))
		}
		finally { await close() }
	})

	// Rule 01a1814f-8133-7965-9e91-df5fa1f83b53.
	it('reports status unavailable, with every referenced ID unverified and no unresolved ID, when the provider cannot be read', async () => {
		const { app, repo } = await workspaceInRepo()
		const { client, close } = await connectMcp(app, AGENT_EDITOR)
		try {
			await mkdir(join(repo, 'plain'))
			const result = await setProvider(app, client, { provider: 'spec', path: '../plain' })
			expect(result.structuredContent.diagnostics).toContainEqual(expect.objectContaining({ code: 'requirements.provider_unavailable' }))
			const created = await callTool(client, 'create_view', { id: VIEW, name: 'Checkout', spec: spec(['r-1']) })
			expect(created.structuredContent.diagnostics).toEqual([expect.objectContaining({ code: 'requirements.provider_unavailable', path: '/spec/requirements' })])
			const coverage = await readCoverage(client)
			expect(coverage).toMatchObject({ status: 'unavailable', requirements: [], unresolved: [] })
			expect(coverage.counts).toEqual({ referenced: 0, unreferenced: 0, noUi: 0, unresolved: 0, unverified: 1 })
			expect(coverage.unverified).toEqual([{ id: 'r-1', referencedBy: [{ kind: 'view', viewId: VIEW }] }])
		}
		finally { await close() }
	})

	it('reads a spec provider whose path names the directory that holds .spec as well as .spec itself', async () => {
		const { app, repo } = await workspaceInRepo()
		await specWorkspace(repo, 2)
		const { client, close } = await connectMcp(app, AGENT_EDITOR)
		try {
			await setProvider(app, client, { provider: 'spec', path: '..' })
			expect(await readCoverage(client)).toMatchObject({ status: 'ok', counts: { unreferenced: 2 } })
			await setProvider(app, client, { provider: 'spec', path: '../.spec' })
			expect(await readCoverage(client)).toMatchObject({ status: 'ok', counts: { unreferenced: 2 } })
		}
		finally { await close() }
	})

	it('reads the Spec Tool workspace without writing it', async () => {
		const { app, repo } = await workspaceInRepo()
		await specWorkspace(repo, 1)
		const { client, close } = await connectMcp(app, AGENT_EDITOR)
		try {
			await setProvider(app, client, { provider: 'spec', path: '../.spec' })
			const before = execFileSync('git', ['status', '--porcelain', '--', '.spec'], { cwd: repo }).toString()
			await readCoverage(client)
			expect(execFileSync('git', ['status', '--porcelain', '--', '.spec'], { cwd: repo }).toString()).toBe(before)
			expect(execFileSync('ls', ['-A'], { cwd: repo }).toString().split('\n')).not.toContain('.spec-tool-v1.lock')
		}
		finally { await close() }
	})
})

describe('coverage computation', () => {
	it('lists a noUi requirement outside coverage whatever references it, and counts a View-and-Variant reference once', () => {
		const view = { ...viewFixture({ variants: { A: { state: {}, requirements: ['r-1'] } } }, { requirements: ['r-1', 'r-2'] }) } as never
		const references = collectRequirementReferences(new Map([[VIEW, view]]), new Map())
		expect(references.get('r-1')).toEqual([{ kind: 'view', viewId: VIEW }, { kind: 'variant', viewId: VIEW, variantName: 'A' }])
		const coverage = computeRequirementsCoverage(
			{ provider: 'spec', path: '.spec', noUi: { 'r-2': 'No UI.' } },
			{ status: 'ok', provider: { provider: 'spec', path: '.spec' }, noUi: { 'r-2': 'No UI.' }, rules: new Map([['r-1', 'One'], ['r-2', 'Two'], ['r-3', 'Three']]) },
			references,
		)
		expect(coverage.counts).toEqual({ referenced: 1, unreferenced: 1, noUi: 1, unresolved: 0, unverified: 0 })
		expect(coverage.requirements.find(entry => entry.id === 'r-2')).toMatchObject({ state: 'noUi', reason: 'No UI.', referencedBy: [{ kind: 'view', viewId: VIEW }] })
	})
})

// Scenarios 01a18121-7d2b-70b0-8ff5-579948a687a1 and 01a1814f-8368-7352-a4c8-22b7128356a0, through the services.
describe('a reference-only edit leaves Evidence fresh', () => {
	it('keeps the View render-input digest and the Flow input digest unchanged when only requirements are written', async () => {
		const { app } = await workspaceInRepo()
		const { client, close } = await connectMcp(app, AGENT_EDITOR)
		try {
			const created = await callTool(client, 'create_view', { id: VIEW, name: 'Checkout', spec: spec() })
			const ir = { type: 'RootShell', id: 'root', slots: { content: [] } }
			const structured = await callTool(client, 'update_view_structure', { viewId: VIEW, expectedRevision: created.structuredContent.revision, ir, variants: { Empty: { state: {}, requirements: [] } } })
			const step = { target: { viewId: VIEW }, transitions: [] }
			const flow = await callTool(client, 'create_flow', { id: FLOW, name: 'Pay', entryStepId: STEP, steps: { [STEP]: step } })

			const before = { views: await app.viewRenderInputs(), flows: await app.flowInputs() }
			const withReferences = await callTool(client, 'update_view_structure', { viewId: VIEW, expectedRevision: structured.structuredContent.revision, ir, variants: { Empty: { state: {}, requirements: ['r-1'] } } })
			await callTool(client, 'update_flow', { flowId: FLOW, expectedRevision: flow.structuredContent.revision, name: 'Pay', entryStepId: STEP, steps: { [STEP]: step }, requirements: ['r-1'] })
			const after = { views: await app.viewRenderInputs(), flows: await app.flowInputs() }

			expect(after.views[0]!.renderInputDigest).toBe(before.views[0]!.renderInputDigest)
			expect(after.views[0]!.revision).not.toBe(before.views[0]!.revision)
			expect(after.flows[0]!.flowInputDigest).toBe(before.flows[0]!.flowInputDigest)
			expect(after.flows[0]!.revision).not.toBe(before.flows[0]!.revision)

			// A State edit still changes the render input, and a rename the Flow input.
			await callTool(client, 'update_view_structure', { viewId: VIEW, expectedRevision: withReferences.structuredContent.revision, ir, variants: { Empty: { state: { root: { x: 1 } } } } })
			expect((await app.viewRenderInputs())[0]!.renderInputDigest).not.toBe(before.views[0]!.renderInputDigest)
		}
		finally { await close() }
	})
})
