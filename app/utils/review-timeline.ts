import {
	messageEditedAt,
	type ReviewActor,
	type ReviewAnchor,
	type ReviewEvidenceRef,
	type ReviewMessageEdit,
	type ReviewResolution,
	type ReviewThread,
} from '../../src/domain/reviews/schema'

/**
 * The one chronological timeline of a Review thread (Part 7 10b): messages, submissions,
 * re-anchors and lifecycle events, interleaved by their authoritative timestamps. It is a
 * projection only; nothing is ever written back as message text.
 *
 * Ready-for-review lifecycle events are carried by their submission item (they share its time
 * and actor), so they are not repeated. A non-verified close straight from ready-for-review
 * marks the pending submission "Not accepted" (direct-resolve decision 4).
 */
export type ReviewTimelineItem =
	| Readonly<{
		kind: 'message'
		id: string
		at: string
		actor: ReviewActor
		/** The current text. */
		body: string
		/** Earlier versions, oldest first (append-only); empty when never edited. */
		edits: readonly ReviewMessageEdit[]
		/** Derived from `edits[]`: when the text last changed. An edit keeps the message's position. */
		editedAt?: string
	}>
	| Readonly<{
		kind: 'submission'
		id: string
		at: string
		actor: ReviewActor
		domains: readonly string[]
		evidence: readonly ReviewEvidenceRef[]
		/** The active ready-for-review submission. */
		current: boolean
		/** A later verified resolution accepted it. */
		accepted: boolean
		/** A non-verified resolution closed the thread while it was pending. */
		notAccepted: boolean
	}>
	| Readonly<{ kind: 'resolved'; id: string; at: string; actor: ReviewActor; resolution: ReviewResolution; submissionId?: string; reason?: string }>
	| Readonly<{ kind: 'reopened'; id: string; at: string; actor: ReviewActor; reason?: string }>
	| Readonly<{
		kind: 'reanchored'
		id: string
		at: string
		actor: ReviewActor
		from: ReviewAnchor
		to: ReviewAnchor
		fromScope: readonly string[]
		toScope: readonly string[]
		reason?: string
	}>

export type ReviewTimelineKind = ReviewTimelineItem['kind']

/** A resolve event's kind; schema v1 events (before the migration) carried a submission only. */
export function eventResolution(event: Readonly<{ resolution?: ReviewResolution; submissionId?: string }>): ReviewResolution {
	return event.resolution ?? (event.submissionId ? 'verified' : 'answered')
}

function time(at: string): number {
	const value = Date.parse(at)
	return Number.isNaN(value) ? 0 : value
}

export function buildReviewTimeline(thread: ReviewThread): readonly ReviewTimelineItem[] {
	const accepted = new Set<string>()
	const declined = new Set<string>()
	let pending: string | undefined
	for (const event of thread.history) {
		if (event.kind !== 'lifecycle') continue
		if (event.to === 'ready-for-review') pending = event.submissionId
		else if (event.to === 'resolved') {
			const resolution = eventResolution(event)
			if (resolution === 'verified' && event.submissionId) accepted.add(event.submissionId)
			else if (event.from === 'ready-for-review' && pending) declined.add(pending)
			pending = undefined
		}
		else pending = undefined
	}
	const lastSubmission = thread.submissions.at(-1)

	const items: ReviewTimelineItem[] = []
	for (const message of thread.messages) {
		const editedAt = messageEditedAt(message)
		items.push({ kind: 'message', id: message.id, at: message.at, actor: message.actor, body: message.body, edits: message.edits ?? [], ...(editedAt ? { editedAt } : {}) })
	}
	for (const submission of thread.submissions) {
		items.push({
			kind: 'submission',
			id: submission.id,
			at: submission.at,
			actor: submission.actor,
			domains: submission.changeDomains,
			evidence: submission.evidenceRefs,
			current: thread.status === 'ready-for-review' && submission.id === lastSubmission?.id,
			accepted: accepted.has(submission.id),
			notAccepted: declined.has(submission.id),
		})
	}
	for (const event of thread.history) {
		if (event.kind === 'reanchor' && event.before && event.after) {
			items.push({
				kind: 'reanchored',
				id: event.id,
				at: event.at,
				actor: event.actor,
				from: event.before.anchor,
				to: event.after.anchor,
				fromScope: event.before.variantNames,
				toScope: event.after.variantNames,
				...(event.reason ? { reason: event.reason } : {}),
			})
		}
		else if (event.kind === 'lifecycle' && event.to === 'resolved') {
			items.push({
				kind: 'resolved',
				id: event.id,
				at: event.at,
				actor: event.actor,
				resolution: eventResolution(event),
				...(event.submissionId ? { submissionId: event.submissionId } : {}),
				...(event.reason ? { reason: event.reason } : {}),
			})
		}
		else if (event.kind === 'lifecycle' && event.to === 'open' && event.from)
			items.push({ kind: 'reopened', id: event.id, at: event.at, actor: event.actor, ...(event.reason ? { reason: event.reason } : {}) })
	}
	// Array.prototype.sort is stable: equal timestamps keep messages, submissions, then history.
	return items.sort((a, b) => time(a.at) - time(b.at))
}

/** The newest item's actor: who moved the thread last. A message edit counts (it is activity). */
export function latestTimelineActor(thread: ReviewThread): ReviewActor | undefined {
	const items = buildReviewTimeline(thread)
	let latest = items.at(-1) ? { actor: items.at(-1)!.actor, at: time(items.at(-1)!.at) } : undefined
	for (const item of items) {
		if (item.kind !== 'message') continue
		for (const edit of item.edits) if (!latest || time(edit.at) >= latest.at) latest = { actor: edit.actor, at: time(edit.at) }
	}
	return latest?.actor
}

/** Earlier versions of a message, newest first, each with the time it was replaced (Edit history). */
export function messageVersions(item: Readonly<{ at: string; body: string; edits: readonly ReviewMessageEdit[] }>): readonly Readonly<{ body: string; at: string; current: boolean }>[] {
	// Version i was written at the message time (i = 0) or at the edit that produced it.
	const versions = item.edits.map((edit, index) => ({ body: edit.previousBody, at: index === 0 ? item.at : item.edits[index - 1]!.at, current: false }))
	versions.push({ body: item.body, at: item.edits.at(-1)?.at ?? item.at, current: true })
	return versions.reverse()
}
