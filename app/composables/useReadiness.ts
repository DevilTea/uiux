import { computed, shallowRef, triggerRef } from 'vue'
import { useI18n } from '#imports'
import type { FormalEvidenceRecord } from '../../src/domain/evidence/schema'
import type { HandoffManifest, HandoffReadiness, HandoffReadinessAssessment, HandoffRoot } from '../../src/domain/handoff/schema'
import { describeFetchError, type FetchErrorDetails } from '../utils/fetch-error'
import {
	contextFromRecord,
	evidenceFreshness,
	type CaptureContext,
	type EvidenceFreshness,
} from '../utils/readiness'
import { useUiuxClient } from './useUiuxClient'
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

	async function loadEvidence(force = false): Promise<void> {
		if (evidenceLoaded.value && !force) return
		if (evidencePromise && !force) return evidencePromise
		evidenceLoading.value = true
		const run = uiux.listEvidence<EvidenceItem>()
			.then((items) => {
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
			})
		evidencePromise = run
		return run
	}

	const evidenceEntries = computed<readonly EvidenceEntry[]>(() => {
		const stalenessContext = {
			allViews: views.value.map(view => ({ key: view.key, revision: view.revision })),
			workspace: workspace.value,
			discoveredLocales: discoveredLocales.value,
			localeRevisions: localeRevisions.value,
		}
		return evidenceItems.value.map((item) => {
			const context = contextFromRecord(item.record)
			return {
				digest: item.digest,
				record: item.record,
				...(context ? { context } : {}),
				freshness: evidenceFreshness(item.record, stalenessContext),
			}
		})
	})

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
		// loads, so callers ask again) rather than risk a request an older schema would refuse.
		if (!workspace.value) {
			const pending: AssessmentEntry = { status: 'loading', signature: expected }
			setAssessment(key, pending)
			return pending
		}
		// The server refuses Handoff for an older schema (`422 workspace.migration_required`): say why
		// instead of sending a request that can only fail.
		if (writeBlocked.value) {
			const blocked: AssessmentEntry = { status: 'failed', signature: expected, error: { message: t('handoff.migrationBlocked'), diagnostics: [] } }
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
