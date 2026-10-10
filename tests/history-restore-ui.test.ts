import { describe, expect, it } from 'vitest'
import { RESTORABLE_RESOURCE_KINDS } from '../src/domain/history/constants'
import { RESTORABLE_RESOURCE_KINDS as SERVICE_KINDS } from '../src/application/services/history-restore'
import type { ImpactItem } from '../src/domain/impact/analyzer'
import { comparisonRefreshKey, forgetComparisonsAfterDeletion, refreshKeyChanged } from '../app/utils/comparison-refresh'
import { diffRequestQuery } from '../app/utils/version-history'
import { classifyRestoreAnswer, groupImpacts, restoreSourceVersion, shortId, type RestoreGateInput } from '../app/utils/version-restore'

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
		canAuthor: true,
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

	it('is offered only on a desktop layout to a member who may author', () => {
		expect(restoreSourceVersion(gate({ desktop: false }))).toBeUndefined()
		expect(restoreSourceVersion(gate({ canAuthor: false }))).toBeUndefined()
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

	it('is not read again when the timeline and the Workbench first arrive, in either order', () => {
		const signature = 'sha256:ws,sha256:view'
		// Timeline first, then the Workbench; then the Workbench first, then the timeline.
		expect(reloadsFor([comparisonRefreshKey(undefined, ''), comparisonRefreshKey(SELECTED, ''), comparisonRefreshKey(SELECTED, signature)])).toBe(0)
		expect(reloadsFor([comparisonRefreshKey(undefined, ''), comparisonRefreshKey(undefined, signature), comparisonRefreshKey(SELECTED, signature)])).toBe(0)
	})

	it('is read again once for each later change of the newest version or the Workbench revisions', () => {
		const keys = [
			comparisonRefreshKey(undefined, ''),
			comparisonRefreshKey(SELECTED, 'a'),
			comparisonRefreshKey(OTHER, 'a'),
			comparisonRefreshKey(OTHER, 'b'),
			comparisonRefreshKey(OTHER, 'b'),
		]
		expect(reloadsFor(keys)).toBe(2)
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
