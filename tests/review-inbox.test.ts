import { describe, expect, it } from 'vitest'
import type { ReviewActor, ReviewThread } from '../src/domain/reviews/schema'
import {
	buildInboxThread,
	canvasLinkOptions,
	DEFAULT_INBOX_FILTER,
	groupInbox,
	inboxCanvasLink,
	inboxQuery,
	isUnreadThread,
	matchesInboxFilter,
	orderInbox,
	parseInboxQuery,
	type InboxFilter,
	type InboxThread,
	type InboxViewInfo,
	type ReviewSummaryInput,
} from '../app/utils/review-inbox'
import { buildReviewTimeline } from '../app/utils/review-timeline'
import { recordedContextParts, recordedContextText } from '../app/utils/thread-render-context'
import { viewQuery } from '../app/utils/workbench-routes'
import { workspaceRenderContextKeys } from '../src/preview/render-context-options'

const VIEW = 'view-1'
const mei: ReviewActor = { type: 'human', id: 'member:mei', displayName: 'mei' }
const jun: ReviewActor = { type: 'human', id: 'member:jun', displayName: 'jun' }
const ana: ReviewActor = { type: 'human', id: 'member:ana', displayName: 'ana' }
const claude: ReviewActor = { type: 'agent', id: 'member:claude', displayName: 'claude' }

const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 9, minute)).toISOString()

function summary(key: string, status: ReviewSummaryInput['summary']['status'], latest: number | undefined, extra: Partial<ReviewSummaryInput['summary']> = {}): ReviewSummaryInput {
	return {
		key,
		revision: `r-${key}`,
		summary: { anchor: { viewId: VIEW, widgetId: 'cta' }, variantNames: [], status, messageCount: 1, ...(latest === undefined ? {} : { latestActivityAt: at(latest) }), ...extra },
	}
}

function thread(id: string, overrides: Partial<ReviewThread> = {}): ReviewThread {
	return {
		id,
		anchor: { viewId: VIEW, widgetId: 'cta' },
		variantNames: [],
		status: 'open',
		messages: [{ id: `${id}-m1`, actor: mei, at: at(0), body: 'First message' }],
		history: [],
		submissions: [],
		...overrides,
	}
}

const views: ReadonlyMap<string, InboxViewInfo> = new Map([[VIEW, { name: 'Checkout', widgetTypes: new Map([['root', 'RootShell'], ['cta', 'Button']]), variants: new Set(['compact']) }]])

describe('Reviews inbox ordering (Part 7 10a)', () => {
	// A mixed fixture: interleaved statuses and activity times, one summary without activity yet.
	const fixture = [
		summary('open-old', 'open', 1),
		summary('resolved-new', 'resolved', 59, { resolution: 'answered' }),
		summary('ready-old', 'ready-for-review', 2),
		summary('open-new', 'open', 50),
		summary('ready-new', 'ready-for-review', 40),
		summary('open-none', 'open', undefined),
		summary('open-mid', 'open', 30),
		summary('resolved-old', 'resolved', 5, { resolution: 'verified' }),
	].map(item => buildInboxThread(item, undefined, views))

	it('hides resolved by default, puts ready before open, and sorts each group by latest activity descending', () => {
		const visible = fixture.filter(item => matchesInboxFilter(item, DEFAULT_INBOX_FILTER))
		expect(orderInbox(visible).map(item => item.id)).toEqual(['ready-new', 'ready-old', 'open-new', 'open-mid', 'open-old', 'open-none'])
		expect(groupInbox(visible).map(group => [group.status, group.threads.length])).toEqual([['ready-for-review', 2], ['open', 4]])
	})

	it('reaches resolved threads only through an explicit filter, as the last group', () => {
		const all = fixture.filter(item => matchesInboxFilter(item, { ...DEFAULT_INBOX_FILTER, status: [] }))
		expect(groupInbox(all).map(group => group.status)).toEqual(['ready-for-review', 'open', 'resolved'])
		expect(groupInbox(all).at(-1)!.threads.map(item => item.id)).toEqual(['resolved-new', 'resolved-old'])
	})

	it('filters resolved threads by resolution without touching unresolved ones', () => {
		const filter: InboxFilter = { ...DEFAULT_INBOX_FILTER, status: [], resolution: ['verified'] }
		const ids = fixture.filter(item => matchesInboxFilter(item, filter)).map(item => item.id)
		expect(ids).toContain('resolved-old')
		expect(ids).not.toContain('resolved-new')
		expect(ids).toContain('open-old')
	})

	it('never lets search change the ordering', () => {
		const searchable = fixture.map(item => ({ ...item, title: item.id.startsWith('open') ? 'label copy' : 'other' })) as InboxThread[]
		const filtered = searchable.filter(item => matchesInboxFilter(item, { ...DEFAULT_INBOX_FILTER, search: 'label' }))
		expect(orderInbox(filtered).map(item => item.id)).toEqual(['open-new', 'open-mid', 'open-old', 'open-none'])
	})
})

describe('Reviews inbox threads and filters', () => {
	it('derives the author, participants, change domains and anchor state from the point read', () => {
		const detail = thread('t1', {
			status: 'ready-for-review',
			variantNames: ['compact', 'gone'],
			messages: [{ id: 'm1', actor: jun, at: at(1), body: 'Pay label copy' }, { id: 'm2', actor: claude, at: at(3), body: 'Fixed.' }],
			submissions: [{ id: 's1', actor: claude, at: at(4), changeDomains: ['i18n', 'views'], resources: [], scope: {}, evidenceRefs: [{ kind: 'visual', evidence: 'sha256:aa' }] }],
			history: [{ id: 'h1', kind: 'lifecycle', actor: claude, at: at(4), from: 'open', to: 'ready-for-review', submissionId: 's1' }],
		})
		const item = buildInboxThread(summary('t1', 'ready-for-review', 4, { variantNames: ['compact', 'gone'] }), detail, views)
		expect(item.author).toEqual(jun)
		expect(item.title).toBe('Pay label copy')
		expect(item.latestActor).toEqual(claude)
		expect(item.participants).toEqual(['member:jun', 'member:claude'])
		expect(item.domains).toEqual(['i18n', 'views'])
		expect(item.anchorState).toBe('stale')
		expect(item.missingVariants).toEqual(['gone'])
		expect(item.widgetType).toBe('Button')
		expect(item.viewName).toBe('Checkout')

		const missing = buildInboxThread(summary('t2', 'open', 1, { anchor: { viewId: VIEW, widgetId: 'deleted' } }), undefined, views)
		expect(missing.anchorState).toBe('missing')
		const viewGone = buildInboxThread(summary('t3', 'open', 1, { anchor: { viewId: 'gone', widgetId: 'cta' } }), undefined, views)
		expect(viewGone.anchorState).toBe('missing')
		// Before the View list arrives nothing reads as missing.
		expect(buildInboxThread(summary('t4', 'open', 1, { anchor: { viewId: 'gone', widgetId: 'x' } }), undefined, undefined).anchorState).toBe('valid')
	})

	it('tells four authors apart by identity, not color, and filters by author, mine, View, scope, anchor and domain', () => {
		const threads = [
			buildInboxThread(summary('a', 'open', 1), thread('a', { messages: [{ id: 'a1', actor: mei, at: at(1), body: 'A' }] }), views),
			buildInboxThread(summary('b', 'open', 2, { variantNames: ['compact'] }), thread('b', { variantNames: ['compact'], messages: [{ id: 'b1', actor: jun, at: at(2), body: 'B' }, { id: 'b2', actor: mei, at: at(3), body: 'B2' }] }), views),
			buildInboxThread(summary('c', 'open', 3), thread('c', { messages: [{ id: 'c1', actor: ana, at: at(3), body: 'C' }] }), views),
			buildInboxThread(summary('d', 'ready-for-review', 4), thread('d', { status: 'ready-for-review', messages: [{ id: 'd1', actor: claude, at: at(4), body: 'D' }], submissions: [{ id: 's', actor: claude, at: at(4), changeDomains: ['i18n'], resources: [], scope: {}, evidenceRefs: [] }] }), views),
		]
		expect(new Set(threads.map(item => item.author?.id)).size).toBe(4)
		expect(threads.find(item => item.id === 'd')!.author?.type).toBe('agent')
		const ids = (filter: Partial<InboxFilter>, me?: string) => threads.filter(item => matchesInboxFilter(item, { ...DEFAULT_INBOX_FILTER, ...filter }, me ? { me } : {})).map(item => item.id).sort()
		expect(ids({ authors: ['member:jun'] })).toEqual(['b'])
		expect(ids({ mine: true }, 'member:mei')).toEqual(['a', 'b'])
		expect(ids({ mine: true })).toEqual([])
		expect(ids({ scopes: ['compact'] })).toEqual(['b'])
		expect(ids({ scopes: ['*'] })).toEqual(['a', 'c', 'd'])
		expect(ids({ domains: ['i18n'] })).toEqual(['d'])
		expect(ids({ views: ['elsewhere'] })).toEqual([])
		expect(ids({ anchor: ['valid'] })).toEqual(['a', 'b', 'c', 'd'])
	})

	it('marks a thread updated since the member last looked, unless the member moved it last', () => {
		const item = { id: 't', latestActivityAt: at(10), latestActor: jun }
		expect(isUnreadThread(item, {}, 'member:mei')).toBe(true)
		expect(isUnreadThread(item, { t: at(10) }, 'member:mei')).toBe(false)
		expect(isUnreadThread(item, { t: at(5) }, 'member:mei')).toBe(true)
		expect(isUnreadThread(item, {}, 'member:jun')).toBe(false)
	})

	it('round-trips the filter and the open thread through the URL', () => {
		expect(inboxQuery(DEFAULT_INBOX_FILTER)).toEqual({})
		expect(parseInboxQuery({})).toEqual(DEFAULT_INBOX_FILTER)
		const filter: InboxFilter = { status: ['resolved'], resolution: ['wont-fix', 'answered'], views: ['v1'], scopes: ['*', 'compact'], authors: ['member:mei'], anchor: ['missing'], domains: ['i18n'], mine: true, unread: true, search: 'label' }
		const query = inboxQuery(filter, 'thread-1')
		expect(query).toEqual({ status: 'resolved', resolution: 'answered,wont-fix', view: 'v1', variant: '*,compact', author: 'member:mei', anchor: 'missing', domain: 'i18n', mine: '1', unread: '1', q: 'label', thread: 'thread-1' })
		expect(parseInboxQuery(query as Record<string, string>)).toEqual({ ...filter, resolution: ['answered', 'wont-fix'] })
		expect(parseInboxQuery({ status: 'all' }).status).toEqual([])
		expect(inboxQuery({ ...DEFAULT_INBOX_FILTER, status: [] })).toEqual({ status: 'all' })
		expect(parseInboxQuery({ status: 'nonsense', resolution: 'bogus' })).toMatchObject({ status: ['ready-for-review', 'open'], resolution: [] })
	})
})

describe('Reviews inbox canvas links and the recorded render context (Part 7)', () => {
	const ZH_MOBILE_DARK = { locale: 'zh-TW', viewportId: 'mobile', themeId: 'dark' } as const
	const keys = workspaceRenderContextKeys({
		i18n: { defaultLocale: 'en-US' },
		viewports: { desktop: { dimensions: { width: 1920, height: 1080 } }, mobile: { dimensions: { width: 390, height: 844 } } },
		themes: { dark: {}, light: {} },
	}, ['en-US', 'zh-TW'])

	it('carries the recorded render context from the summary, or the point read, on Widget threads only', () => {
		expect(buildInboxThread(summary('a', 'open', 1, { renderContext: ZH_MOBILE_DARK }), undefined, views).renderContext).toEqual(ZH_MOBILE_DARK)
		expect(buildInboxThread(summary('b', 'open', 1), thread('b', { renderContext: { locale: 'zh-TW' } }), views).renderContext).toEqual({ locale: 'zh-TW' })
		expect(buildInboxThread(summary('c', 'open', 1), undefined, views).renderContext).toBeUndefined()
		expect('renderContext' in buildInboxThread(summary('w', 'open', 1, { anchor: { scope: 'workspace' }, renderContext: ZH_MOBILE_DARK }), undefined, views)).toBe(false)
	})

	it('opens a Widget thread on its View in the recorded Locale, viewport and theme, with the thread open and its Widget selected (Rule 01a116f0-8ec3, Scenario 01a11e0e-435a)', () => {
		const item = buildInboxThread(summary('a', 'open', 1, { renderContext: ZH_MOBILE_DARK }), undefined, views)
		const link = inboxCanvasLink(item, keys)
		expect(link.options).toEqual({ thread: 'a', locale: 'zh-TW', viewport: 'mobile', theme: 'dark', widget: 'cta' })
		expect(link.missing).toEqual([])
		// The View link query carries only render-context members, never the chrome language or theme (Rule 01a118a1-9e11).
		expect(Object.keys(viewQuery(link.options)).sort()).toEqual(['locale', 'theme', 'thread', 'viewport', 'widget'])
	})

	it('leaves unrecorded members to the defaults and keeps the single-Variant rule', () => {
		const scoped = buildInboxThread(summary('s', 'open', 1, { variantNames: ['compact'], renderContext: { locale: 'zh-TW' } }), undefined, views)
		expect(inboxCanvasLink(scoped, keys).options).toEqual({ thread: 's', variant: 'compact', locale: 'zh-TW', widget: 'cta' })
		const unknown = buildInboxThread(summary('u', 'open', 1), undefined, views)
		expect(inboxCanvasLink(unknown, keys).options).toEqual({ thread: 'u', widget: 'cta' })
	})

	it('drops a stale key so it opens with its default, keeps the other members, and reports it for the notice (Rule 01a1170f-c165, Scenario 01a11e0e-4409)', () => {
		const withoutMobile = workspaceRenderContextKeys({ i18n: { defaultLocale: 'en-US' }, viewports: { desktop: { dimensions: { width: 1920, height: 1080 } } }, themes: { dark: {} } }, ['en-US', 'zh-TW'])
		const item = buildInboxThread(summary('a', 'open', 1, { renderContext: { locale: 'zh-TW', viewportId: 'mobile' } }), undefined, views)
		const link = inboxCanvasLink(item, withoutMobile)
		expect(link.options).toEqual({ thread: 'a', locale: 'zh-TW', widget: 'cta' })
		expect(link.missing).toEqual([{ member: 'viewportId', key: 'mobile' }])
		// The thread itself still records the stale key: nothing is rebound.
		expect(item.renderContext).toEqual({ locale: 'zh-TW', viewportId: 'mobile' })
	})

	it('carries every recorded member while the Workspace keys are not read yet', () => {
		const item = buildInboxThread(summary('a', 'open', 1, { renderContext: ZH_MOBILE_DARK }), undefined, views)
		expect(inboxCanvasLink(item, undefined)).toEqual({ options: { thread: 'a', locale: 'zh-TW', viewport: 'mobile', theme: 'dark', widget: 'cta' }, missing: [] })
	})

	it('builds "Open in current context" from the reader\'s own selections instead (Rule 01a1170f-c11d)', () => {
		const item = buildInboxThread(summary('a', 'open', 1, { renderContext: ZH_MOBILE_DARK }), undefined, views)
		expect(canvasLinkOptions(item, { locale: 'en-US', viewport: 'desktop', theme: '' })).toEqual({ thread: 'a', locale: 'en-US', viewport: 'desktop', widget: 'cta' })
		expect(canvasLinkOptions(item)).toEqual({ thread: 'a', widget: 'cta' })
	})

	it('labels the recorded members in header order and flags a stale one', () => {
		const parts = recordedContextParts({ themeId: 'dark', locale: 'zh-TW', viewportId: 'mobile' }, [{ member: 'viewportId', key: 'mobile' }])
		expect(recordedContextText(parts)).toBe('zh-TW · mobile · dark')
		expect(parts.map(part => part.missing)).toEqual([false, true, false])
		expect(recordedContextText(recordedContextParts({ themeId: 'dark' }))).toBe('dark')
		expect(recordedContextParts(undefined)).toEqual([])
	})
})

describe('Review timeline (Part 7 10b)', () => {
	it('interleaves messages, submissions, re-anchors and lifecycle events by timestamp with typed items', () => {
		const detail = thread('t', {
			status: 'open',
			messages: [
				{ id: 'm1', actor: mei, at: at(1), body: 'Label should say Pay.' },
				{ id: 'm2', actor: claude, at: at(4), body: 'Updated.' },
				{ id: 'm3', actor: mei, at: at(9), body: 'Still wrong in zh-TW.' },
			],
			submissions: [
				{ id: 's1', actor: claude, at: at(5), changeDomains: ['i18n'], resources: [], scope: {}, evidenceRefs: [{ kind: 'formal_capture', evidence: 'sha256:1' }] },
				{ id: 's2', actor: claude, at: at(11), changeDomains: ['views'], resources: [], scope: {}, evidenceRefs: [] },
			],
			history: [
				{ id: 'h0', kind: 'reanchor', actor: mei, at: at(2), before: { anchor: { viewId: VIEW, widgetId: 'old' }, variantNames: [] }, after: { anchor: { viewId: VIEW, widgetId: 'cta' }, variantNames: ['compact'] }, reason: 'Moved' },
				{ id: 'h1', kind: 'lifecycle', actor: claude, at: at(5), from: 'open', to: 'ready-for-review', submissionId: 's1' },
				{ id: 'h2', kind: 'lifecycle', actor: mei, at: at(7), from: 'ready-for-review', to: 'resolved', submissionId: 's1', resolution: 'verified' },
				{ id: 'h3', kind: 'lifecycle', actor: mei, at: at(8), from: 'resolved', to: 'open', reason: 'Regressed' },
				{ id: 'h4', kind: 'lifecycle', actor: claude, at: at(11), from: 'open', to: 'ready-for-review', submissionId: 's2' },
				{ id: 'h5', kind: 'lifecycle', actor: mei, at: at(12), from: 'ready-for-review', to: 'resolved', resolution: 'wont-fix', reason: 'Out of scope' },
			],
		})
		const items = buildReviewTimeline(detail)
		expect(items.map(item => `${item.kind}:${item.id}`)).toEqual([
			'message:m1', 'reanchored:h0', 'message:m2', 'submission:s1', 'resolved:h2', 'reopened:h3', 'message:m3', 'submission:s2', 'resolved:h5',
		])
		const first = items[3]!
		const second = items[7]!
		expect(first.kind === 'submission' && first.accepted && !first.notAccepted && first.evidence.length === 1).toBe(true)
		expect(second.kind === 'submission' && second.notAccepted && !second.accepted).toBe(true)
		const verified = items[4]!
		expect(verified.kind === 'resolved' && verified.resolution === 'verified' && verified.submissionId === 's1').toBe(true)
		const declined = items[8]!
		expect(declined.kind === 'resolved' && declined.resolution === 'wont-fix' && declined.reason === 'Out of scope' && !declined.submissionId).toBe(true)
		const moved = items[1]!
		expect(moved.kind === 'reanchored' && 'widgetId' in moved.from && moved.from.widgetId === 'old' && moved.toScope.join() === 'compact').toBe(true)
	})

	it('marks only the active ready submission as current, and reads a v1 resolve as verified', () => {
		const ready = buildReviewTimeline(thread('t', {
			status: 'ready-for-review',
			submissions: [{ id: 's1', actor: claude, at: at(2), changeDomains: [], resources: [], scope: {}, evidenceRefs: [] }],
			history: [{ id: 'h1', kind: 'lifecycle', actor: claude, at: at(2), from: 'open', to: 'ready-for-review', submissionId: 's1' }],
		}))
		expect(ready.find(item => item.kind === 'submission')).toMatchObject({ current: true })
		const legacy = buildReviewTimeline(thread('t', {
			status: 'resolved',
			history: [{ id: 'h1', kind: 'lifecycle', actor: mei, at: at(2), from: 'ready-for-review', to: 'resolved', submissionId: 's1' }],
		}))
		expect(legacy.find(item => item.kind === 'resolved')).toMatchObject({ resolution: 'verified' })
	})
})
