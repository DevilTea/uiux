/**
 * A human "Submit for review…" (brief c, section 12; Part 1 / Part 7 submission rules): the
 * thread moves to `ready-for-review` with known change domains (Clause 01a14e30-2dce-…), the
 * anchored View at its current revision, and references to formal Evidence of its current render
 * input (IR and Variants). The server validates every claim; this only shapes the request.
 */
export type ReviewSubmissionDraft = Readonly<{
	changeDomains: readonly string[]
	/** Formal capture digests (`sha256:…`) of the anchored View. */
	evidence: readonly string[]
	reason?: string
}>

export function submissionBody(draft: ReviewSubmissionDraft, view: Readonly<{ key: string; revision: string }>, expectedRevision: string): Record<string, unknown> {
	const reason = draft.reason?.trim()
	return {
		expectedRevision,
		changeDomains: [...new Set(draft.changeDomains.map(domain => domain.trim()).filter(Boolean))],
		resources: [{ identity: { kind: 'view', key: view.key }, revision: view.revision }],
		evidenceRefs: [...new Set(draft.evidence)].map(evidence => ({ kind: 'formal_capture', evidence })),
		...(reason ? { reason } : {}),
	}
}

/** True when the draft states what the server requires: a domain and a piece of Evidence. */
export function isSubmittable(draft: ReviewSubmissionDraft): boolean {
	return draft.changeDomains.some(domain => domain.trim()) && draft.evidence.length > 0
}
