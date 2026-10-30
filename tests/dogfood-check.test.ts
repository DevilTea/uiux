import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { contextKey as appContextKey } from '../app/utils/readiness'
import {
	CheckError,
	assessEvidence,
	contextKey,
	copyWorkspace,
	createReport,
	describeProvenanceDrift,
	diffSnapshots,
	formatReport,
	formatSummaryMarkdown,
	isRuntimePath,
	locateWorkspace,
	parseReadiness,
	requiredContexts,
	snapshotTree,
} from '../scripts/dogfood-check.mjs'
import { ROUTE_MAP_FILE, assessRequirementCoverage, assessRoutes, coverageNumbers, enumeratePages, routeOfPage } from '../scripts/dogfood-coverage.mjs'

/**
 * The decision logic of `pnpm dogfood:check` (issue #383, scripts/dogfood-check.mjs): which render contexts
 * need fresh Evidence, how stale, missing and unknown captures are told apart, how the Handoff readiness response
 * is read, which files leave `.uiux/`, and the assertion that the checked-out `.uiux/` was not changed. They run on
 * fakes and temporary directories; the served run itself (server, kit build, Evidence list) is the script's own
 * integration run and the `dogfood-check` CI job.
 */
const directories: string[] = []

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function scratch(): string {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), 'uiux-dogfood-check-test-')))
	directories.push(directory)
	return directory
}

function write(root: string, path: string, content = path): void {
	const file = join(root, path)
	mkdirSync(join(file, '..'), { recursive: true })
	writeFileSync(file, content)
}

const VIEW_A = '2e2f88d6-7a95-424a-b3d4-4661d811ef13'
const VIEW_B = '468247e8-4f39-4f04-8056-b2af4c1c37ea'
const WORKSPACE = {
	i18n: { defaultLocale: 'en-US' },
	themes: { light: { label: 'Light' }, dark: { label: 'Dark' } },
	viewports: { desktop: { dimensions: { width: 1920, height: 1080 } }, mobile: { dimensions: { width: 390, height: 844 } } },
}

function context(viewId: string, locale: string, viewportId: string, themeId: string, variantName?: string) {
	const viewport = viewportId === 'desktop' ? { width: 1920, height: 1080 } : { width: 390, height: 844 }
	return { viewId, ...(variantName ? { variantName } : {}), locale, viewportId, viewport, themeId }
}

const fresh = { state: 'fresh' as const }
const stale = (reason: string, subject?: string) => ({ state: 'stale' as const, reason, ...(subject ? { subject } : {}) })
const unknown = (reason: string) => ({ state: 'unknown' as const, reason })

function entry(digest: string, captured: ReturnType<typeof context> | undefined, freshness: { state: string, reason?: string, subject?: string }, record?: unknown) {
	return { digest, ...(captured ? { context: captured } : {}), freshness, ...(record ? { record } : {}) }
}

describe('requiredContexts', () => {
	it('is every View x Locale x viewport x theme of the Workspace, base context only', () => {
		const { contexts, dimensions } = requiredContexts({
			views: [{ key: VIEW_B, name: 'Reviews' }, { key: VIEW_A, name: 'Overview' }],
			workspace: WORKSPACE,
			locales: ['zh-TW', 'en-US'],
		})
		expect(dimensions).toEqual({ views: 2, locales: 2, viewports: 2, themes: 2 })
		expect(contexts).toHaveLength(16)
		expect(contexts.every(item => !('variantName' in item))).toBe(true)
		// Sorted by View key, so the report is stable.
		expect(contexts[0]).toMatchObject({ viewId: VIEW_A, viewName: 'Overview', locale: 'en-US', viewportId: 'desktop', themeId: 'dark', viewport: { width: 1920, height: 1080 } })
	})

	it('adds the default Locale of the manifest and falls back to the built-in viewport, theme and Locale', () => {
		const withDefault = requiredContexts({ views: [{ key: VIEW_A }], workspace: { ...WORKSPACE, i18n: { defaultLocale: 'ja-JP' } }, locales: ['en-US'] })
		expect(withDefault.dimensions.locales).toBe(2)
		const bare = requiredContexts({ views: [{ key: VIEW_A }], workspace: {}, locales: [] })
		expect(bare.contexts).toEqual([expect.objectContaining({ locale: 'en-US', viewportId: 'default', viewport: { width: 1280, height: 800 }, themeId: 'light' })])
	})

	it('keys a context as app/utils/readiness contextKey does', () => {
		const sample = context(VIEW_A, 'en-US', 'desktop', 'dark', 'empty')
		expect(contextKey(sample)).toBe(appContextKey(sample))
		expect(contextKey(context(VIEW_A, 'en-US', 'desktop', 'dark'))).toBe(appContextKey(context(VIEW_A, 'en-US', 'desktop', 'dark')))
	})
})

describe('assessEvidence', () => {
	const { contexts } = requiredContexts({ views: [{ key: VIEW_A, name: 'Overview' }], workspace: { ...WORKSPACE, viewports: { desktop: WORKSPACE.viewports.desktop }, themes: { light: {} } }, locales: ['en-US', 'zh-TW'] })
	const enUS = context(VIEW_A, 'en-US', 'desktop', 'light')
	const zhTW = context(VIEW_A, 'zh-TW', 'desktop', 'light')

	it('passes a context that has a fresh capture even when older captures of it are stale', () => {
		const result = assessEvidence({ required: contexts, entries: [entry('a', enUS, stale('viewChanged')), entry('b', enUS, fresh), entry('c', zhTW, fresh)] })
		expect(result.fresh).toHaveLength(2)
		expect(result.stale).toEqual([])
		expect(result.missing).toEqual([])
		expect(result.ignored).toEqual({ outsideRequired: 0, supersededNotFresh: 1 })
	})

	it('reports a context whose captures are all stale, with the reason closest to fresh', () => {
		const result = assessEvidence({
			required: contexts,
			entries: [
				entry('old', enUS, stale('noRenderInputDigest')),
				entry('recent', enUS, stale('adapterChanged')),
				entry('older', enUS, stale('viewChanged')),
				entry('c', zhTW, fresh),
			],
		})
		expect(result.fresh).toHaveLength(1)
		expect(result.missing).toEqual([])
		expect(result.stale).toHaveLength(1)
		expect(result.stale[0]).toMatchObject({ context: { locale: 'en-US' }, freshness: { state: 'stale', reason: 'adapterChanged' } })
	})

	it('reports a context with no capture as missing, and counts a capture of no required context as ignored', () => {
		const wide = { ...context(VIEW_A, 'en-US', 'desktop', 'light'), viewportId: 'wide', viewport: { width: 2560, height: 1440 } }
		const variant = context(VIEW_A, 'en-US', 'desktop', 'light', 'empty')
		const result = assessEvidence({ required: contexts, entries: [entry('a', enUS, fresh), entry('w', wide, fresh), entry('v', variant, fresh), entry('n', undefined, fresh)] })
		expect(result.fresh).toHaveLength(1)
		expect(result.missing.map(item => item.locale)).toEqual(['zh-TW'])
		expect(result.ignored.outsideRequired).toBe(3)
	})

	it('treats unknown freshness as not fresh, and a definite stale outranks it in the reason', () => {
		const onlyUnknown = assessEvidence({ required: contexts, entries: [entry('a', enUS, unknown('adaptersUnavailable')), entry('c', zhTW, fresh)] })
		expect(onlyUnknown.fresh).toHaveLength(1)
		expect(onlyUnknown.stale[0]).toMatchObject({ freshness: { state: 'unknown', reason: 'adaptersUnavailable' } })
		const mixed = assessEvidence({ required: contexts, entries: [entry('a', enUS, unknown('adaptersUnavailable')), entry('b', enUS, stale('viewChanged')), entry('c', zhTW, fresh)] })
		expect(mixed.stale[0]).toMatchObject({ freshness: { state: 'stale', reason: 'viewChanged' } })
	})

	it('makes every context missing when there are no captures at all', () => {
		const result = assessEvidence({ required: contexts, entries: [] })
		expect(result).toMatchObject({ fresh: [], stale: [] })
		expect(result.missing).toHaveLength(contexts.length)
	})
})

describe('describeProvenanceDrift', () => {
	const required = requiredContexts({ views: [{ key: VIEW_A }], workspace: { viewports: { desktop: WORKSPACE.viewports.desktop }, themes: { light: {} } }, locales: ['en-US'] }).contexts
	const captured = context(VIEW_A, 'en-US', 'desktop', 'light')
	const record = { provenance: { adapters: [{ contentDigest: 'sha256:old-adapter' }], productKit: { outputDigest: 'sha256:old-output' } } }

	it('names the digest the stale captures recorded against the current one, when the Adapter or Product Kit changed', () => {
		const { stale: items } = assessEvidence({ required, entries: [entry('a', captured, stale('adapterChanged'), record)] })
		const lines = describeProvenanceDrift(items, { adapters: [{ contentDigest: 'sha256:new-adapter' }], productKit: { outputDigest: 'sha256:new-output' } })
		expect(lines[0]).toContain('now sha256:new-adapter')
		expect(lines[0]).toContain('recorded sha256:old-adapter')
		expect(lines.at(-1)).toContain('not byte-identical across OS or toolchain')
		const kit = assessEvidence({ required, entries: [entry('a', captured, stale('productKitChanged'), record)] }).stale
		expect(describeProvenanceDrift(kit, { productKit: { outputDigest: 'sha256:new-output' } })[0]).toContain('outputDigest now sha256:new-output')
	})

	it('says nothing for a stale capture that has another reason', () => {
		const { stale: items } = assessEvidence({ required, entries: [entry('a', captured, stale('viewChanged'), record)] })
		expect(describeProvenanceDrift(items, { adapters: [{ contentDigest: 'sha256:new' }] })).toEqual([])
	})
})

describe('parseReadiness', () => {
	const ready = { status: 'ok', readiness: { implementationReady: true, coverage: { validation: { complete: true }, evidence: { complete: true }, review: { complete: true } }, blockingDiagnostics: [] }, assessment: { requiredEvidenceComplete: true } }

	it('passes a ready assessment', () => {
		expect(parseReadiness(ready)).toMatchObject({ ok: true, evidence: [], notes: [] })
	})

	it('fails on stale, missing or incomplete View Evidence diagnostics', () => {
		for (const code of ['handoff.stale_view_evidence', 'handoff.missing_view_evidence', 'handoff.incomplete_view_evidence']) {
			const result = parseReadiness({
				status: 'ok',
				readiness: { implementationReady: false, coverage: { evidence: { complete: false } }, blockingDiagnostics: [{ code, message: 'm', blocking: true, path: `/views/${VIEW_A}` }] },
				assessment: { requiredEvidenceComplete: false },
			})
			expect(result.ok).toBe(false)
			expect(result.evidence.map((item: { code: string }) => item.code)).toEqual([code])
		}
	})

	it('reports another blocking diagnostic (an open Review) as a note, not as Evidence drift', () => {
		const result = parseReadiness({ ...ready, readiness: { ...ready.readiness, implementationReady: false, blockingDiagnostics: [{ code: 'handoff.review_unresolved', message: 'open', blocking: true }] } })
		expect(result.ok).toBe(true)
		expect(result.notes).toHaveLength(1)
	})

	it('fails when the assessment is refused or absent', () => {
		expect(parseReadiness({ status: 'failed', diagnostics: [{ code: 'workspace.schema_unsupported', message: 'old' }] })).toMatchObject({ ok: false })
		expect(parseReadiness({ status: 'failed', diagnostics: [{ code: 'workspace.schema_unsupported', message: 'old' }] }).summary).toContain('workspace.schema_unsupported')
		expect(parseReadiness(undefined).ok).toBe(false)
	})
})

describe('the copy', () => {
	it('leaves out the runtime files of a running server and the kit install and build output only', () => {
		for (const path of ['.server-hold.json', '.server-hold-1.tmp', '.persistence.lock', '.persistence-lock-ab', '.transactions/x/journal.json', 'kit/node_modules/vue/index.js', 'kit/dist/uiux.js', 'kit/.DS_Store'])
			expect(isRuntimePath(path), path).toBe(true)
		for (const path of ['workspace.json', 'views/a.view.json', 'artifacts/sha256/ab/abcd', 'history/h.json', 'kit/src/ui/Button.vue', 'kit/adapters/reference.ts', 'kit/package.json', 'kit/distro/x.js', 'views/dist/a.json'])
			expect(isRuntimePath(path), path).toBe(false)
	})

	it('copies a Workspace without them', () => {
		const root = scratch()
		const source = join(root, 'source')
		for (const path of ['workspace.json', 'views/a.view.json', 'kit/src/ui/Button.vue', 'kit/package.json', 'history/h.json', '.server-hold.json', '.persistence.lock', '.transactions/t/j.json', 'kit/node_modules/vue/index.js', 'kit/dist/uiux.js'])
			write(source, path)
		const destination = join(root, 'copy')
		expect(copyWorkspace(source, destination)).toBe(5)
		const copied = snapshotTree(destination)
		expect([...copied.keys()].filter(path => !copied.get(path)?.startsWith('d'))).toEqual(['history/h.json', 'kit/package.json', 'kit/src/ui/Button.vue', 'views/a.view.json', 'workspace.json'])
	})

	it('locates a Workspace by its .uiux/ or by the directory holding one, and refuses another directory', () => {
		const root = scratch()
		write(root, '.uiux/workspace.json', '{}')
		expect(locateWorkspace(root)).toBe(join(root, '.uiux'))
		expect(locateWorkspace(join(root, '.uiux'))).toBe(join(root, '.uiux'))
		expect(() => locateWorkspace(join(root, 'elsewhere'))).toThrow(CheckError)
	})
})

describe('the unchanged-tree assertion', () => {
	function tree() {
		const root = scratch()
		for (const path of ['workspace.json', 'views/a.view.json', 'artifacts/sha256/ab/abcd', 'kit/dist/ignored.js']) write(root, path)
		return root
	}

	it('finds nothing in a tree that only was read, even when a file time moved', () => {
		const root = tree()
		const before = snapshotTree(root)
		utimesSync(join(root, 'workspace.json'), new Date(2001, 1, 1), new Date(2001, 1, 1))
		expect(diffSnapshots(before, snapshotTree(root))).toEqual({ added: [], removed: [], changed: [] })
	})

	it('finds an added, removed or changed file, an ignored one included, and a new empty directory', () => {
		const root = tree()
		const before = snapshotTree(root)
		write(root, 'history/baseline.json')
		write(root, 'kit/dist/ignored.js', 'rebuilt')
		write(root, 'views/a.view.json', 'edited')
		rmSync(join(root, 'artifacts/sha256/ab/abcd'))
		mkdirSync(join(root, 'reviews'))
		const difference = diffSnapshots(before, snapshotTree(root))
		expect(difference.added).toEqual(['history', 'history/baseline.json', 'reviews'])
		expect(difference.removed).toEqual(['artifacts/sha256/ab/abcd'])
		expect(difference.changed).toEqual(['kit/dist/ignored.js', 'views/a.view.json'])
	})

	it('sees a symbolic link and a changed link target', () => {
		const root = tree()
		symlinkSync('workspace.json', join(root, 'link'))
		const before = snapshotTree(root)
		rmSync(join(root, 'link'))
		symlinkSync('views', join(root, 'link'))
		expect(diffSnapshots(before, snapshotTree(root))).toEqual({ added: [], removed: [], changed: ['link'] })
	})
})

describe('the report', () => {
	it('fails when any check failed, lists the failed ids and keeps a skipped check out of the verdict', () => {
		const report = createReport()
		report.add('evidence', 'Evidence', 'pass', ['48/48'])
		report.add('route-coverage', 'Requirement coverage', 'skip', ['not run'])
		expect(report.failed).toBe(false)
		expect(formatReport(report)).toContain('dogfood:check passed.')
		report.add('tree-unchanged', 'Tree', 'fail', ['changed  views/a.view.json'])
		expect(report.failed).toBe(true)
		const text = formatReport(report)
		expect(text).toContain('FAIL  Tree')
		expect(text).toContain('SKIP  Requirement coverage')
		expect(text).toContain('dogfood:check FAILED: tree-unchanged.')
	})

	it('writes a Markdown step summary with the findings of the checks that did not pass', () => {
		const report = createReport()
		report.add('evidence', 'Evidence', 'fail', ['STALE    Overview en-US desktop light: adapterChanged'])
		report.add('design-tokens', 'Tokens', 'pass')
		const markdown = formatSummaryMarkdown(report, ['toolchain: node 24'])
		expect(markdown).toContain('| Evidence | **FAIL** |')
		expect(markdown).toContain('| Tokens | pass |')
		expect(markdown).toContain('STALE    Overview en-US desktop light: adapterChanged')
		expect(markdown).toContain('- toolchain: node 24')
	})
})

// ---------------------------------------------------------------------------------------------
// Requirement coverage and route coverage (scripts/dogfood-coverage.mjs)
// ---------------------------------------------------------------------------------------------

type Entry = { id: string, state: 'referenced' | 'unreferenced' | 'noUi', statement: string, referencedBy: unknown[] }

const referrer = [{ kind: 'view', viewId: VIEW_A }]
const rule = (id: string, state: Entry['state'], referencedBy: unknown[] = state === 'referenced' ? referrer : []): Entry => ({ id, state, statement: id, referencedBy })

/** A `GET /api/requirements` body (Clause 01a18120-f903-7f8d-9b44-d581ab520c0d) with 2 referenced, 1 noUi and 3 unreferenced Rules. */
function coverage(overrides: Record<string, unknown> = {}) {
	return {
		provider: { provider: 'spec', path: '../.spec' },
		status: 'ok',
		counts: { referenced: 2, unreferenced: 3, noUi: 1, unresolved: 0, unverified: 0 },
		requirements: [rule('r1', 'referenced'), rule('r2', 'referenced'), rule('r3', 'noUi'), rule('r4', 'unreferenced'), rule('r5', 'unreferenced'), rule('r6', 'unreferenced')],
		unresolved: [],
		unverified: [],
		...overrides,
	}
}

const baselineOf = (remaining: number, noUi = 1) => ({ ref: 'origin/main @ abcd1234', numbers: { total: 0, referenced: 0, noUi, remaining, ui: 0, ratio: 0 } })

describe('requirement coverage', () => {
	it('counts referenced, noUi and remaining UI Rules and their ratio from the Resource entries', () => {
		expect(coverageNumbers(coverage())).toEqual({ total: 6, referenced: 2, noUi: 1, remaining: 3, ui: 5, ratio: 2 / 5 })
	})

	it('passes when the provider is ok, nothing is unresolved or unverified, and the remaining count did not grow', () => {
		const result = assessRequirementCoverage({ coverage: coverage(), baseline: baselineOf(3) })
		expect(result.status).toBe('pass')
		expect(result.lines.join('\n')).toContain('referenced 2, noUi 1, remaining 3 (of 5 UI Rules; ratio 40.0%)')
		expect(result.lines.join('\n')).toContain('no more unreferenced UI Rules than the baseline')
		expect(assessRequirementCoverage({ coverage: coverage(), baseline: baselineOf(9) }).lines.join('\n')).toContain('6 fewer unreferenced UI Rules than the baseline')
	})

	it('fails when the unreferenced UI Rules increased against the baseline (the ratchet)', () => {
		const result = assessRequirementCoverage({ coverage: coverage(), baseline: baselineOf(2) })
		expect(result.status).toBe('fail')
		expect(result.lines.join('\n')).toContain('ratchet: 3 UI Rules are left unreferenced, 1 more than the 2 at origin/main @ abcd1234')
	})

	it('does not judge a grown noUi count, only reports it', () => {
		const result = assessRequirementCoverage({ coverage: coverage(), baseline: baselineOf(3, 0) })
		expect(result.status).toBe('pass')
		expect(result.lines.join('\n')).toContain('note: noUi grew by 1')
	})

	it('applies no ratchet without a baseline, and says why', () => {
		const result = assessRequirementCoverage({ coverage: coverage(), baseline: { reason: 'the base predates requirement references' } })
		expect(result.status).toBe('pass')
		expect(result.lines.join('\n')).toContain('ratchet not applied: the base predates requirement references.')
	})

	it('fails on an unresolved requirement ID and names it', () => {
		const result = assessRequirementCoverage({ coverage: coverage({ unresolved: [{ id: 'ghost-rule', referencedBy: referrer }] }), baseline: baselineOf(3) })
		expect(result.status).toBe('fail')
		expect(result.lines.join('\n')).toContain('unresolved ghost-rule (referenced by View 2e2f88d6)')
	})

	it('fails on an unverified ID', () => {
		const result = assessRequirementCoverage({ coverage: coverage({ unverified: [{ id: 'r1', referencedBy: referrer }] }), baseline: baselineOf(3) })
		expect(result.status).toBe('fail')
		expect(result.lines.join('\n')).toContain('unverified r1')
	})

	it('fails when an ID is both referenced and noUi', () => {
		const result = assessRequirementCoverage({ coverage: coverage({ requirements: [rule('r1', 'noUi', referrer), rule('r2', 'referenced')] }), baseline: baselineOf(0) })
		expect(result.status).toBe('fail')
		expect(result.lines.join('\n')).toContain('noUi+referenced r1 (referenced by View 2e2f88d6)')
	})

	it('fails when the provider is not ok, whatever the counts say', () => {
		for (const status of ['none', 'url', 'unavailable']) {
			const result = assessRequirementCoverage({ coverage: coverage({ status, requirements: [] }), baseline: baselineOf(3) })
			expect(result.status, status).toBe('fail')
			expect(result.lines.join('\n')).toContain(`provider status is "${status}", not "ok"`)
		}
	})

	it('fails when the coverage could not be read', () => {
		const result = assessRequirementCoverage({ coverage: undefined, error: 'GET /api/requirements returned HTTP 403', baseline: baselineOf(3) })
		expect(result.status).toBe('fail')
		expect(result.lines[0]).toContain('could not be read: GET /api/requirements returned HTTP 403')
	})
})

const PAGES = [
	{ file: 'index.vue', route: '/' },
	{ file: 'members.vue', route: '/members' },
	{ file: 'preview.vue', route: '/preview' },
	{ file: 'views/[viewId].vue', route: '/views/:viewId' },
]

function mapping(routes: Record<string, unknown>) {
	return { routes }
}

const COMPLETE = {
	'/': { views: [VIEW_A] },
	'/members': { views: [VIEW_A, VIEW_B] },
	'/preview': { exempt: 'the Preview host renders Adapter output; it has no screen of its own' },
	'/views/:viewId': { views: [VIEW_B] },
}

describe('route coverage', () => {
	it('derives the route of a page file as Nuxt does', () => {
		expect(PAGES.map(page => routeOfPage(page.file))).toEqual(PAGES.map(page => page.route))
		expect(routeOfPage('workspace/index.vue')).toBe('/workspace')
		expect(routeOfPage('flows/[flowId].vue')).toBe('/flows/:flowId')
	})

	it('passes when every page maps to existing Views or carries an exemption', () => {
		const result = assessRoutes({ pages: PAGES, mapping: mapping(COMPLETE), viewIds: [VIEW_A, VIEW_B] })
		expect(result.status).toBe('pass')
		expect(result.counts).toEqual({ mapped: 3, exempt: 1, todo: 0 })
	})

	it('fails on a page that has no entry', () => {
		const rest: Record<string, unknown> = { ...COMPLETE }
		delete rest['/members']
		const result = assessRoutes({ pages: PAGES, mapping: mapping(rest), viewIds: [VIEW_A, VIEW_B] })
		expect(result.status).toBe('fail')
		expect(result.lines.join('\n')).toContain('UNMAPPED  /members (app/pages/members.vue)')
	})

	it('fails on a View id the Workspace does not have, and says when none of a route\'s Views exist', () => {
		const partial = assessRoutes({ pages: PAGES, mapping: mapping({ ...COMPLETE, '/members': { views: [VIEW_A, 'no-such-view'] } }), viewIds: [VIEW_A, VIEW_B] })
		expect(partial.status).toBe('fail')
		expect(partial.lines.join('\n')).toContain('UNKNOWN   /members: View id(s) that do not exist: no-such-view')
		const none = assessRoutes({ pages: PAGES, mapping: mapping({ ...COMPLETE, '/': { views: ['gone'] } }), viewIds: [VIEW_A, VIEW_B] })
		expect(none.lines.join('\n')).toContain('UNKNOWN   /: none of its Views exist: gone')
	})

	it('fails on an empty View list, an exemption without a reason, a todo without an issue and an entry of two kinds', () => {
		for (const [entry, message] of [
			[{ views: [] }, 'maps to no View'],
			[{ exempt: '  ' }, 'exemption without a reason'],
			[{ todo: 'later' }, 'names no issue'],
			[{ views: [VIEW_A], exempt: 'both' }, 'exactly one of views, exempt, todo'],
		] as const) {
			const result = assessRoutes({ pages: PAGES, mapping: mapping({ ...COMPLETE, '/members': entry }), viewIds: [VIEW_A, VIEW_B] })
			expect(result.status, JSON.stringify(entry)).toBe('fail')
			expect(result.lines.join('\n')).toContain(message)
		}
	})

	it('warns, and does not fail, on a todo that names an issue', () => {
		const result = assessRoutes({ pages: PAGES, mapping: mapping({ ...COMPLETE, '/preview': { todo: 'Preview host states have no View yet (#409)' } }), viewIds: [VIEW_A, VIEW_B] })
		expect(result.status).toBe('warn')
		expect(result.counts).toEqual({ mapped: 3, exempt: 0, todo: 1 })
		expect(result.lines.join('\n')).toContain('TODO      /preview (app/pages/preview.vue): Preview host states have no View yet (#409)')
		const report = createReport()
		report.add('route-coverage', 'Routes', result.status, result.lines)
		expect(report.failed).toBe(false)
		expect(formatReport(report)).toContain('WARN  Routes')
		expect(formatSummaryMarkdown(report)).toContain('| Routes | warn |')
	})

	it('fails on an entry for a route that has no page any more', () => {
		const result = assessRoutes({ pages: PAGES, mapping: mapping({ ...COMPLETE, '/removed': { views: [VIEW_A] } }), viewIds: [VIEW_A, VIEW_B] })
		expect(result.status).toBe('fail')
		expect(result.lines.join('\n')).toContain('STALE     /removed')
	})

	it('fails on a mapping file without routes', () => {
		expect(assessRoutes({ pages: PAGES, mapping: {}, viewIds: [] }).status).toBe('fail')
		expect(assessRoutes({ pages: PAGES, mapping: undefined, viewIds: [] }).status).toBe('fail')
	})

	// The repository's own pages against its own mapping file and dogfood Views: a new page without an entry fails here, not only in CI.
	it('maps every page of app/pages/ in the repository, to Views that exist', () => {
		const root = join(__dirname, '..')
		const viewIds = readdirSync(join(root, '.uiux', 'views')).filter(name => name.endsWith('.view.json')).map(name => name.slice(0, -'.view.json'.length))
		const result = assessRoutes({
			pages: enumeratePages(join(root, 'app', 'pages')),
			mapping: JSON.parse(readFileSync(join(root, ROUTE_MAP_FILE), 'utf8')),
			viewIds,
		})
		expect(result.lines.filter(line => !line.startsWith('TODO') && !/^\d+ page/.test(line)), result.lines.join('\n')).toEqual([])
		expect(result.status).not.toBe('fail')
	})
})
