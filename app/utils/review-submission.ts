import type { CitableEvidenceEntry } from './readiness'

/**
 * A human "Submit for review…" (brief c, section 12; Part 1 / Part 7 submission rules): the
 * thread moves to `ready-for-review` with known change domains (Clause 01a14e30-2dce-…), the
 * anchored View at its current revision, and references to Evidence (Rule 01a11544-55b0-…): formal
 * captures of its current render input (IR and Variants), or a Run Checks record, a Flow trace or an
 * interaction replay. The declared kind is the record's own kind. The server validates every claim;
 * this only shapes the request.
 */
export type EvidenceCitation = Readonly<{ kind: string; evidence: string }>

export type ReviewSubmissionDraft = Readonly<{
	changeDomains: readonly string[]
	/** The cited Evidence records: each digest (`sha256:…`) with the kind the record has. */
	evidence: readonly EvidenceCitation[]
	reason?: string
}>

export function submissionBody(draft: ReviewSubmissionDraft, view: Readonly<{ key: string; revision: string }>, expectedRevision: string): Record<string, unknown> {
	const reason = draft.reason?.trim()
	return {
		expectedRevision,
		changeDomains: [...new Set(draft.changeDomains.map(domain => domain.trim()).filter(Boolean))],
		resources: [{ identity: { kind: 'view', key: view.key }, revision: view.revision }],
		evidenceRefs: [...new Map(draft.evidence.map(citation => [citation.evidence, citation])).values()].map(({ kind, evidence }) => ({ kind, evidence })),
		...(reason ? { reason } : {}),
	}
}

/** True when the draft states what the server requires: a domain and a piece of Evidence. */
export function isSubmittable(draft: ReviewSubmissionDraft): boolean {
	return draft.changeDomains.some(domain => domain.trim()) && draft.evidence.length > 0
}

/**
 * "Select current captures" and "Clear" act on the usable formal captures only: they add or remove
 * exactly those digests and leave every other tick (Run Checks, Flow trace, replay) as it is.
 */
export function withUsableSelection(selection: readonly string[], usable: readonly string[], on: boolean): string[] {
	const usableSet = new Set(usable)
	return on ? [...new Set([...selection, ...usable])] : selection.filter(digest => !usableSet.has(digest))
}

/**
 * Owner rulings 6 and 2026-10-27 of Discussion #241: the Evidence kind a change domain preselects in the picker.
 * A domain absent here preselects nothing.
 */
export const EVIDENCE_KIND_BY_CHANGE_DOMAIN: Readonly<Record<string, CitableEvidenceEntry['kind']>> = {
	i18n: 'checks_run',
	flow: 'flow_trace',
	interaction: 'interaction_replay',
}

/**
 * The records of the kind `domain` preselects: the latest Run Checks record (`entries` lists them newest
 * first), every Flow trace that is current, every interaction replay whose assertions all passed and that is current (Clause 01a17ac7-…). Only
 * a starting point: each can be unticked, and none is required.
 */
export function preselectedCitations(domain: string, entries: readonly CitableEvidenceEntry[]): readonly EvidenceCitation[] {
	const kind = EVIDENCE_KIND_BY_CHANGE_DOMAIN[domain]
	if (!kind) return []
	const ofKind = entries.filter(entry => entry.kind === kind)
	const picked = kind === 'checks_run'
		? ofKind.slice(0, 1)
		: kind === 'flow_trace'
			? ofKind.filter(entry => entry.freshness?.state === 'fresh')
			: ofKind.filter((entry) => {
					const assertions = (entry.record.data as { assertions?: readonly { result?: string }[] } | undefined)?.assertions ?? []
					return entry.freshness?.state === 'fresh' && assertions.length > 0 && assertions.every(assertion => assertion.result === 'pass')
				})
	return picked.map(entry => ({ kind: entry.kind, evidence: entry.digest }))
}
