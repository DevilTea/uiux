import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { contextKey as appContextKey } from '../app/utils/readiness'
import {
	CheckError,
	PHASE_3_CHECKS,
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
		for (const check of PHASE_3_CHECKS) report.add(check.id, check.title, 'skip', ['not built yet'])
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

	it('names the phase 3 checks it does not run yet', () => {
		expect(PHASE_3_CHECKS.map(check => check.id)).toEqual(['requirement-coverage', 'route-coverage'])
	})
})
