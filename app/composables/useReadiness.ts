import { computed, shallowRef, triggerRef, watch } from 'vue'
import { useI18n } from '#imports'
import type { EvidenceAdapterProvenance } from '../../src/domain/evidence/adapter-provenance'
import type { FormalEvidenceRecord } from '../../src/domain/evidence/schema'
import type { HandoffManifest, HandoffReadiness, HandoffReadinessAssessment, HandoffRoot } from '../../src/domain/handoff/schema'
import type { ProductKitProvenance } from '../../src/domain/product-kit/provenance'
import { describeFetchError, type FetchErrorDetails } from '../utils/fetch-error'
import {
	contextFromRecord,
	evidenceFreshness,
	flowTraceEntersView,
	flowTraceFreshness,
	CITABLE_EVIDENCE_KINDS,
	type CitableEvidenceEntry,
	type CitableEvidenceKind,
	unchangedSinceCapture,
	type CaptureContext,
	type EvidenceFreshness,
} from '../utils/readiness'
import { useUiuxClient, type EvidenceFlowInput, type EvidenceViewRenderInput } from './useUiuxClient'
import { useWorkbench } from './useWorkbench'

/**
 * Shared readiness data for the Overview and a View's Readiness tab (brief f): the formal
 * Evidence list with per-record freshness, Handoff assessments per root (cached against the
 * current resource revisions), formal capture of one explicit context, and Handoff export.
 * The server is the authority for every claim; this only fetches, caches and labels.
 */

export type EvidenceItem = Readonly<{ digest: string; record: FormalEvidenceRecord }>

export type EvidenceEntry = Readonly<{
	digest: string
	record: FormalEvidenceRecord
	context?: CaptureContext
	freshness: EvidenceFreshness
}>

export type AssessmentEntry = Readonly<{
	status: 'loading' | 'ok' | 'failed'
	/** The resource revisions the entry was computed against. */
	signature: string
	readiness?: HandoffReadiness
	assessment?: HandoffReadinessAssessment
	error?: FetchErrorDetails
}>

export type CaptureOutcome = Readonly<{
	status: 'captured' | 'failed'
	evidenceDigest?: string
	error?: FetchErrorDetails
}>

export type ExportOutcome = Readonly<{
	status: 'exported' | 'failed'
	manifest?: HandoffManifest
	manifestArtifactDigest?: string
	bundleIdentity?: string
	readiness?: HandoffReadiness
	error?: FetchErrorDetails
}>

type AssessResponse = Readonly<{
	status: string
	readiness?: HandoffReadiness
	assessment?: HandoffReadinessAssessment
	diagnostics?: readonly Readonly<{ code?: string; path?: string; message: string }>[]
}>

type CaptureResponse = Readonly<{
	status: 'ok' | 'incomplete' | 'failed' | 'blocked'
	results?: readonly Readonly<{ status: 'captured' | 'failed'; evidenceDigest?: string }>[]
}>

// Module state: one Workbench per document, shared by the Overview and the right panel.
const evidenceItems = shallowRef<readonly EvidenceItem[]>([])
/**
 * The current Product Kit provenance, read with the Evidence list: `productKit`, or
 * `productKitUnavailable` when it cannot be computed.
 */
const currentProductKit = shallowRef<Readonly<{ productKit?: ProductKitProvenance; productKitUnavailable?: boolean }>>({})
/**
 * The current Adapter provenance, read with the Evidence list: `adapters`, every Adapter of the
 * active set in Adapter-list order, or `adaptersUnavailable` when it cannot be computed.
 */
const currentAdapters = shallowRef<Readonly<{ adapters?: readonly EvidenceAdapterProvenance[]; adaptersUnavailable?: boolean }>>({})
/**
 * Each View's current render-input digest, read with the Evidence list, by View key (Rule
 * 01a115cd-c5a5-…: the View condition compares it, not the View revision).
 */
const viewRenderInputs = shallowRef<ReadonlyMap<string, EvidenceViewRenderInput>>(new Map())
/**
 * Each Flow's current Flow input digest, read with the Evidence list, by Flow key (Rule
 * 01a1814f-8256-…: a trace is judged by it, not by the Flow revision).
 */
const flowInputs = shallowRef<ReadonlyMap<string, EvidenceFlowInput>>(new Map())
/** The non-capture Evidence records a submission may cite, read when the Submit for review dialog opens. */
const citableItems = shallowRef<readonly EvidenceItem[]>([])
const citableLoading = shallowRef(false)
const citableError = shallowRef<FetchErrorDetails>()
let citableSerial = 0
const evidenceLoaded = shallowRef(false)
const evidenceLoading = shallowRef(false)
const evidenceError = shallowRef<FetchErrorDetails>()
let evidencePromise: Promise<void> | undefined

const assessments = shallowRef(new Map<string, AssessmentEntry>())
const MAX_CONCURRENT_ASSESSMENTS = 2
let runningAssessments = 0
const assessmentQueue: (() => void)[] = []

/** `uiux.workbench.lastSeen`: View key → revision when this browser last opened it. */
const LAST_SEEN_KEY = 'uiux.workbench.lastSeen'
const lastSeen = shallowRef<Readonly<Record<string, string>>>(readLastSeen())

function readLastSeen(): Record<string, string> {
	try {
		const parsed = JSON.parse(globalThis.localStorage?.getItem(LAST_SEEN_KEY) ?? '{}') as unknown
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {}
	}
	catch { return {} }
}

export function rootKey(roots: readonly HandoffRoot[]): string {
	return roots.map((root) => {
		if (root.type === 'workspace') return 'workspace'
		if (root.type === 'view') return `view:${root.viewId}`
		if (root.type === 'flow') return `flow:${root.flowId}`
		return `asset:${root.assetId}`
	}).sort().join('|')
}

function setAssessment(key: string, entry: AssessmentEntry): void {
	assessments.value.set(key, entry)
	triggerRef(assessments)
}

async function limited<T>(task: () => Promise<T>): Promise<T> {
	if (runningAssessments >= MAX_CONCURRENT_ASSESSMENTS)
		await new Promise<void>(resolve => assessmentQueue.push(resolve))
	runningAssessments += 1
	try { return await task() }
	finally {
		runningAssessments -= 1
		assessmentQueue.shift()?.()
	}
}

export function useReadiness() {
	const uiux = useUiuxClient()
	const workbench = useWorkbench()
	const { t } = useI18n()
	const { views, reviews, workspace, discoveredLocales, localeRevisions, flows, writeBlocked } = workbench

	/** Revisions every assessment depends on; any change makes cached entries stale. */
	const signature = computed(() => [
		workspace.value?.revision ?? '',
		...views.value.map(view => `${view.key}@${view.revision}`),
		...flows.value.map(flow => `${flow.key}@${flow.revision}`),
		...reviews.value.map(review => `${review.key}@${review.revision}`),
		...Object.entries(localeRevisions.value).map(([key, revision]) => `${key}@${revision}`),
		`evidence:${evidenceItems.value.length}`,
	].join(','))

	// ----- Evidence --------------------------------------------------------------------------

	function viewSignature(): string {
		return [...views.value.map(view => `${view.key}@${view.revision}`), ...flows.value.map(flow => `flow:${flow.key}@${flow.revision}`)].join(',')
	}

	async function loadEvidence(force = false): Promise<void> {
		if (evidenceLoaded.value && !force) return
		if (evidencePromise && !force) return evidencePromise
		evidenceLoading.value = true
		const startedWith = viewSignature()
		const run = uiux.listEvidenceForFreshness<EvidenceItem, ProductKitProvenance>()
			.then(({ items, views: inputs, flows: flowDigests, productKit, productKitUnavailable, adapters, adaptersUnavailable }) => {
				currentProductKit.value = { ...(productKit ? { productKit } : {}), ...(productKitUnavailable === true ? { productKitUnavailable } : {}) }
				currentAdapters.value = { ...(adapters ? { adapters } : {}), ...(adaptersUnavailable === true ? { adaptersUnavailable } : {}) }
				viewRenderInputs.value = new Map((inputs ?? []).map(input => [input.key, input]))
				flowInputs.value = new Map((flowDigests ?? []).map(input => [input.key, input]))
				evidenceItems.value = (items ?? []).filter(item => item?.record?.kind === 'formal_capture')
				evidenceError.value = undefined
			})
			.catch((cause: unknown) => {
				evidenceError.value = describeFetchError(cause, t('evidence.loadFailed'))
			})
			.finally(() => {
				evidenceLoaded.value = true
				evidenceLoading.value = false
				if (evidencePromise === run) evidencePromise = undefined
				// A View edited while this read was in flight is not in its digests: read once more.
				// Each pass snapshots the signature it started with, so this ends once Views stop changing.
				if (!evidencePromise && viewSignature() !== startedWith) void loadEvidence(true)
			})
		evidencePromise = run
		return run
	}

	/**
	 * A View edited since the Evidence list was read has a newer revision than its digest: read the
	 * list again, so the View condition compares the current render-input digest.
	 */
	watch(viewSignature, () => {
		if (!evidenceLoaded.value || evidencePromise) return
		const inputs = viewRenderInputs.value
		const digests = flowInputs.value
		if (views.value.every(view => inputs.get(view.key)?.revision === view.revision) && flows.value.every(flow => digests.get(flow.key)?.revision === flow.revision)) return
		void loadEvidence(true)
	})

	const stalenessContext = computed(() => {
		const inputs = viewRenderInputs.value
		const allViews = views.value.flatMap((view) => {
			const input = inputs.get(view.key)
			return input ? [{ key: view.key, renderInputDigest: input.renderInputDigest }] : []
		})
		return {
			allViews,
			workspace: workspace.value,
			discoveredLocales: discoveredLocales.value,
			localeRevisions: localeRevisions.value,
			...currentProductKit.value,
			...currentAdapters.value,
		}
	})

	const evidenceEntries = computed<readonly EvidenceEntry[]>(() => {
		const inputs = viewRenderInputs.value
		const revisions = new Map(views.value.map(view => [view.key, view.revision]))
		const baseContext = stalenessContext.value
		return evidenceItems.value.map((item) => {
			const context = contextFromRecord(item.record)
			return {
				digest: item.digest,
				record: item.record,
				...(context ? { context } : {}),
				freshness: evidenceFreshness(item.record, unchangedSinceCapture(item.record, inputs, revisions, baseContext)),
			}
		})
	})

	/** Reads the `checks_run`, `flow_trace` and `interaction_replay` records the Submit for review picker lists. */
	async function loadCitableEvidence(): Promise<void> {
		// Only the latest request is read: an earlier one answering late is ignored.
		const serial = ++citableSerial
		citableLoading.value = true
		try {
			const { items, flows: flowDigests } = await uiux.listEvidenceOfKinds<EvidenceItem>(CITABLE_EVIDENCE_KINDS)
			if (serial !== citableSerial) return
			// A listed trace is judged by the Flow input digests that arrive with it, so it never waits for the freshness list.
			if (flowDigests) flowInputs.value = new Map(flowDigests.map(input => [input.key, input]))
			citableItems.value = items.filter(item => CITABLE_EVIDENCE_KINDS.includes(item?.record?.kind as CitableEvidenceKind))
			citableError.value = undefined
		}
		catch (cause) {
			if (serial !== citableSerial) return
			citableItems.value = []
			citableError.value = describeFetchError(cause, t('submit.citableLoadFailed'))
		}
		finally { if (serial === citableSerial) citableLoading.value = false }
	}

	/**
	 * The citable records for one View, by kind: every `checks_run` run (newest first by `ranAt`, a
	 * point-in-time record with no currency), every `flow_trace` with its freshness (by name, never
	 * refused as stale), and the `interaction_replay` records of this View, each with its freshness too.
	 */
	function citableEvidenceForView(viewId: string | undefined): readonly CitableEvidenceEntry[] {
		if (!viewId) return []
		const ranAt = (record: FormalEvidenceRecord) => String((record.executionContext as Record<string, unknown>)?.ranAt ?? '')
		const captures = new Map(evidenceItems.value.map(item => [item.digest, item.record]))
		const traceContext = { ...stalenessContext.value, flows: flows.value.flatMap(flow => flowInputs.value.has(flow.key) ? [{ key: flow.key, flowInputDigest: flowInputs.value.get(flow.key)!.flowInputDigest }] : []), captures }
		const inputs = viewRenderInputs.value
		const revisions = new Map(views.value.map(view => [view.key, view.revision]))
		const entries: CitableEvidenceEntry[] = []
		for (const item of citableItems.value) {
			const kind = item.record.kind as CitableEvidenceKind
			if (kind === 'interaction_replay' && (item.record.executionContext as Record<string, unknown>)?.viewId !== viewId) continue
			// A Flow trace is offered for a View its Flow enters.
			if (kind === 'flow_trace' && !flowTraceEntersView(item.record, viewId)) continue
			// A replay copies the context and provenance of its capture, so it is judged as a capture is (Clause 01a14e30-2e43-…).
			const freshness = kind === 'flow_trace'
				? flowTraceFreshness(item.record, traceContext)
				: kind === 'interaction_replay'
					? evidenceFreshness(item.record, unchangedSinceCapture(item.record, inputs, revisions, stalenessContext.value))
					: undefined
			entries.push({ kind, digest: item.digest, record: item.record, ...(freshness ? { freshness } : {}) })
		}
		const rank = (entry: CitableEvidenceEntry) => CITABLE_EVIDENCE_KINDS.indexOf(entry.kind)
		return entries.sort((a, b) => rank(a) - rank(b)
			|| (a.kind === 'checks_run' ? ranAt(b.record).localeCompare(ranAt(a.record)) : 0)
			|| a.digest.localeCompare(b.digest))
	}

	function evidenceForView(viewId: string | undefined): readonly EvidenceEntry[] {
		if (!viewId) return []
		return evidenceEntries.value.filter(entry => (entry.record.executionContext as Record<string, unknown>)?.viewId === viewId)
	}

	function evidenceSummary(viewId: string): Readonly<{ total: number; fresh: number; stale: number; unknown: number }> {
		const entries = evidenceForView(viewId)
		return {
			total: entries.length,
			fresh: entries.filter(entry => entry.freshness.state === 'fresh').length,
			stale: entries.filter(entry => entry.freshness.state === 'stale').length,
			unknown: entries.filter(entry => entry.freshness.state === 'unknown').length,
		}
	}

	// ----- Handoff assessment ----------------------------------------------------------------

	async function fetchAssessment(roots: readonly HandoffRoot[], expected: string): Promise<AssessmentEntry> {
		try {
			const response = await limited(() => uiux.assessHandoff<AssessResponse>(roots))
			if (response.status === 'ok' && response.readiness)
				return { status: 'ok', signature: expected, readiness: response.readiness, ...(response.assessment ? { assessment: response.assessment } : {}) }
			return { status: 'failed', signature: expected, error: describeFetchError({ data: response }, t('handoff.assessFailed')) }
		}
		catch (cause) {
			return { status: 'failed', signature: expected, error: describeFetchError(cause, t('handoff.assessFailed')) }
		}
	}

	/** Assesses explicit roots, reusing a result computed against the same revisions. */
	async function assess(roots: readonly HandoffRoot[], options: Readonly<{ force?: boolean }> = {}): Promise<AssessmentEntry> {
		const key = rootKey(roots)
		const expected = signature.value
		const cached = assessments.value.get(key)
		if (cached && cached.signature === expected && !options.force && cached.status !== 'failed') return cached
		if (!roots.length) {
			const empty: AssessmentEntry = { status: 'failed', signature: expected, error: { message: t('handoff.selectRoot'), diagnostics: [] } }
			setAssessment(key, empty)
			return empty
		}
		// Until the Workspace is read, its schema state is unknown: wait (the signature changes once it
		// loads, so callers ask again) rather than risk a request an unsupported schema would refuse.
		if (!workspace.value) {
			const pending: AssessmentEntry = { status: 'loading', signature: expected }
			setAssessment(key, pending)
			return pending
		}
		// The server refuses Handoff for an unsupported schema (`422 workspace.schema_unsupported`): say
		// why instead of sending a request that can only fail.
		if (writeBlocked.value) {
			const blocked: AssessmentEntry = { status: 'failed', signature: expected, error: { message: t('handoff.unsupportedBlocked'), diagnostics: [] } }
			setAssessment(key, blocked)
			return blocked
		}
		setAssessment(key, { ...(cached ?? {}), status: 'loading', signature: expected })
		const entry = await fetchAssessment(roots, expected)
		setAssessment(key, entry)
		return entry
	}

	/** Per-View readiness: the readiness check run with that View as the only root (Part 1). */
	async function assessView(viewId: string, options: Readonly<{ force?: boolean }> = {}): Promise<AssessmentEntry> {
		return assess([{ type: 'view', viewId }], options)
	}

	/** The cached View assessment, without triggering a request. */
	function viewAssessment(viewId: string): AssessmentEntry | undefined {
		return assessments.value.get(rootKey([{ type: 'view', viewId }]))
	}

	function assessmentFor(roots: readonly HandoffRoot[]): AssessmentEntry | undefined {
		return assessments.value.get(rootKey(roots))
	}

	/** True when a cached entry was computed against older revisions. */
	function isOutdated(entry: AssessmentEntry | undefined): boolean {
		return !entry || entry.signature !== signature.value
	}

	// ----- Capture and export (Editor and above; the server is the authority) ------------------

	/** Captures exactly one resolved context. Callers run their explicit list one context at a time. */
	async function captureContext(context: CaptureContext): Promise<CaptureOutcome> {
		try {
			// 200 → ok, 207 → incomplete (resolves), 403/422 → throws with the result body.
			const response = await $fetch<CaptureResponse>('/api/evidence/capture', { method: 'POST', body: { contexts: [context] } })
			const result = response.results?.[0]
			if (response.status === 'ok' && result?.status === 'captured')
				return { status: 'captured', ...(result.evidenceDigest ? { evidenceDigest: result.evidenceDigest } : {}) }
			return { status: 'failed', error: describeFetchError({ data: response }, t('evidence.result.failed')) }
		}
		catch (cause) {
			return { status: 'failed', error: describeFetchError(cause, t('evidence.result.failed')) }
		}
	}

	async function exportHandoff(roots: readonly HandoffRoot[]): Promise<ExportOutcome> {
		try {
			const response = await $fetch<ExportOutcome & { diagnostics?: unknown }>('/api/handoff/export', { method: 'POST', body: { roots } })
			if (response.status === 'exported') return response
			return { status: 'failed', error: describeFetchError({ data: response }, t('handoff.exportFailed')) }
		}
		catch (cause) {
			return { status: 'failed', error: describeFetchError(cause, t('handoff.exportFailed')) }
		}
	}

	// ----- "Updated since you last looked" ---------------------------------------------------

	function markSeen(key: string, revision: string): void {
		if (lastSeen.value[key] === revision) return
		const next = { ...lastSeen.value, [key]: revision }
		lastSeen.value = next
		try { globalThis.localStorage?.setItem(LAST_SEEN_KEY, JSON.stringify(next)) }
		catch { /* storage unavailable: only the marker is lost */ }
	}

	return {
		evidenceItems,
		evidenceEntries,
		evidenceLoaded,
		evidenceLoading,
		evidenceError,
		loadEvidence,
		loadCitableEvidence,
		citableLoading,
		citableError,
		citableEvidenceForView,
		evidenceForView,
		evidenceSummary,
		signature,
		assess,
		assessView,
		viewAssessment,
		assessmentFor,
		isOutdated,
		captureContext,
		exportHandoff,
		lastSeen,
		markSeen,
	}
}

export type Readiness = ReturnType<typeof useReadiness>
