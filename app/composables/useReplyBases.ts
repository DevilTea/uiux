import { shallowReactive, watch, type Ref } from 'vue'

import { replyConflictChange, threadState, type ReplyConflictChange, type ThreadState } from '../utils/reply-conflict'

/** The thread a reply draft was written against: its revision and what it looked like then. */
export type ReplyBase = Readonly<{ revision: string; state: ThreadState }>

/**
 * Pins each reply draft to the thread revision it started from. With live refresh a thread is
 * re-read while the user writes, and a reply must not silently apply to a thread that changed
 * underneath it (Rule 01a11485-f451-72eb-81ad-686aeec7b3eb): the reply is sent against the pinned
 * revision, so a change made meanwhile refuses it as a conflict, the alert says what changed since
 * the draft started, and Send again acts on the new revision (Rule 01a116f0-95fc-77c6-a7ab-1318cb6d19af).
 * A draft emptied, sent or refused drops its pin; the next keystroke pins the thread as shown then.
 *
 * When the thread changes elsewhere while the draft is open, the draft stays pinned and `updated`
 * says what changed since, for the "updated by others" notice above the composer; only
 * `acknowledge` moves the pin to the revision shown now (Rule 01a11485-f434-75ed-ab0a-e321468c8407).
 */
export function useReplyBases(
	drafts: Ref<Record<string, string>>,
	thread: (threadId: string) => (ThreadState & Readonly<{ revision: string }>) | undefined,
) {
	const bases = shallowReactive(new Map<string, ReplyBase>())
	const pinNow = (threadId: string): void => {
		const item = thread(threadId)
		if (item) bases.set(threadId, { revision: item.revision, state: threadState(item) })
	}
	/** Own writes whose re-read has not applied yet: the pin moves in the same tick the new revision shows. */
	const pending = shallowReactive(new Map<string, Readonly<{ from: string; to: string }>>())
	const settleOwn = (threadId: string): void => {
		const move = pending.get(threadId)
		const shown = thread(threadId)?.revision
		if (!move || shown === move.from) return
		pending.delete(threadId)
		if (shown === move.to && bases.get(threadId)?.revision === move.from) pinNow(threadId)
	}
	watch(() => [...pending.keys()].map(id => thread(id)?.revision), () => {
		for (const threadId of [...pending.keys()]) settleOwn(threadId)
	}, { flush: 'sync' })
	watch(drafts, (current) => {
		for (const threadId of [...bases.keys()]) if (!current[threadId]?.trim()) bases.delete(threadId)
		for (const [threadId, text] of Object.entries(current)) {
			if (!text.trim() || bases.has(threadId)) continue
			pinNow(threadId)
		}
	}, { deep: true, flush: 'sync', immediate: true })
	return {
		/** The pin of a thread's draft, if it has one. */
		get: (threadId: string): ReplyBase | undefined => bases.get(threadId),
		/** Drops the pin, after a conflict: the user acts again on the thread as it is now. */
		release: (threadId: string): void => { bases.delete(threadId) },
		/**
		 * What changed since the draft was pinned, while the thread shown is at another revision;
		 * `undefined` while it is not (or there is no draft). Reactive.
		 */
		updated(threadId: string): ReplyConflictChange | undefined {
			const base = bases.get(threadId)
			const item = base ? thread(threadId) : undefined
			return base && item && item.revision !== base.revision ? replyConflictChange(base.state, threadState(item)) : undefined
		},
		/** The user acknowledged the notice: the draft is now aimed at the thread as shown. */
		acknowledge(threadId: string): void {
			if (bases.has(threadId)) pinNow(threadId)
		},
		/**
		 * The member's own write moved the thread from `from` to `to` while a draft was pinned on
		 * `from`: not a change by others, so the pin follows it. Call it before the re-read: the pin
		 * moves as the thread shown reaches `to`, so no notice shows in between.
		 */
		follow(threadId: string, from: string, to: string | undefined): void {
			if (to === undefined || bases.get(threadId)?.revision !== from) return
			pending.set(threadId, { from, to })
			settleOwn(threadId)
		},
		/** The re-read is over: a move that never showed (the re-read failed) is dropped. */
		settle(threadId: string): void { pending.delete(threadId) },
	}
}

/**
 * The thread revision one open action step was started on: a reason step, the Promote or Submit
 * dialog, or a message being edited. Live refresh re-reads the thread while the step is open, and
 * the step must not silently apply to a thread that changed meanwhile (Rule
 * 01a11485-f451-72eb-81ad-686aeec7b3eb): its write carries the pinned revision, so a change made
 * elsewhere refuses it as a conflict; after the conflict the step is pinned again to the thread as
 * re-read and shown, and the user acts again.
 */
export function createRevisionPin(revisionOf: (threadId: string) => string | undefined) {
	let pin: Readonly<{ threadId: string; revision: string }> | undefined
	return {
		/** Pins the thread's revision as shown now. */
		pin(threadId: string | undefined): void {
			const revision = threadId === undefined ? undefined : revisionOf(threadId)
			pin = threadId !== undefined && revision !== undefined ? { threadId, revision } : undefined
		},
		/** The pinned revision when the step is for `threadId`. */
		get(threadId: string): string | undefined {
			return pin?.threadId === threadId ? pin.revision : undefined
		},
		release(): void {
			pin = undefined
		},
	}
}
