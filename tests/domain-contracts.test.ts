import { describe, expect, it } from 'vitest'
import { validateAdapterConfig, validateAdapterManifest, validateResolvedAdapterSet } from '../src/domain/adapters/schema'
import { validateAssetBinding, validateAssetBindingCompatibility, validateAssetContentFiles, validateAssetContentMetadata, validateAssetMetadata } from '../src/domain/assets/schema'
import { artifactBytesMatch, artifactStoreShardPath, sha256Identity, validateArtifactIdentity } from '../src/domain/artifacts/schema'
import { validateFormalEvidenceRecord, validateTranslationEvidenceOccurrence } from '../src/domain/evidence/schema'
import { validateFlowResource } from '../src/domain/flows/schema'
import { mayClaimImplementationReady, validateHandoffManifest, validateHandoffRoot, validateImplementationReadyClaim } from '../src/domain/handoff/schema'
import { validateI18nBinding, validateI18nBindingEligibility, validateI18nFieldMapping, validateI18nResource, validateI18nWarning } from '../src/domain/i18n/schema'
import { validateRenderContextSelection, validateResolvedRenderContext, type ResolvedRenderContext } from '../src/domain/render-context/schema'
import { validateReviewEvidenceRef, validateReviewThread } from '../src/domain/reviews/schema'
import { validateReference, validateViewSpec, transitionDecision, validateDecision, type Decision } from '../src/domain/spec/schema'
import { validateResourceRevision, validateRevisionConflict } from '../src/application/dto/revisions'
import { validateUniqueFullUuidClaims } from '../src/domain/identity-index'
import { isAbsoluteUri, isCanonicalLocaleFilename, isFullUuid, isSha256Digest } from '../src/domain/validation'
import { validateRootShellContentSlot, validateRootShellIdentity, validateRootShellStructure, validateViewResource } from '../src/domain/views/schema'
import { discoverLocaleFiles, validateWorkspaceManifest } from '../src/domain/workspace/schema'
import { responseMeetsRequestedPrecision, validateCapabilityMessage, validateGeometryMessage, validatePartialResponseAgainstRequest, validatePreviewFailureDiagnostic, type Contour, type PartialContourRequest, type PartialContourResponse } from '../src/preview/protocol/schema'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const STEP_A = '22222222-2222-4222-8222-222222222222'
const STEP_B = '33333333-3333-4333-8333-333333333333'
const DECISION_ID = '44444444-4444-4444-8444-444444444444'
const ASSET_ID = '55555555-5555-4555-8555-555555555555'
const REVIEW_ID = '66666666-6666-4666-8666-666666666666'
const SUBMISSION_ID = '77777777-7777-4777-8777-777777777777'
const HISTORY_ID = '99999999-9999-4999-8999-999999999999'
const DIGEST = `sha256:${'a'.repeat(64)}`
const TIME = '2026-09-30T12:30:00Z'
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema'
/** Review files are decoded under the selected Workspace schemaVersion; these cases pin the v1 rules. */
const REVIEW_V1 = { schemaVersion: 1 } as const

const workspace = {
	schemaVersion: 1,
	i18n: { defaultLocale: 'en-US' },
	adapters: [{ moduleSpecifier: '@deviltea/design-system' }],
	viewports: { desktop: { label: 'Desktop', dimensions: { width: 1280, height: 800 } } },
	themes: { light: { label: 'Light' } },
}

const view = {
	id: VIEW_ID,
	name: 'Checkout',
	ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
	variants: { Empty: { state: {} } },
	spec: {
		intent: '',
		entryConditions: [],
		interactionRules: [],
		constraints: [],
		accessibility: [],
		references: [{ type: 'external', uri: 'urn:design:checkout', label: 'Design brief' }],
		decisions: [],
	},
}

const context: ResolvedRenderContext = {
	viewId: VIEW_ID,
	locale: 'en-US',
	viewportId: 'desktop',
	viewport: { width: 1280, height: 800 },
	themeId: 'light',
}

const protocolContext = {
	previewSessionId: 'session-1',
	runtimeGenerationId: 'generation-1',
	viewId: VIEW_ID,
	widgetId: 'submit-button',
	geometryRevision: 0,
}

const acquisitionContext = {
	previewSessionId: 'session-1',
	runtimeGenerationId: 'generation-1',
	viewId: VIEW_ID,
	widgetId: 'submit-button',
}

const square: Contour = {
	commands: [
		{ op: 'moveTo', x: 0, y: 0 },
		{ op: 'lineTo', x: 10, y: 0 },
		{ op: 'lineTo', x: 10, y: 10 },
		{ op: 'lineTo', x: 0, y: 10 },
		{ op: 'close' },
	],
}

const reviewSubmission = {
	id: SUBMISSION_ID,
	actor: { type: 'agent', id: 'agent-1' },
	at: TIME,
	changeDomains: ['IR', 'Spec'],
	resources: [{ identity: { type: 'view', id: VIEW_ID }, revision: 'view-rev-1' }],
	scope: { viewId: VIEW_ID },
	evidenceRefs: [{ kind: 'validation', evidence: DIGEST }],
}

describe('canonical resource primitives', () => {
	it('validates identity, digest, URI, and locale filename boundaries', () => {
		expect(isFullUuid(VIEW_ID)).toBe(true)
		expect(isFullUuid('short-id')).toBe(false)
		expect(isSha256Digest(DIGEST)).toBe(true)
		expect(isSha256Digest('sha256:ABC')).toBe(false)
		expect(isAbsoluteUri('urn:design:checkout')).toBe(true)
		expect(isAbsoluteUri('./brief.md')).toBe(false)
		expect(isCanonicalLocaleFilename('zh-Hant-TW.json')).toBe(true)
		expect(isCanonicalLocaleFilename('EN-us.json')).toBe(false)
	})

	it('validates Workspace manifest registries and portable adapter references', () => {
		expect(validateWorkspaceManifest(workspace).ok).toBe(true)
		expect(validateWorkspaceManifest({ ...workspace, viewports: { collapsed: { dimensions: { width: 0, height: 0 } } } }).ok).toBe(true)
		expect(validateWorkspaceManifest({ ...workspace, adapters: [{ moduleSpecifier: '/opt/adapter' }] }).ok).toBe(false)
		expect(validateWorkspaceManifest({ ...workspace, viewports: { '': { dimensions: { width: 1, height: 1 } } } }).ok).toBe(false)
		expect(validateWorkspaceManifest({ ...workspace, i18n: { defaultLocale: 'EN-us' } }).ok).toBe(false)
		expect(discoverLocaleFiles(['en-US.json', 'EN-us.json', 'en_US.json', 'zh-Hant-TW.json'])).toEqual(['en-US', 'zh-Hant-TW'])
	})

	it('validates the View root boundary without taking ownership of Widget IR', () => {
		expect(validateViewResource(view, `${VIEW_ID}.view.json`).ok).toBe(true)
		expect(validateViewResource(view, `${STEP_A}.view.json`).diagnostics.some(item => item.code === 'identity.filename_id_mismatch')).toBe(true)
		expect(validateRootShellIdentity({ type: 'Button', id: 'root' }).ok).toBe(false)
		expect(validateRootShellIdentity({ type: 'RootShell', id: 'not-root' }).ok).toBe(false)
		expect(validateRootShellContentSlot([]).ok).toBe(true)
		expect(validateRootShellContentSlot(undefined).ok).toBe(false)
		expect(validateRootShellStructure({ type: 'RootShell', id: 'root', slots: { content: [] } }).ok).toBe(true)
		expect(validateRootShellStructure({ type: 'RootShell', id: 'root' }).ok).toBe(false)
		expect(validateRootShellStructure({ type: 'RootShell', id: 'root', slots: { content: [], extra: [] } }).ok).toBe(false)
		expect(validateRootShellStructure({ type: 'RootShell', id: 'root', slots: { content: [{ type: 'RootShell', id: 'nested', slots: { content: [] } }] } }).diagnostics.some(item => item.code === 'view.nested_root_shell')).toBe(true)
	})

	it('validates typed references and full View Spec presence', () => {
		expect(validateReference({ type: 'view', viewId: VIEW_ID, variantName: 'Empty', relation: 'follows' }).ok).toBe(true)
		expect(validateReference({ type: 'external', uri: './relative/design.fig' }).ok).toBe(false)
		expect(validateReference({ type: 'external', uri: 'https://example.test/spec', relation: '' }).ok).toBe(false)
		expect(validateViewSpec(view.spec).ok).toBe(true)
		expect(validateViewSpec({ ...view.spec, accessibility: undefined }).ok).toBe(false)
		expect(validateViewSpec({ ...view.spec, decisions: [
			{ id: DECISION_ID, question: 'A?', status: 'pending', history: [] },
			{ id: DECISION_ID, question: 'B?', status: 'pending', history: [] },
		] }).ok).toBe(false)
		expect(validateUniqueFullUuidClaims([
			{ id: VIEW_ID, resource: 'view', path: '/views/0' },
			{ id: VIEW_ID, resource: 'flow', path: '/flows/0' },
		]).ok).toBe(false)
	})

	it('clears a reopened Decision outcome and preserves the prior result only in history', () => {
		const pending: Decision = { id: DECISION_ID, question: 'Which confirmation copy?', status: 'pending', history: [] }
		const decided = transitionDecision(pending, {
			nextStatus: 'decided', at: TIME, actor: { type: 'human', id: 'reviewer' },
			outcome: { summary: 'Use a short confirmation.', rationale: '' },
		})
		expect(decided.ok).toBe(true)
		if (!decided.ok) return
		const reopened = transitionDecision(decided.value, {
			nextStatus: 'pending', at: '2026-09-30T12:35:00Z', actor: { type: 'human', id: 'reviewer' },
		})
		expect(reopened.ok).toBe(true)
		if (!reopened.ok) return
		expect(Object.hasOwn(reopened.value, 'outcome')).toBe(false)
		expect(reopened.value.history.at(-1)?.before.outcome).toEqual({ summary: 'Use a short confirmation.', rationale: '' })
		expect(Object.hasOwn(reopened.value.history.at(-1)?.after ?? {}, 'outcome')).toBe(false)
		expect(validateDecision(reopened.value).ok).toBe(true)
		expect(validateDecision({ ...pending, outcome: { summary: 'stale', rationale: '' } }).ok).toBe(false)
		expect(validateDecision({ ...pending, history: [{ at: TIME, actor: { type: 'human' }, before: { status: 'decided', outcome: { summary: 'old', rationale: '' } }, after: { status: 'deferred' } }] }).ok).toBe(false)
		const brokenChain = {
			...reopened.value,
			history: reopened.value.history.map((entry, index) => index === 1 ? { ...entry, before: { status: 'pending' as const } } : entry),
		}
		expect(validateDecision(brokenChain).diagnostics.some(item => item.code === 'decision.discontinuous_history')).toBe(true)
		expect(validateDecision({ ...reopened.value, status: 'deferred' }).diagnostics.some(item => item.code === 'decision.history_state_mismatch')).toBe(true)
	})

	it('validates flat locale resources, explicit bindings, mappings, and warning unions', () => {
		expect(validateI18nResource({ 'checkout.title': '', note: '  ' }, 'en-US.json').ok).toBe(true)
		expect(validateI18nResource({ checkout: { title: 'Nested' } }, 'en-US.json').ok).toBe(false)
		expect(validateI18nBinding({ $i18n: 'checkout.title' }).ok).toBe(true)
		expect(validateI18nBinding({ $i18n: 'checkout.title', fallback: 'Title' }).ok).toBe(false)
		const mapping = { title: { configField: 'titleKey', resultProperty: 'titleResult', textProperty: 'titleText' } }
		expect(validateI18nBindingEligibility({ $i18n: 'checkout.title' }, 'title', mapping).ok).toBe(true)
		expect(validateI18nBindingEligibility({ $i18n: 'checkout.title' }, 'label', mapping).ok).toBe(false)
		const mappedField = { configField: 'titleKey', resultProperty: 'titleResult', textProperty: 'titleText' }
		expect(validateI18nFieldMapping({ ...mappedField, params: { _count: 'count', count1: 'count' } }).ok).toBe(true)
		expect(validateI18nFieldMapping({ ...mappedField, params: { 'bad-name': 'count' } }).ok).toBe(false)
		expect(validateI18nFieldMapping({ ...mappedField, params: { '1count': 'count' } }).ok).toBe(false)
		expect(validateI18nWarning({ code: 'missing-translation', key: 'title', requestedLocale: 'fr-FR', fallbackLocale: 'en-US' }).ok).toBe(true)
		expect(validateI18nWarning({ code: 'missing-parameter', key: 'title', requestedLocale: 'en-US' }).ok).toBe(false)
	})
})

describe('adapters, flows, reviews, and authored assets', () => {
	it('keeps adapter config schema-owned and rejects unvalidated config', () => {
		const schema = {
			$schema: DRAFT_2020_12,
			type: 'object',
			required: ['enabled'],
			properties: { enabled: { type: 'boolean' } },
			additionalProperties: false,
		}
		const adapter = {
			id: '@deviltea/base', apiVersion: '1', widgetPlugins: [], renderers: [], providers: [], styles: [], tokens: [],
			catalog: { widgets: { Image: { i18n: { fields: {} }, assetFields: { image: { acceptedMediaTypes: ['image/png'] } } } } }, configSchema: schema,
		}
		expect(validateAdapterManifest(adapter).ok).toBe(true)
		expect(validateAdapterManifest({ ...adapter, catalog: { i18n: { fields: {} } } })).toEqual(expect.objectContaining({ ok: false }))
		expect(validateAdapterManifest({ ...adapter, catalog: { widgets: {}, i18n: { fields: {} } } }).diagnostics.some(item => item.code === 'adapter.catalog_widget_metadata_misplaced')).toBe(true)
		expect(validateAdapterManifest({ ...adapter, catalog: { widgets: {}, assetFields: { image: { acceptedMediaTypes: ['image/png'] } } } }).diagnostics.some(item => item.code === 'adapter.catalog_widget_metadata_misplaced')).toBe(true)
		expect(validateAdapterManifest({ ...adapter, catalog: { widgets: {}, documentation: { label: 'Base catalog' } } }).ok).toBe(true)
		expect(validateAdapterManifest({ ...adapter, catalog: { widgets: { '': {} } } }).ok).toBe(false)
		expect(validateAdapterManifest({ ...adapter, catalog: { widgets: {}, extension: () => 'not-json' } }).ok).toBe(false)
		expect(validateAdapterManifest({
			...adapter,
			catalog: {
				widgets: {
					Button: { i18n: { fields: { title: { configField: 'key', resultProperty: 'result', textProperty: 'text' } } } },
					Label: { i18n: { fields: { title: { configField: 'key', resultProperty: 'result', textProperty: 'text' } } } },
				},
			},
		})).toEqual(expect.objectContaining({ ok: true }))
		expect(validateAdapterConfig({ enabled: true }, undefined).ok).toBe(false)
		expect(validateAdapterConfig({ enabled: true }, schema).ok).toBe(true)
		expect(validateAdapterConfig({ enabled: 'yes' }, schema).ok).toBe(false)
		expect(validateAdapterConfig({ enabled: true }, schema, () => [{ path: '/enabled', message: 'must be string' }]).ok).toBe(false)
		const tupleSchema = { $schema: DRAFT_2020_12, type: 'array', prefixItems: [{ type: 'string' }], items: false }
		expect(validateAdapterConfig(['green'], tupleSchema).ok).toBe(true)
		expect(validateAdapterConfig(['green', 2], tupleSchema).ok).toBe(false)
		expect(validateAdapterManifest({ ...adapter, configSchema: false }).ok).toBe(true)
		expect(validateAdapterConfig('any JSON value', true).ok).toBe(true)
		expect(validateAdapterConfig('any JSON value', false).ok).toBe(false)
		expect(validateResolvedAdapterSet([{ id: 'base', widgetTypes: ['Button'], rendererKeys: ['Button'], catalogKeys: ['Button'] }, { id: 'extension', widgetTypes: ['Button'], rendererKeys: [], catalogKeys: [] }]).ok).toBe(false)
	})

	it('validates keyed Flow steps, reachability, and the absence of alternate graph shapes', () => {
		const flow = {
			id: STEP_A, name: 'Checkout', entryStepId: STEP_A,
			steps: { [STEP_A]: { target: { viewId: VIEW_ID }, transitions: [] } },
		}
		expect(validateFlowResource(flow, `${STEP_A}.flow.json`).ok).toBe(true)
		const linked = {
			...flow,
			steps: {
				[STEP_A]: { target: { viewId: VIEW_ID }, transitions: [{ trigger: { widgetId: 'next', event: 'activate' }, targetStepId: STEP_B }] },
				[STEP_B]: { target: { viewId: VIEW_ID, variantName: 'Empty' }, transitions: [{ trigger: { widgetId: 'back', event: 'activate' }, targetStepId: STEP_A }] },
			},
		}
		expect(validateFlowResource(linked).ok).toBe(true)
		expect(validateFlowResource({ ...flow, transitions: [] }).ok).toBe(false)
		expect(validateFlowResource({ ...flow, entryStepId: STEP_B }).ok).toBe(false)
	})

	it('preserves Review identity, typed actors, submission history, and immutable evidence refs', () => {
		const open = { id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'submit' }, variantNames: [], status: 'open', messages: [], history: [], submissions: [] }
		expect(validateReviewThread(open, { ...REVIEW_V1, filename: `${REVIEW_ID}.review.json` }).ok).toBe(true)
		const ready = {
			...open, status: 'ready-for-review', submissions: [reviewSubmission],
			history: [{ id: HISTORY_ID, kind: 'lifecycle', from: 'open', to: 'ready-for-review', actor: { type: 'agent' }, at: TIME, submissionId: SUBMISSION_ID }],
		}
		expect(validateReviewThread(ready, REVIEW_V1).ok).toBe(true)
		expect(validateReviewThread({ ...ready, submissions: [{ ...reviewSubmission, evidenceRefs: [] }] }, REVIEW_V1).ok).toBe(false)
		expect(validateReviewThread({ ...open, submissions: [reviewSubmission] }, REVIEW_V1).diagnostics.some(item => item.code === 'review.orphan_submission')).toBe(true)
		expect(validateReviewThread({ ...ready, submissions: [] }, REVIEW_V1).ok).toBe(false)
		const secondTime = '2026-09-30T12:31:00Z'
		const secondSubmission = { ...reviewSubmission, id: STEP_B, at: secondTime }
		const twiceReady = {
			...open,
			status: 'ready-for-review',
			submissions: [reviewSubmission, secondSubmission],
			history: [
				{ id: HISTORY_ID, kind: 'lifecycle', from: 'open', to: 'ready-for-review', actor: { type: 'agent' }, at: TIME, submissionId: SUBMISSION_ID },
				{ id: ASSET_ID, kind: 'lifecycle', from: 'ready-for-review', to: 'open', actor: { type: 'agent' }, at: TIME },
				{ id: STEP_A, kind: 'lifecycle', from: 'open', to: 'ready-for-review', actor: { type: 'agent' }, at: secondTime, submissionId: STEP_B },
			],
		}
		expect(validateReviewThread(twiceReady, REVIEW_V1).ok).toBe(true)
		expect(validateReviewThread({ ...twiceReady, submissions: [secondSubmission, reviewSubmission] }, REVIEW_V1)
			.diagnostics.some(item => item.code === 'review.submission_history_mismatch')).toBe(true)
		const reusedSubmission = {
			...twiceReady,
			submissions: [reviewSubmission],
			history: twiceReady.history.map((event, index) =>
				index === 2 ? { ...event, submissionId: SUBMISSION_ID, at: TIME } : event),
		}
		expect(validateReviewThread(reusedSubmission, REVIEW_V1).diagnostics.some(item => item.code === 'review.submission_reused')).toBe(true)
		expect(validateReviewThread({ ...open, history: [{ id: HISTORY_ID, kind: 'lifecycle', from: 'resolved', to: 'open', actor: { type: 'human' }, at: TIME }] }, REVIEW_V1).ok).toBe(false)
		expect(validateReviewEvidenceRef({ kind: 'capture', evidence: 'not-a-digest' }).ok).toBe(false)
		const resolvedByAgent = {
			...ready, status: 'resolved',
			history: [{ id: HISTORY_ID, kind: 'lifecycle', from: 'ready-for-review', to: 'resolved', actor: { type: 'agent' }, at: TIME, submissionId: SUBMISSION_ID }],
		}
		expect(validateReviewThread(resolvedByAgent, REVIEW_V1).diagnostics.some(item => item.code === 'review.resolve_requires_human')).toBe(true)

		const reanchored = {
			...open,
			anchor: { viewId: VIEW_ID, widgetId: 'third' },
			history: [
				{ id: HISTORY_ID, kind: 'reanchor', actor: { type: 'human' }, at: TIME, before: { anchor: open.anchor, variantNames: [] }, after: { anchor: { viewId: VIEW_ID, widgetId: 'second' }, variantNames: [] } },
				{ id: STEP_A, kind: 'reanchor', actor: { type: 'human' }, at: TIME, before: { anchor: { viewId: VIEW_ID, widgetId: 'second' }, variantNames: [] }, after: { anchor: { viewId: VIEW_ID, widgetId: 'third' }, variantNames: [] } },
			],
		}
		expect(validateReviewThread(reanchored, REVIEW_V1).ok).toBe(true)
		const discontinuousReanchor = structuredClone(reanchored)
		discontinuousReanchor.history[1]!.before.anchor.widgetId = 'wrong'
		expect(validateReviewThread(discontinuousReanchor, REVIEW_V1).diagnostics.some(item => item.code === 'review.discontinuous_reanchor_history')).toBe(true)
	})

	it('validates authored asset identity, layout, binding shape, and explicit media capability', () => {
		const metadata = { id: ASSET_ID, name: 'Logo', contentFilename: 'logo.svg', mediaType: 'image/svg+xml' }
		const validAsset = validateAssetMetadata(metadata, ASSET_ID)
		expect(validAsset.ok).toBe(true)
		if (validAsset.ok) expect(validateAssetContentFiles(validAsset.value, ['logo.svg']).ok).toBe(true)
		expect(validateAssetMetadata(metadata, STEP_A).ok).toBe(false)
		expect(validateAssetContentFiles(metadata, ['logo.svg', 'copy.svg']).ok).toBe(false)
		expect(validateAssetBinding({ $asset: ASSET_ID }).ok).toBe(true)
		expect(validateAssetBinding({ $asset: 'Logo' }).ok).toBe(false)
		expect(validateAssetBindingCompatibility('image/svg+xml', undefined, { acceptedMediaTypes: ['image/svg+xml'] }).ok).toBe(true)
		expect(validateAssetBindingCompatibility('image/svg+xml', undefined, undefined).ok).toBe(false)
		expect(validateAssetContentMetadata(metadata, 'logo.svg', new TextEncoder().encode('<svg/>')).ok).toBe(true)
		expect(validateAssetContentMetadata(metadata, 'logo.svg', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).ok).toBe(false)
	})
})

describe('derived evidence, render context, and handoff', () => {
	it('uses SHA-256 bytes as immutable artifact identity', async () => {
		const bytes = new TextEncoder().encode('capture bytes')
		const identity = await sha256Identity(bytes)
		expect(validateArtifactIdentity(identity).ok).toBe(true)
		expect(await artifactBytesMatch(identity, bytes)).toBe(true)
		expect(await artifactBytesMatch(identity, new TextEncoder().encode('different bytes'))).toBe(false)
		const padded = Uint8Array.from([0, ...bytes, 0])
		expect(await sha256Identity(padded.subarray(1, -1))).toBe(identity)
		expect(await sha256Identity(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength))).toBe(identity)
		const hex = identity.slice('sha256:'.length)
		expect(artifactStoreShardPath(identity)).toBe(`sha256/${hex.slice(0, 2)}/${hex}`)
	})

	it('validates formal evidence responsibilities without turning warnings into corruption', () => {
		const record = {
			schemaVersion: 1, kind: 'translation', executionContext: { contexts: [context] }, coverage: { complete: false, missingOccurrences: 1 },
			provenance: { workspaceSchemaVersion: 1, resources: [{ identity: { type: 'view', id: VIEW_ID }, revision: 'r1' }], versions: { uiux: '0.1.0' } },
			artifactRefs: [DIGEST], evidenceRefs: [], data: { warning: 'missing translation' },
		}
		expect(validateFormalEvidenceRecord(record).ok).toBe(true)
		expect(validateFormalEvidenceRecord({ ...record, id: REVIEW_ID }).ok).toBe(false)
		const warningOccurrence = {
			occurrence: { warning: { code: 'unresolved-key', key: 'missing', requestedLocale: 'en-US' }, viewId: VIEW_ID, widgetId: 'title', resultProperty: 'titleResult', catalogField: 'title' },
			evaluatedText: '⟦missing:missing⟧', warnings: [{ code: 'unresolved-key', key: 'missing', requestedLocale: 'en-US' }],
		}
		expect(validateTranslationEvidenceOccurrence(warningOccurrence).ok).toBe(true)
	})

	it('requires an explicit, fully resolved render-context list with no fallback', () => {
		const registries = { locales: new Set(['en-US']), viewports: { desktop: { width: 1280, height: 800 } }, themes: new Set(['light']) }
		expect(validateResolvedRenderContext(context).ok).toBe(true)
		expect(validateResolvedRenderContext({ ...context, viewport: { width: 0, height: 0 } }).ok).toBe(true)
		expect(validateRenderContextSelection([context], registries).ok).toBe(true)
		expect(validateRenderContextSelection([{ ...context, themeId: 'missing' }], registries).ok).toBe(false)
		expect(validateRenderContextSelection([], registries).ok).toBe(false)
	})

	it('validates typed Handoff roots, provenance, closure readiness, and incremental diagnostics', () => {
		const roots = [{ type: 'view', viewId: VIEW_ID }]
		const manifest = {
			schemaVersion: 1, bundleIdentity: 'bundle-2026-09-30-a', exportedAt: TIME, roots,
			resources: [{ type: 'view', identity: { id: VIEW_ID }, revision: 'r1', snapshot: view }],
			artifactRefs: [{ kind: 'capture', artifact: DIGEST }], evidenceRefs: [{ kind: 'capture', evidence: DIGEST }],
			implementationReferences: [],
			provenance: { workspaceSchemaVersion: 1, scope: roots, resources: [{ identity: { id: VIEW_ID }, revision: 'r1' }], contexts: [context], versions: { uiux: '0.1.0' }, adapters: [] },
			readiness: { implementationReady: true, coverage: { validation: { complete: true }, evidence: { complete: true }, review: { reviewed: true } }, blockingDiagnostics: [] },
		}
		const structural = validateHandoffManifest(manifest)
		expect(structural.ok).toBe(true)
		expect(validateHandoffRoot({ type: 'feature', feature: 'checkout' }).ok).toBe(false)
		expect(validateHandoffRoot({ type: 'workspace', viewId: VIEW_ID }).ok).toBe(false)
		expect(validateHandoffManifest({ ...manifest, readiness: { ...manifest.readiness, blockingDiagnostics: [{ code: 'invalid', message: 'bad', blocking: true }] } }).ok).toBe(false)
		expect(validateHandoffManifest({ ...manifest, implementationReferences: [{ widgetType: 'Button', semanticSource: { availability: 'materialized', provenance: {}, contentDigest: DIGEST }, rendererSource: { availability: 'provenance-only', provenance: { package: '@deviltea/base', revision: '1', path: 'src/button.ts' } } }] }).ok).toBe(false)
		const incompleteAssessment = { rootsReadable: true, closureValid: true, requiredEvidenceComplete: false, reviewCoverageComplete: true, blockingDiagnostics: [] }
		expect(mayClaimImplementationReady(incompleteAssessment)).toBe(false)
		if (structural.ok)
			expect(validateImplementationReadyClaim(structural.value.readiness, incompleteAssessment).ok).toBe(false)
		const completeAssessment = { ...incompleteAssessment, requiredEvidenceComplete: true }
		expect(mayClaimImplementationReady(completeAssessment)).toBe(true)
		if (structural.ok)
			expect(validateImplementationReadyClaim(structural.value.readiness, completeAssessment).ok).toBe(true)
	})

	it('keeps optimistic-concurrency revisions in application envelopes', () => {
		expect(validateResourceRevision('opaque-content-revision').ok).toBe(true)
		expect(validateResourceRevision('').ok).toBe(false)
		expect(validateRevisionConflict({ code: 'revision_conflict', currentRevision: 'current-r2' }).ok).toBe(true)
	})
})

describe('Preview cross-iframe protocol', () => {
	it('validates explicit capability declare/ack envelopes and rejects malformed declarations', () => {
		const context = { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a' }
		expect(validateCapabilityMessage({ type: 'capability.declare', context, payload: { protocolVersion: 1, features: ['geometry', 'contour'] } }).ok).toBe(true)
		expect(validateCapabilityMessage({ type: 'capability.ack', context, payload: {} }).ok).toBe(true)
		expect(validateCapabilityMessage({ type: 'capability.declare', context, payload: { protocolVersion: 1.5, features: [] } }).ok).toBe(false)
		expect(validateCapabilityMessage({ type: 'capability.declare', context, payload: { protocolVersion: 1, features: ['geometry', 'geometry'] } }).diagnostics.some(item => item.code === 'protocol.duplicate_capability_feature')).toBe(true)
		expect(validateCapabilityMessage({ type: 'capability.ack', context, payload: { futureAdditiveField: 'ignored' } }).ok).toBe(true)
		expect(validateCapabilityMessage({ type: 'capability.ack', context: { ...context, futureNullableField: null }, payload: {} }).ok).toBe(true)
		expect(validateCapabilityMessage({ type: 'capability.ack', context: { previewSessionId: 'session-a' }, payload: {} }).ok).toBe(false)
	})

	it('validates the fully specified geometry and contour messages', () => {
		const messages = [
			{ type: 'geometry.acquire.request', context: acquisitionContext, payload: {} },
			{ type: 'geometry.acquire.response', context: protocolContext, payload: { rect: { x: 0, y: 0, width: 10, height: 10 }, regions: [] } },
			{ type: 'contour.full.request', context: protocolContext, payload: { sequence: 0, targetMaxError: 0.25 } },
			{ type: 'contour.full.response', context: protocolContext, payload: { sequence: 0, regions: [{ regionId: 'r-1', contour: square, maxError: 0 }] } },
			{ type: 'contour.partial.request', context: protocolContext, payload: { sequence: 1, baseSnapshotVersion: 0, regionIds: ['r-1'], targetMaxError: 0.25 } },
			{ type: 'contour.partial.response', context: protocolContext, payload: { sequence: 1, baseSnapshotVersion: 0, regions: [{ regionId: 'r-1', contour: square, maxError: 0.1 }] } },
			{ type: 'contour.cancel', context: protocolContext, payload: { sequence: 2 } },
		]
		for (const message of messages) expect(validateGeometryMessage(message).ok).toBe(true)
		const request = validateGeometryMessage(messages[4])
		const response = validateGeometryMessage(messages[5])
		expect(request.ok && response.ok && request.value.type === 'contour.partial.request' && response.value.type === 'contour.partial.response'
			? validatePartialResponseAgainstRequest(request.value as PartialContourRequest, response.value as PartialContourResponse).ok
			: false).toBe(true)
		expect(responseMeetsRequestedPrecision([{ regionId: 'r-1', contour: square, maxError: 0.3 }], 0.25)).toBe(false)
	})

	it('rejects malformed contour topology, duplicate IDs, unsafe sequence, and runtime-selected snapshot versions', () => {
		const bowtie: Contour = { commands: [
			{ op: 'moveTo', x: 0, y: 0 }, { op: 'lineTo', x: 10, y: 10 },
			{ op: 'lineTo', x: 0, y: 10 }, { op: 'lineTo', x: 10, y: 0 }, { op: 'close' },
		] }
		expect(validateGeometryMessage({ type: 'contour.full.response', context: protocolContext, payload: { sequence: Number.MAX_SAFE_INTEGER + 1, regions: [] } }).ok).toBe(false)
		expect(validateGeometryMessage({ type: 'contour.full.response', context: protocolContext, payload: { sequence: 1, snapshotVersion: 4, regions: [] } }).ok).toBe(false)
		expect(validateGeometryMessage({ type: 'geometry.acquire.response', context: protocolContext, payload: { rect: { x: 0, y: 0, width: 10, height: 10 }, regions: [{ regionId: 'r', contour: square, maxError: 0 }, { regionId: 'r', contour: square, maxError: 0 }] } }).ok).toBe(false)
		expect(validateGeometryMessage({ type: 'geometry.acquire.response', context: protocolContext, payload: { regions: [] } }).ok).toBe(false)
		expect(validateGeometryMessage({ type: 'geometry.acquire.response', context: protocolContext, payload: { rect: { x: 0, y: 0, width: -1, height: 10 }, regions: [] } }).diagnostics.some(item => item.code === 'protocol.invalid_widget_rect_extent')).toBe(true)
		expect(validateGeometryMessage({ type: 'contour.full.response', context: protocolContext, payload: { sequence: 1, regions: [{ regionId: 'r', contour: bowtie, maxError: 0 }] } }).ok).toBe(false)
		const cubicLoop: Contour = { commands: [
			{ op: 'moveTo', x: 0, y: 0 },
			{ op: 'cubicBezierTo', c1x: 2, c1y: 2, c2x: -1, c2y: 2, x: 1, y: 0 },
			{ op: 'close' },
		] }
		const curved: Contour = { commands: [
			{ op: 'moveTo', x: 0, y: 0 },
			{ op: 'cubicBezierTo', c1x: 10, c1y: 0, c2x: 10, c2y: 10, x: 0, y: 10 },
			{ op: 'close' },
		] }
		expect(validateGeometryMessage({ type: 'contour.full.response', context: protocolContext, payload: { sequence: 1, regions: [{ regionId: 'cubic-loop', contour: cubicLoop, maxError: 0 }] } }).ok).toBe(false)
		const curvedResult = validateGeometryMessage({ type: 'contour.full.response', context: protocolContext, payload: { sequence: 1, regions: [{ regionId: 'curved', contour: curved, maxError: 0 }] } })
		expect(curvedResult.ok, JSON.stringify(curvedResult)).toBe(true)
		const lineCrossesCubic: Contour = { commands: [
			{ op: 'moveTo', x: 0, y: 0 },
			{ op: 'lineTo', x: 10, y: 0 },
			{ op: 'lineTo', x: 10, y: 10 },
			{ op: 'cubicBezierTo', c1x: 8, c1y: -10, c2x: 2, c2y: -10, x: 0, y: 10 },
			{ op: 'close' },
		] }
		const cubicsCross: Contour = { commands: [
			{ op: 'moveTo', x: 0, y: 0 },
			{ op: 'cubicBezierTo', c1x: 0, c1y: 5, c2x: 5, c2y: 10, x: 10, y: 10 },
			{ op: 'lineTo', x: 10, y: 0 },
			{ op: 'cubicBezierTo', c1x: 8, c1y: 2, c2x: 2, c2y: 8, x: 0, y: 10 },
			{ op: 'close' },
		] }
		const bowtieWithCubic: Contour = { commands: [
			{ op: 'moveTo', x: 0, y: 0 },
			{ op: 'lineTo', x: 10, y: 10 },
			{ op: 'lineTo', x: 0, y: 10 },
			{ op: 'lineTo', x: 10, y: 0 },
			{ op: 'cubicBezierTo', c1x: 10, c1y: -2, c2x: 2, c2y: -5, x: 0, y: -5 },
			{ op: 'close' },
		] }
		const lineEquivalentCubics: Contour = { commands: [
			{ op: 'moveTo', x: 0, y: 0 },
			{ op: 'cubicBezierTo', c1x: 0, c1y: 0, c2x: 10, c2y: 0, x: 10, y: 0 },
			{ op: 'cubicBezierTo', c1x: 10, c1y: 0, c2x: 10, c2y: 10, x: 10, y: 10 },
			{ op: 'cubicBezierTo', c1x: 10, c1y: 10, c2x: 0, c2y: 10, x: 0, y: 10 },
			{ op: 'cubicBezierTo', c1x: 0, c1y: 10, c2x: 0, c2y: 0, x: 0, y: 0 },
			{ op: 'close' },
		] }
		const crossingLineEquivalentCubics: Contour = { commands: [
			{ op: 'moveTo', x: 0, y: 0 },
			{ op: 'cubicBezierTo', c1x: 0, c1y: 0, c2x: 10, c2y: 10, x: 10, y: 10 },
			{ op: 'cubicBezierTo', c1x: 10, c1y: 10, c2x: 0, c2y: 10, x: 0, y: 10 },
			{ op: 'cubicBezierTo', c1x: 0, c1y: 10, c2x: 10, c2y: 0, x: 10, y: 0 },
			{ op: 'cubicBezierTo', c1x: 10, c1y: 0, c2x: 0, c2y: 0, x: 0, y: 0 },
			{ op: 'close' },
		] }
		const lineEquivalentResult = validateGeometryMessage({
			type: 'contour.full.response',
			context: protocolContext,
			payload: { sequence: 1, regions: [{ regionId: 'line-equivalent', contour: lineEquivalentCubics, maxError: 0 }] },
		})
		expect(lineEquivalentResult.ok, JSON.stringify(lineEquivalentResult)).toBe(true)
		const crossingLineEquivalentResult = validateGeometryMessage({
			type: 'contour.full.response',
			context: protocolContext,
			payload: { sequence: 1, regions: [{ regionId: 'crossing-line-equivalent', contour: crossingLineEquivalentCubics, maxError: 0 }] },
		})
		expect(crossingLineEquivalentResult.diagnostics.some(item => item.code === 'protocol.self_intersecting_contour'),
			JSON.stringify(crossingLineEquivalentResult)).toBe(true)
		const validMultiCurve: Contour = { commands: [
			{ op: 'moveTo', x: 0, y: 0 },
			{ op: 'cubicBezierTo', c1x: 2, c1y: -3, c2x: 8, c2y: -3, x: 10, y: 0 },
			{ op: 'lineTo', x: 10, y: 10 },
			{ op: 'cubicBezierTo', c1x: 8, c1y: 13, c2x: 2, c2y: 13, x: 0, y: 10 },
			{ op: 'close' },
		] }
		for (const [regionId, contour] of [
			['line-cubic-cross', lineCrossesCubic],
			['cubic-cubic-cross', cubicsCross],
			['bowtie-with-cubic', bowtieWithCubic],
		] as const) {
			const result = validateGeometryMessage({
				type: 'contour.full.response',
				context: protocolContext,
				payload: { sequence: 1, regions: [{ regionId, contour, maxError: 0 }] },
			})
			expect(result.diagnostics.some(item => item.code === 'protocol.self_intersecting_contour'),
				JSON.stringify(result)).toBe(true)
		}
		const validMultiCurveResult = validateGeometryMessage({
			type: 'contour.full.response',
			context: protocolContext,
			payload: { sequence: 1, regions: [{ regionId: 'valid-multi-curve', contour: validMultiCurve, maxError: 0 }] },
		})
		expect(validMultiCurveResult.ok, JSON.stringify(validMultiCurveResult)).toBe(true)
		expect(validateGeometryMessage({ type: 'contour.full.request', context: { ...protocolContext, variantId: null }, payload: { sequence: 1, targetMaxError: 0.2 } }).ok).toBe(false)
		expect(validateGeometryMessage({ type: 'contour.full.request', context: protocolContext, payload: { sequence: 1, targetMaxError: 0.2 } }).ok).toBe(true)
	})

	it('accepts additive fields for known types and validates the closed failure categories', () => {
		expect(validateGeometryMessage({ type: 'geometry.acquire.request', context: { ...acquisitionContext, futureContext: 'x' }, payload: { futurePayload: 1 } }).ok).toBe(true)
		expect(validateGeometryMessage({ type: 'geometry.acquire.request', context: protocolContext, payload: {} }).ok).toBe(false)
		expect(validateGeometryMessage({ type: 'geometry.acquire.request', context: acquisitionContext, payload: {} }).ok).toBe(true)
		expect(validatePreviewFailureDiagnostic({ category: 'protocol', reason: 'protocol.invalid_message', detail: 'Invalid message.' }).ok).toBe(true)
		expect(validatePreviewFailureDiagnostic({ category: 'protocol', reason: 'runtime.unavailable' }).ok).toBe(false)
		const partialRequest = { type: 'contour.partial.request', context: protocolContext, payload: { sequence: 4, baseSnapshotVersion: 3, regionIds: ['r-1'], targetMaxError: 0.1 } }
		const partialResponse = { type: 'contour.partial.response', context: protocolContext, payload: { sequence: 4, baseSnapshotVersion: 2, regions: [{ regionId: 'r-2', contour: square, maxError: 0.1 }] } }
		const request = validateGeometryMessage(partialRequest)
		const response = validateGeometryMessage(partialResponse)
		expect(request.ok && response.ok && request.value.type === 'contour.partial.request' && response.value.type === 'contour.partial.response'
			? validatePartialResponseAgainstRequest(request.value as PartialContourRequest, response.value as PartialContourResponse).ok
			: true).toBe(false)
	})
})
