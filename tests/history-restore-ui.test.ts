import { describe, expect, it } from 'vitest'
import { RESTORABLE_RESOURCE_KINDS } from '../src/domain/history/constants'
import { RESTORABLE_RESOURCE_KINDS as SERVICE_KINDS } from '../src/application/services/history-restore'
import type { ImpactItem } from '../src/domain/impact/analyzer'
import { diffWorkspaceSettings } from '../src/domain/history/diff/settings'
import type { JsonValue } from '../src/domain/validation'
import { comparisonRefreshKey, forgetComparisonsAfterDeletion, refreshKeyChanged } from '../app/utils/comparison-refresh'
import { diffRequestQuery } from '../app/utils/version-history'
import { classifyRestoreAnswer, groupImpacts, matchesCurrent, restoreExtraKeys, restoreSourceVersion, shortId, type RestoreGateInput } from '../app/utils/version-restore'

/**
 * The Workbench restore's pure parts (issue #132, B10): when a resource's diff offers "Restore this
 * version" (Rules 01a11a5e-18f2-7991-8f7d-aa4c8015d14a and 01a11a5e-1bfa-71e9-9611-152b5b665379),
 * the impact list's grouping (Rules 01a11a5e-174b-… and 17a0-…), and two B8 follow-ups: a cold
 * comparison with `current` is read once, and deleting a Checkpoint drops the cached comparisons
 * whose parent it may have been.
 */

const SELECTED = '00000000-0000-4000-8000-00000000000a'
const OTHER = '00000000-0000-4000-8000-00000000000b'

function gate(overrides: Partial<RestoreGateInput> = {}): RestoreGateInput {
	return {
		desktop: true,
		canWrite: () => true,
		resource: { kind: 'view', status: 'modified' },
		selectedVersion: SELECTED,
		endpoints: { from: 'parent', to: SELECTED },
		...overrides,
	}
}

describe('the restore gate', () => {
	it('restores the selected version, whichever side of the comparison it is', () => {
		expect(restoreSourceVersion(gate())).toBe(SELECTED)
		expect(restoreSourceVersion(gate({ endpoints: { from: SELECTED, to: 'current' } }))).toBe(SELECTED)
		expect(restoreSourceVersion(gate({ endpoints: { from: OTHER, to: SELECTED } }))).toBe(SELECTED)
		expect(restoreSourceVersion(gate({ endpoints: { from: SELECTED, to: OTHER } }))).toBe(SELECTED)
	})

	it('is offered only on a desktop layout to a member who may write', () => {
		expect(restoreSourceVersion(gate({ desktop: false }))).toBeUndefined()
		expect(restoreSourceVersion(gate({ canWrite: () => false }))).toBeUndefined()
	})

	it('needs `history.restore` and the write key of the restored kind, each on its own (Rule 01a11c09-c648)', () => {
		const holding = (...keys: string[]) => (key: string) => keys.includes(key)
		for (const [kind, writeKey] of [['view', 'views.write'], ['flow', 'flows.write'], ['locale', 'locales.write'], ['asset', 'assets.write'], ['workspace', 'settings.write']] as const) {
			const resource = { kind, status: 'modified' as const }
			expect(restoreSourceVersion(gate({ resource, canWrite: holding('history.restore', writeKey) })), kind).toBe(SELECTED)
			expect(restoreSourceVersion(gate({ resource, canWrite: holding(writeKey) })), `${kind} without history.restore`).toBeUndefined()
			expect(restoreSourceVersion(gate({ resource, canWrite: holding('history.restore') })), `${kind} without ${writeKey}`).toBeUndefined()
		}
		// A translator-like member restores a Locale but not a View.
		const translator = holding('history.restore', 'locales.write')
		expect(restoreSourceVersion(gate({ resource: { kind: 'locale', status: 'modified' }, canWrite: translator }))).toBe(SELECTED)
		expect(restoreSourceVersion(gate({ resource: { kind: 'view', status: 'modified' }, canWrite: translator }))).toBeUndefined()
	})

	it('is offered for the restorable kinds only: never a Review thread, a Product Kit, access presets or an unknown kind', () => {
		for (const kind of ['view', 'flow', 'locale', 'asset', 'workspace'])
			expect(restoreSourceVersion(gate({ resource: { kind, status: 'modified' } })), kind).toBe(SELECTED)
		for (const kind of ['review', 'product-kit', 'access-presets', 'widget', ''])
			expect(restoreSourceVersion(gate({ resource: { kind, status: 'modified' } })), kind).toBeUndefined()
		// The Workbench and the restore service share one kind list.
		expect(SERVICE_KINDS).toBe(RESTORABLE_RESOURCE_KINDS)
	})

	it('needs a real selected version, not `current` or `parent`, that is one side of the comparison', () => {
		expect(restoreSourceVersion(gate({ selectedVersion: undefined }))).toBeUndefined()
		expect(restoreSourceVersion(gate({ selectedVersion: 'current', endpoints: { from: OTHER, to: 'current' } }))).toBeUndefined()
		expect(restoreSourceVersion(gate({ selectedVersion: 'parent', endpoints: { from: 'parent', to: 'parent' } }))).toBeUndefined()
		expect(restoreSourceVersion(gate({ endpoints: undefined }))).toBeUndefined()
		expect(restoreSourceVersion(gate({ endpoints: { from: OTHER, to: 'current' } }))).toBeUndefined()
	})

	it('needs the resource to exist in the selected version', () => {
		// The selected version is the newer side: it removed the resource, so it holds nothing to restore.
		expect(restoreSourceVersion(gate({ resource: { kind: 'flow', status: 'removed' } }))).toBeUndefined()
		expect(restoreSourceVersion(gate({ resource: { kind: 'flow', status: 'added' } }))).toBe(SELECTED)
		// The selected version is the older side: a resource added since is not in it.
		const older = { endpoints: { from: SELECTED, to: 'current' } }
		expect(restoreSourceVersion(gate({ ...older, resource: { kind: 'flow', status: 'added' } }))).toBeUndefined()
		// A resource removed since is in it: restoring re-creates it.
		expect(restoreSourceVersion(gate({ ...older, resource: { kind: 'flow', status: 'removed' } }))).toBe(SELECTED)
	})
})

describe('a restore that would change nothing', () => {
	it('is recognized from the comparison of the selected version with the current state', () => {
		const resource = { kind: 'view', key: SELECTED }
		expect(matchesCurrent([{ kind: 'view', key: SELECTED, status: 'unchanged' }], resource)).toBe(true)
		for (const status of ['modified', 'removed', 'added'] as const)
			expect(matchesCurrent([{ kind: 'view', key: SELECTED, status }], resource), status).toBe(false)
		// Another resource unchanged, or the resource not compared at all, says nothing about this one.
		expect(matchesCurrent([{ kind: 'view', key: OTHER, status: 'unchanged' }, { kind: 'flow', key: SELECTED, status: 'unchanged' }], resource)).toBe(false)
		expect(matchesCurrent([], resource)).toBe(false)
	})
})

describe('the restore answer', () => {
	it('classifies what the restore route answers', () => {
		expect(classifyRestoreAnswer(200, { status: 'updated', restoredFrom: SELECTED })).toEqual({ state: 'restored', created: false, restoredFrom: SELECTED })
		expect(classifyRestoreAnswer(201, { status: 'created', restoredFrom: SELECTED })).toEqual({ state: 'restored', created: true, restoredFrom: SELECTED })
		const impacts = [{ category: 'review_anchor_invalidated', reviewId: OTHER, anchor: { viewId: SELECTED, widgetId: 'note' } }]
		expect(classifyRestoreAnswer(409, { status: 'impact_acknowledgement_required', impacts })).toEqual({ state: 'impact', impacts })
		expect(classifyRestoreAnswer(409, { status: 'conflict', currentRevision: 'sha256:x' })).toEqual({ state: 'conflict' })
		expect(classifyRestoreAnswer(423, { status: 'locked', code: 'resource.locked' })).toEqual({ state: 'locked' })
		expect(classifyRestoreAnswer(400, { status: 'invalid', code: 'history.restore_invalid_content' })).toEqual({ state: 'refused', status: 'invalid' })
		expect(classifyRestoreAnswer(404, { status: 'not_found' })).toEqual({ state: 'refused', status: 'not_found' })
		expect(classifyRestoreAnswer(422, { status: 'blocked', code: 'persistence.invalid_json' })).toEqual({ state: 'refused', status: 'blocked' })
		expect(classifyRestoreAnswer(403, { code: 'auth.scope_denied' })).toEqual({ state: 'refused', status: 'denied' })
		expect(classifyRestoreAnswer(500, { status: 'failed' })).toEqual({ state: 'refused', status: 'failed' })
		expect(classifyRestoreAnswer(500, undefined)).toEqual({ state: 'refused', status: 'failed' })
	})
})

describe('the impact list', () => {
	it('groups the analyzer categories in display order, keeping the server order within a group and an unknown category apart', () => {
		const items: (ImpactItem | { category: string })[] = [
			{ category: 'review_anchor_invalidated', reviewId: 'r1', anchor: { viewId: 'v', widgetId: 'a' } },
			{ category: 'review_anchor_revalidated', reviewId: 'r2', anchor: { viewId: 'v', widgetId: 'b' } },
			{ category: 'i18n_reference_dangling', viewId: 'v', i18nKey: 'k', pointers: ['/ir'] },
			{ category: 'asset_reference_dangling', viewId: 'v', assetId: 'a1', pointers: ['/ir'] },
			{ category: 'flow_step_widget_missing', flowId: 'f', stepId: 's', viewId: 'v', widgetIds: ['w'] },
			{ category: 'submission_revision_not_current', reviewId: 'r3', submissionId: 's1', resource: { kind: 'view', key: 'v' }, revision: 'x' },
			{ category: 'render_key_removed', dimension: 'viewport', key: 'mobile', reviewIds: ['r4'] },
			{ category: 'evidence_stale', evidence: 'sha256:abc', reason: 'stale' },
			{ category: 'something_new' },
		]
		const groups = groupImpacts([...items].reverse())
		expect(groups.map(group => group.group)).toEqual(['anchors', 'references', 'flowSteps', 'submissions', 'renderKeys', 'evidence', 'other'])
		expect(groups[0]!.items.map(item => item.category)).toEqual(['review_anchor_revalidated', 'review_anchor_invalidated'])
		expect(groups[1]!.items.map(item => item.category)).toEqual(['asset_reference_dangling', 'i18n_reference_dangling'])
		expect(groupImpacts([])).toEqual([])
	})

	it('shortens thread IDs and Evidence digests', () => {
		expect(shortId('01a11a5e-18f2-7991-8f7d-aa4c8015d14a')).toBe('01a11a5e')
		expect(shortId('sha256:0123456789abcdef')).toBe('01234567')
		expect(shortId('short')).toBe('short')
	})
})

describe('a comparison with the current state on a cold start (B8 follow-up a)', () => {
	/** Feeds the refresh keys a comparison sees, in order, through the same rule `useVersionDiff` watches with. */
	function reloadsFor(keys: readonly (string | undefined)[]): number {
		let reloads = 0
		for (let index = 1; index < keys.length; index++) if (refreshKeyChanged(keys[index], keys[index - 1])) reloads += 1
		return reloads
	}
	const before = { loaded: false, latestVersionId: undefined }
	const listed = (latestVersionId?: string) => ({ loaded: true, latestVersionId })

	it('is not read again when the timeline and the Workbench first arrive, in either order', () => {
		const signature = 'sha256:ws,sha256:view'
		// Timeline first, then the Workbench; then the Workbench first, then the timeline.
		expect(reloadsFor([comparisonRefreshKey(before, ''), comparisonRefreshKey(listed(SELECTED), ''), comparisonRefreshKey(listed(SELECTED), signature)])).toBe(0)
		expect(reloadsFor([comparisonRefreshKey(before, ''), comparisonRefreshKey(before, signature), comparisonRefreshKey(listed(SELECTED), signature)])).toBe(0)
		// A timeline that loads empty (a filter that matches nothing) is an arrival too.
		expect(reloadsFor([comparisonRefreshKey(before, signature), comparisonRefreshKey(listed(), signature)])).toBe(0)
	})

	it('is read again once for each later change of the newest version or the Workbench revisions', () => {
		const keys = [
			comparisonRefreshKey(before, ''),
			comparisonRefreshKey(listed(SELECTED), 'a'),
			comparisonRefreshKey(listed(OTHER), 'a'),
			comparisonRefreshKey(listed(OTHER), 'b'),
			comparisonRefreshKey(listed(OTHER), 'b'),
		]
		expect(reloadsFor(keys)).toBe(2)
	})

	it('is read again on a Workbench change while the loaded timeline lists nothing', () => {
		// The address still selects a version, but the filtered timeline is empty.
		const keys = [
			comparisonRefreshKey(before, ''),
			comparisonRefreshKey(listed(), 'a'),
			comparisonRefreshKey(listed(), 'b'),
			comparisonRefreshKey(listed(SELECTED), 'b'),
		]
		expect(keys.slice(1).every(key => key !== undefined)).toBe(true)
		expect(reloadsFor(keys)).toBe(2)
	})

	it('waits for the timeline after a filter change resets it', () => {
		expect(reloadsFor([comparisonRefreshKey(listed(SELECTED), 'a'), comparisonRefreshKey(before, 'a'), comparisonRefreshKey(listed(OTHER), 'a')])).toBe(0)
	})
})

describe('cached comparisons after a Checkpoint is deleted (B8 follow-up c)', () => {
	it('drops the comparisons with a parent and those naming the deleted version, and keeps the others', () => {
		const deleted = '00000000-0000-4000-8000-0000000000dd'
		const third = '00000000-0000-4000-8000-0000000000cc'
		const key = (from: string, to: string, detail: 'summary' | 'semantic' = 'summary') => JSON.stringify(diffRequestQuery({ from, to }, [], detail))
		const cache = new Map<string, unknown>([
			[key('parent', SELECTED), 1],
			[key('parent', OTHER, 'semantic'), 2],
			[key(deleted, OTHER), 3],
			[key(SELECTED, deleted), 4],
			[key(SELECTED, OTHER), 5],
			[key(third, OTHER, 'semantic'), 6],
		])
		forgetComparisonsAfterDeletion(cache, deleted)
		expect([...cache.values()]).toEqual([5, 6])
	})
})

describe('the keys a Workspace settings restore needs beyond its write key (#140 owner ruling 2026-10-10, 1)', () => {
	const ref = (moduleSpecifier: string, config?: Record<string, string>) => ({ moduleSpecifier, ...(config ? { config } : {}) })
	/** The semantic comparison of a version's manifest (`from`) with the current one, as the dialog reads it. */
	function compared(version: readonly unknown[], current: readonly unknown[], schemaVersion = 4) {
		const diff = diffWorkspaceSettings({ schemaVersion, adapters: version } as JsonValue, { schemaVersion, adapters: current } as JsonValue)
		return { to: { id: 'current' as const, workspaceSchemaVersion: schemaVersion }, changes: [{ kind: 'workspace', key: 'workspace', status: 'modified' as const, diff }] }
	}

	it('needs `product-kit.compose` when the restore adds, removes, reorders or re-points an `adapters` entry', () => {
		expect(restoreExtraKeys('workspace', compared([ref('./a.ts')], [ref('./a.ts'), ref('./b.ts')]))).toEqual(['product-kit.compose'])
		expect(restoreExtraKeys('workspace', compared([ref('./a.ts'), ref('./b.ts')], [ref('./a.ts')]))).toEqual(['product-kit.compose'])
		expect(restoreExtraKeys('workspace', compared([ref('./a.ts'), ref('./b.ts')], [ref('./b.ts'), ref('./a.ts')]))).toEqual(['product-kit.compose'])
		expect(restoreExtraKeys('workspace', compared([ref('./a.ts')], [ref('./b.ts')]))).toEqual(['product-kit.compose'])
		// Unmatched by `moduleSpecifier` (a duplicate), the list is compared by position.
		expect(restoreExtraKeys('workspace', compared([ref('./a.ts'), ref('./a.ts')], [ref('./a.ts'), ref('./b.ts')]))).toEqual(['product-kit.compose'])
	})

	it('needs nothing more for a change to an entry\'s `config` alone, for other kinds, from `schemaVersion` 5, or without a comparison', () => {
		expect(restoreExtraKeys('workspace', compared([ref('./a.ts', { tone: 'warm' })], [ref('./a.ts', { tone: 'cold' })]))).toEqual([])
		expect(restoreExtraKeys('workspace', compared([ref('./a.ts', { x: '1' }), ref('./a.ts')], [ref('./a.ts', { x: '2' }), ref('./a.ts')]))).toEqual([])
		expect(restoreExtraKeys('workspace', compared([ref('./a.ts')], [ref('./a.ts')]))).toEqual([])
		expect(restoreExtraKeys('view', compared([ref('./a.ts')], [ref('./b.ts')]))).toEqual([])
		expect(restoreExtraKeys('workspace', compared([ref('./a.ts')], [ref('./b.ts')], 5))).toEqual([])
		expect(restoreExtraKeys('workspace', undefined)).toEqual([])
	})
})
