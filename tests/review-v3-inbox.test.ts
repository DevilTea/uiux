import { describe, expect, it } from 'vitest'

import type { ReviewThread } from '../src/domain/reviews/schema'
import {
	buildInboxThread,
	DEFAULT_INBOX_FILTER,
	groupInbox,
	inboxQuery,
	inboxStatusOf,
	isUnreadThread,
	matchesInboxFacets,
	matchesInboxFilter,
	parseInboxQuery,
	type ReviewSummaryInput,
} from '../app/utils/review-inbox'
import { buildReviewTimeline, latestTimelineActor, messageVersions } from '../app/utils/review-timeline'
import { latestEditableMessageId, messageEditState, retractEligibility } from '../app/utils/review-message-actions'
import { resolveMenuGroups } from '../app/utils/resolve-menu'

/**
 * The Workbench side of the accepted Part 7 groups: Workspace threads in the inbox model, the
 * Dismiss presentation (UI-only `dismissed` pseudo-status), the edit and retract affordances, and
 * the Edit history projection.
 */

const VIEW = '11111111-1111-4111-8111-111111111111'
const ME = 'member:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const mei = { type: 'human', id: ME, displayName: 'mei' }
const rui = { type: 'human', id: 'member:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', displayName: 'rui' }
const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 6, minute)).toISOString()

function summary(key: string, extra: Partial<ReviewSummaryInput['summary']> = {}): ReviewSummaryInput {
	return { key, revision: `r_${key}`, summary: { anchor: { viewId: VIEW, widgetId: 'cta' }, variantNames: [], status: 'open', messageCount: 1, latestActivityAt: at(1), ...extra } }
}

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
	return { id: 't', anchor: { scope: 'workspace' }, variantNames: [], status: 'open', messages: [{ id: 'm1', actor: mei, at: at(1), body: 'Hello' }], history: [], submissions: [], ...overrides }
}

describe('Dismiss presentation in the inbox model', () => {
	const fixture = [
		buildInboxThread(summary('open'), undefined, undefined),
		buildInboxThread(summary('answered', { status: 'resolved', resolution: 'answered', latestActivityAt: at(5) }), undefined, undefined),
		buildInboxThread(summary('verified', { status: 'resolved', resolution: 'verified', latestActivityAt: at(4) }), undefined, undefined),
		buildInboxThread(summary('obsolete', { status: 'resolved', resolution: 'obsolete', latestActivityAt: at(6) }), undefined, undefined),
		buildInboxThread(summary('duplicate', { status: 'resolved', resolution: 'duplicate', latestActivityAt: at(3) }), undefined, undefined),
		buildInboxThread(summary('wont-fix', { status: 'resolved', resolution: 'wont-fix', latestActivityAt: at(2) }), undefined, undefined),
	]

	it('lists dismissals as `dismissed`, apart from resolved, and keeps the canonical status', () => {
		expect(inboxStatusOf('resolved', 'obsolete')).toBe('dismissed')
		expect(inboxStatusOf('resolved', 'answered')).toBe('resolved')
		expect(inboxStatusOf('open', undefined)).toBe('open')
		expect(fixture.map(item => [item.id, item.status, item.inboxStatus])).toEqual([
			['open', 'open', 'open'],
			['answered', 'resolved', 'resolved'],
			['verified', 'resolved', 'resolved'],
			['obsolete', 'resolved', 'dismissed'],
			['duplicate', 'resolved', 'dismissed'],
			['wont-fix', 'resolved', 'dismissed'],
		])
	})

	it('narrows Resolved to verified and answered, adds a Dismissed filter, and hides both by default', () => {
		const ids = (status: Parameters<typeof matchesInboxFilter>[1]['status']) => fixture.filter(item => matchesInboxFilter(item, { ...DEFAULT_INBOX_FILTER, status })).map(item => item.id)
		expect(ids(DEFAULT_INBOX_FILTER.status)).toEqual(['open'])
		expect(ids(['resolved'])).toEqual(['answered', 'verified'])
		expect(ids(['dismissed'])).toEqual(['obsolete', 'duplicate', 'wont-fix'])
		expect(groupInbox(fixture).map(group => [group.status, group.threads.map(item => item.id)])).toEqual([
			['open', ['open']],
			['resolved', ['answered', 'verified']],
			['dismissed', ['obsolete', 'duplicate', 'wont-fix']],
		])
	})

	it('round-trips status=dismissed through the deep link and keeps status=resolved working', () => {
		expect(parseInboxQuery({ status: 'dismissed' }).status).toEqual(['dismissed'])
		expect(inboxQuery({ ...DEFAULT_INBOX_FILTER, status: ['dismissed'] })).toEqual({ status: 'dismissed' })
		expect(parseInboxQuery({ status: 'resolved,dismissed', resolution: 'obsolete' })).toMatchObject({ status: ['resolved', 'dismissed'], resolution: ['obsolete'] })
		expect(inboxQuery({ ...DEFAULT_INBOX_FILTER, status: ['dismissed', 'resolved'] })).toEqual({ status: 'resolved,dismissed' })
	})

	it('groups the resolve menu into Resolve and Dismiss with the decided labels', () => {
		const t = (key: string) => key
		const resolved: string[] = []
		const groups = resolveMenuGroups({ t, status: 'ready-for-review', canVerify: true, resolve: kind => resolved.push(kind), askDuplicate: () => resolved.push('ask') })
		expect(groups.map(group => group.map(item => item.label))).toEqual([
			['comments.resolveGroup', 'comments.resolution.answered', 'comments.resolution.verified'],
			['comments.dismissGroup', 'comments.resolution.obsolete', 'comments.resolveDuplicate', 'comments.resolution.wont-fix'],
		])
		for (const item of groups.flat()) (item.onSelect as (() => void) | undefined)?.()
		expect(resolved).toEqual(['answered', 'verified', 'obsolete', 'ask', 'wont-fix'])
		const open = resolveMenuGroups({ t, status: 'open', canVerify: false, resolve: () => undefined, askDuplicate: () => undefined })
		expect(open[0]!.map(item => item.label)).toEqual(['comments.resolveGroup', 'comments.resolution.answered'])
	})
})

describe('Workspace threads in the inbox model', () => {
	it('are always anchor-valid, carry no View, and answer the Workspace View facet and search term', () => {
		const views = new Map([[VIEW, { name: 'Checkout', widgetTypes: new Map([['cta', 'Button']]), variants: new Set<string>() }]])
		const workspace = buildInboxThread(summary('w', { anchor: { scope: 'workspace' } }), thread(), views)
		const widget = buildInboxThread(summary('v'), undefined, views)
		expect(workspace).toMatchObject({ scope: 'workspace', anchorState: 'valid', missingVariants: [] })
		expect(workspace).not.toHaveProperty('viewId')
		expect(widget).toMatchObject({ scope: 'view', viewId: VIEW, widgetId: 'cta', viewName: 'Checkout' })
		const facet = (filter: Partial<typeof DEFAULT_INBOX_FILTER>) => [workspace, widget].filter(item => matchesInboxFacets(item, { ...DEFAULT_INBOX_FILTER, ...filter })).map(item => item.id)
		expect(facet({ views: ['workspace'] })).toEqual(['w'])
		expect(facet({ views: [VIEW] })).toEqual(['v'])
		expect(facet({ scopes: ['*'] })).toEqual(['v'])
		expect(facet({ anchor: ['valid'] })).toEqual(['w', 'v'])
		expect(facet({ search: 'workspace' })).toEqual(['w'])
		expect(parseInboxQuery({ view: 'workspace' }).views).toEqual(['workspace'])
	})
})

describe('editing: affordances, the edited projection and activity', () => {
	const edited = thread({ messages: [{ id: 'm1', actor: mei, at: at(1), body: 'v3', edits: [{ id: 'e1', actor: mei, at: at(2), previousBody: 'v1' }, { id: 'e2', actor: mei, at: at(3), previousBody: 'v2' }] }] })

	it('offers Edit on the viewer\'s own message only, and freezes it after a submission or resolution', () => {
		expect(messageEditState(edited, 'm1', ME)).toEqual({ kind: 'editable' })
		expect(messageEditState(edited, 'm1', rui.id)).toEqual({ kind: 'none' })
		expect(messageEditState(edited, 'm1', undefined)).toEqual({ kind: 'none' })
		const legacy = thread({ messages: [{ id: 'm1', actor: { type: 'human', displayName: 'mei' }, at: at(1), body: 'old' }] })
		expect(messageEditState(legacy, 'm1', ME)).toEqual({ kind: 'none' })
		const resolved = thread({ status: 'open', history: [
			{ id: 'h1', kind: 'lifecycle', actor: rui, at: at(4), from: 'open', to: 'resolved', resolution: 'answered' },
			{ id: 'h2', kind: 'lifecycle', actor: rui, at: at(5), from: 'resolved', to: 'open' },
		], messages: [...edited.messages, { id: 'm2', actor: mei, at: at(6), body: 'later' }] })
		expect(messageEditState(resolved, 'm1', ME)).toEqual({ kind: 'frozen', by: 'resolution' })
		expect(messageEditState(resolved, 'm2', ME)).toEqual({ kind: 'editable' })
		expect(latestEditableMessageId(resolved, ME)).toBe('m2')
		expect(latestEditableMessageId(resolved, rui.id)).toBeUndefined()
		const submitted = thread({ status: 'ready-for-review', submissions: [{ id: 's1', actor: rui, at: at(4), changeDomains: ['copy'], resources: [], scope: {}, evidenceRefs: [] }] })
		expect(messageEditState(submitted, 'm1', ME)).toEqual({ kind: 'frozen', by: 'submission' })
	})

	it('derives edited-at on the message item, keeps its position, and lists versions newest first', () => {
		const items = buildReviewTimeline(edited)
		expect(items[0]).toMatchObject({ kind: 'message', at: at(1), body: 'v3', editedAt: at(3) })
		const message = items[0]
		if (message?.kind !== 'message') throw new Error('expected a message')
		expect(messageVersions(message)).toEqual([
			{ body: 'v3', at: at(3), current: true },
			{ body: 'v2', at: at(2), current: false },
			{ body: 'v1', at: at(1), current: false },
		])
		expect(messageVersions({ at: at(1), body: 'only', edits: [] })).toEqual([{ body: 'only', at: at(1), current: true }])
	})

	it('counts an edit as activity: the editor is who moved the thread last', () => {
		const withReply = thread({ messages: [
			{ id: 'm1', actor: mei, at: at(1), body: 'v2', edits: [{ id: 'e1', actor: mei, at: at(9), previousBody: 'v1' }] },
			{ id: 'm2', actor: rui, at: at(5), body: 'reply' },
		] })
		expect(latestTimelineActor(withReply)).toEqual(mei)
		const item = buildInboxThread(summary('t', { anchor: { scope: 'workspace' }, latestActivityAt: at(9) }), withReply, undefined)
		expect(isUnreadThread(item, {}, ME)).toBe(false)
		expect(isUnreadThread(item, {}, rui.id)).toBe(true)
	})
})

describe('retract eligibility (E1–E5 on the client; the server also checks E6)', () => {
	it('offers Delete only on the author\'s brand-new, unengaged thread, and on an empty one to anyone', () => {
		expect(retractEligibility(thread(), ME)).toEqual({ eligible: true, empty: false })
		expect(retractEligibility(thread(), rui.id)).toEqual({ eligible: false })
		expect(retractEligibility(thread({ messages: [] }), rui.id)).toEqual({ eligible: true, empty: true })
		expect(retractEligibility(thread({ messages: [...thread().messages, { id: 'm2', actor: mei, at: at(2), body: 'more' }] }), ME)).toEqual({ eligible: false })
		expect(retractEligibility(thread({ status: 'resolved', history: [{ id: 'h', kind: 'lifecycle', actor: mei, at: at(2), from: 'open', to: 'resolved', resolution: 'obsolete' }] }), ME)).toEqual({ eligible: false })
		expect(retractEligibility(thread({ history: [{ id: 'h', kind: 'reanchor', actor: mei, at: at(2), before: { anchor: { scope: 'workspace' }, variantNames: [] }, after: { anchor: { scope: 'workspace' }, variantNames: [] } }] }), ME)).toEqual({ eligible: false })
		expect(retractEligibility(thread({ submissions: [{ id: 's', actor: rui, at: at(2), changeDomains: [], resources: [], scope: {}, evidenceRefs: [] }] }), ME)).toEqual({ eligible: false })
		expect(retractEligibility(thread({ messages: [{ id: 'm1', actor: { type: 'human', displayName: 'mei' }, at: at(1), body: 'legacy' }] }), ME)).toEqual({ eligible: false })
		expect(retractEligibility(undefined, ME)).toEqual({ eligible: false })
		expect(retractEligibility(thread(), undefined)).toEqual({ eligible: false })
	})
})
