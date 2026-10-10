import { describe, expect, it } from 'vitest'
import type { VersionListItem } from '../src/application/services/history-service'
import type { ResourceDiff } from '../src/domain/history/diff'
import {
	activityLocation,
	collapseNoNetChange,
	comparisonEndpoints,
	diffRequestQuery,
	distinctActors,
	filterVersions,
	groupVersionsByDay,
	historyQuery,
	parseHistoryAddress,
	parseResourceRef,
	resolveHistorySelection,
	revisionIn,
	systemCheckpointTitle,
	versionListQuery,
} from '../app/utils/version-history'
import { describeResourceDiff, formatDiffValue } from '../app/utils/version-diff'
import { parseViewPanel, viewLocation, viewQuery } from '../app/utils/workbench-routes'

/**
 * The Workbench version timeline's pure parts (issue #132, B8): the history address keys
 * (Clauses 01a11e0d-d74b-701a-9a25-a149e400b7ec and 01a11e0d-d7f5-7ef8-ac22-e235d4a00a41) with the
 * defaults of the owner ruling https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18834723,
 * the timeline's day grouping and no-net-change collapse (Rules 01a11a5e-1946-… and 19f4-…), its
 * filters (Rule 01a11a5e-199c-…) and the per-kind description of the semantic diff (Rule 01a11a5e-11e0-…).
 */

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'

function version(id: string, overrides: Partial<VersionListItem> = {}): VersionListItem {
	return {
		id,
		type: 'autosave',
		name: null,
		actor: { type: 'human', id: 'member:mei', displayName: 'Mei' },
		at: '2026-10-09T10:00:00.000Z',
		parent: null,
		workspaceSchemaVersion: 4,
		netChange: true,
		summary: [{ kind: 'view', key: 'v1', status: 'modified' }],
		...overrides,
	}
}

describe('history address', () => {
	it('reads the keys as written and treats empty or malformed values as omitted', () => {
		expect(parseHistoryAddress({ version: A, compare: 'current', resource: 'view:v1', canvas: 'side' }))
			.toEqual({ version: A, compare: 'current', resource: { kind: 'view', key: 'v1' }, canvas: 'side' })
		expect(parseHistoryAddress({ version: '', compare: ' ', resource: 'view', canvas: 'sideways' })).toEqual({})
		expect(parseHistoryAddress({ version: [A, B] })).toEqual({ version: A })
		expect(parseResourceRef('locale:zh-TW:x')).toEqual({ kind: 'locale', key: 'zh-TW:x' })
		expect(parseResourceRef(':x')).toBeUndefined()
	})

	it('applies the ruled defaults: version alone compares with the parent, no version is the timeline only', () => {
		expect(resolveHistorySelection({ version: A })).toEqual({ version: A, compare: 'parent' })
		expect(resolveHistorySelection({ version: A, compare: B, resource: { kind: 'view', key: 'v1' } }))
			.toEqual({ version: A, compare: B, resource: { kind: 'view', key: 'v1' } })
		expect(resolveHistorySelection({})).toBeUndefined()
		expect(resolveHistorySelection({ compare: 'current' })).toBeUndefined()
		// The canvas comparison is B9; omitted, the change list only.
		expect(resolveHistorySelection({ version: A })).not.toHaveProperty('canvas')
	})

	it('writes back only the keys the address holds, so nothing is added on the reader\'s behalf', () => {
		expect(historyQuery({ version: A })).toEqual({ version: A })
		expect(historyQuery({ version: A, compare: 'current', resource: { kind: 'view', key: 'v1' }, canvas: 'highlight' }, ['version', 'compare', 'resource']))
			.toEqual({ version: A, compare: 'current', resource: 'view:v1' })
		expect(activityLocation({ version: A })).toEqual({ path: '/', query: { tab: 'activity', version: A } })
		// Round trip: what is written parses back to the same address.
		const address = { version: A, compare: B, resource: { kind: 'flow', key: 'f1' } }
		expect(parseHistoryAddress(historyQuery(address) as Record<string, string>)).toEqual(address)
	})

	it('carries the View history panel keys only with panel=history', () => {
		expect(parseViewPanel({ panel: 'history' })).toBe('history')
		expect(viewQuery({ panel: 'history', history: { version: A, compare: 'current', canvas: 'side', resource: { kind: 'view', key: 'x' } } }))
			.toEqual({ panel: 'history', version: A, compare: 'current', canvas: 'side' })
		expect(viewQuery({ panel: 'spec', history: { version: A } })).toEqual({ panel: 'spec' })
		expect(viewLocation('v1', { panel: 'history', history: { version: A } })).toEqual({ path: '/views/v1', query: { panel: 'history', version: A } })
	})

	it('orders the two sides of a comparison', () => {
		expect(comparisonEndpoints({ version: A, compare: 'parent' })).toEqual({ from: 'parent', to: A })
		expect(comparisonEndpoints({ version: A, compare: 'current' })).toEqual({ from: A, to: 'current' })
		const at = (id: string) => ({ [A]: '2026-10-09T10:00:00.000Z', [B]: '2026-10-09T11:00:00.000Z' })[id]
		expect(comparisonEndpoints({ version: A, compare: B }, at)).toEqual({ from: A, to: B })
		expect(comparisonEndpoints({ version: B, compare: A }, at)).toEqual({ from: A, to: B })
		// Unknown times: the compared version is taken as the older side.
		expect(comparisonEndpoints({ version: A, compare: B })).toEqual({ from: B, to: A })
		expect(diffRequestQuery({ from: 'parent', to: A }, [{ kind: 'view', key: 'v1' }]))
			.toEqual({ from: 'parent', to: A, resource: ['view:v1'], detail: 'semantic' })
	})
})

describe('timeline grouping and filters', () => {
	it('groups newest-first versions by day and collapses runs of autosaves with no net change', () => {
		const versions = [
			version('1', { at: '2026-10-09T12:00:00.000Z', type: 'checkpoint', name: 'Ready' }),
			version('2', { at: '2026-10-09T11:00:00.000Z', netChange: false, summary: [] }),
			version('3', { at: '2026-10-09T10:30:00.000Z', netChange: false, summary: [] }),
			version('4', { at: '2026-10-09T10:00:00.000Z' }),
			version('5', { at: '2026-10-08T10:00:00.000Z', netChange: false, summary: [] }),
			version('6', { at: '2026-10-08T09:00:00.000Z', type: 'external', actor: { type: 'external' } }),
		]
		const groups = groupVersionsByDay(versions, at => at.slice(0, 10))
		expect(groups.map(group => group.day)).toEqual(['2026-10-09', '2026-10-08'])
		expect(groups[0]!.entries.map(entry => entry.type === 'version' ? entry.version.id : `quiet:${entry.versions.map(item => item.id).join(',')}`))
			.toEqual(['1', 'quiet:2,3', '4'])
		expect(groups[1]!.entries.map(entry => entry.type === 'version' ? entry.version.id : `quiet:${entry.versions.length}`))
			.toEqual(['quiet:1', '6'])
		// Only an autosave collapses: an external or system version with no net change still shows.
		expect(collapseNoNetChange([version('7', { type: 'external', netChange: false })])).toEqual([{ type: 'version', version: expect.objectContaining({ id: '7' }) }])
	})

	it('filters by actor, by resource kind and to Checkpoints only', () => {
		const versions = [
			version('1', { type: 'checkpoint', name: 'Ready', summary: [{ kind: 'flow', key: 'f', status: 'added' }] }),
			version('2', { actor: { type: 'agent', id: 'member:claude', displayName: 'claude' } }),
			version('3', { type: 'external', actor: { type: 'external' }, summary: [{ kind: 'locale', key: 'en-US', status: 'modified' }] }),
		]
		expect(filterVersions(versions, { checkpointsOnly: true }).map(item => item.id)).toEqual(['1'])
		expect(filterVersions(versions, { actor: 'member:claude' }).map(item => item.id)).toEqual(['2'])
		expect(filterVersions(versions, { actor: 'external' }).map(item => item.id)).toEqual(['3'])
		expect(filterVersions(versions, { kind: 'view' }).map(item => item.id)).toEqual(['2'])
		expect(filterVersions(versions, {}).length).toBe(3)
		expect(distinctActors(versions).map(actor => actor.type)).toEqual(['human', 'agent', 'external'])
		// The server applies the type and actor filters and the projection; the kind filter is the Workbench's.
		expect(versionListQuery({ checkpointsOnly: true, actor: 'member:claude', kind: 'view' }, { resource: { kind: 'view', key: 'v1' }, limit: 50 }))
			.toEqual({ type: ['checkpoint'], actor: 'member:claude', resource: 'view:v1', limit: '50' })
	})

	it('localizes system Checkpoint names by the creating actor and keeps member names as written', () => {
		expect(systemCheckpointTitle({ type: 'checkpoint', name: 'Baseline', actor: { type: 'system', id: 'system:baseline' } })).toEqual({ key: 'baseline' })
		expect(systemCheckpointTitle({ type: 'checkpoint', name: 'Before migration to schemaVersion 4', actor: { type: 'system', id: 'system:migrate' } })).toEqual({ key: 'migrate', target: '4' })
		// A member may name a Checkpoint "Baseline": it is theirs, shown as written.
		expect(systemCheckpointTitle({ type: 'checkpoint', name: 'Baseline', actor: { type: 'human', id: 'member:mei' } })).toBeUndefined()
		expect(systemCheckpointTitle({ type: 'system', name: null, actor: { type: 'system', id: 'system:migrate' } })).toBeUndefined()
	})

	it('finds the revision a version holds for a resource', () => {
		const record = { resources: [{ kind: 'view', key: 'v1', revision: 'sha256:aa', files: {} }] }
		expect(revisionIn(record, { kind: 'view', key: 'v1' })).toBe('sha256:aa')
		expect(revisionIn(record, { kind: 'view', key: 'v2' })).toBeUndefined()
	})
})

describe('semantic diff description', () => {
	it('describes a View diff by Widgets, Variants, Spec and Decisions', () => {
		const diff: ResourceDiff = {
			type: 'view',
			name: { before: 'Checkout', after: 'Pay' },
			widgets: {
				added: [{ id: 'cta', type: 'Button' }],
				removed: [],
				moved: [{ id: 'title', before: { parent: 'root', slot: 'default', index: 0 }, after: { parent: 'root', slot: 'default', index: 1 } }],
				typeChanged: [],
				configChanged: [{ id: 'title', changes: [{ op: 'replace', path: '/config/label', before: 'A', after: 'B' }] }],
			},
			variants: { added: ['compact'], removed: [], stateChanged: [], otherChanged: [] },
			spec: { intent: { after: 'Pay quickly' }, sections: [{ section: 'constraints', added: ['No modal'], removed: [] }], decisions: { added: [], removed: [], changed: [{ id: 'd1', status: { before: 'pending', after: 'decided' } }] } },
		}
		const described = describeResourceDiff(diff)
		expect(described.sections.map(section => section.key)).toEqual(['properties', 'widgets', 'variants', 'spec', 'decisions'])
		expect(described.sections[0]!.items).toEqual([{ op: 'changed', field: 'name', before: 'Checkout', after: 'Pay' }])
		expect(described.sections[1]!.items.map(item => [item.op, item.label])).toEqual([['added', '#cta'], ['moved', '#title'], ['changed', '#title']])
		expect(described.sections[1]!.items[1]).toMatchObject({ before: '#root › default [0]', after: '#root › default [1]' })
		expect(described.sections[3]!.items).toEqual([{ op: 'added', field: 'intent', after: 'Pay quickly' }, { op: 'added', field: 'constraints', after: 'No modal' }])
		expect(described.sections[4]!.items).toEqual([{ op: 'changed', field: 'status', before: 'pending', after: 'decided', label: 'd1' }])
	})

	it('describes the other kinds and the fallbacks', () => {
		expect(describeResourceDiff({ type: 'locale', messages: { added: [{ key: 'hi', value: 'Hi' }], removed: [], changed: [{ key: 'bye', before: 'Bye', after: 'Goodbye' }] } }).sections)
			.toEqual([{ key: 'messages', items: [{ op: 'added', label: 'hi', after: 'Hi' }, { op: 'changed', label: 'bye', before: 'Bye', after: 'Goodbye' }] }])
		expect(describeResourceDiff({ type: 'flow', steps: { added: [{ stepId: 's2', step: {} }], removed: [], changed: [{ stepId: 's1', target: { before: 'a', after: 'b' } }] } }).sections[0]!.items)
			.toEqual([{ op: 'added', label: 's2' }, { op: 'changed', field: 'target', before: 'a', after: 'b', label: 's1' }])
		expect(describeResourceDiff({ type: 'workspace', defaultLocale: { before: 'en-US', after: 'zh-TW' }, viewports: { added: [{ key: 'watch', value: {} }], removed: [], changed: [] } }).sections.map(section => section.key))
			.toEqual(['i18n', 'viewports'])
		const asset = describeResourceDiff({ type: 'asset', content: { before: 'sha256:a', after: 'sha256:b' }, image: { before: { digest: 'sha256:a', mediaType: 'image/png' }, after: { digest: 'sha256:b', mediaType: 'image/png' } } })
		expect(asset.image?.after?.digest).toBe('sha256:b')
		expect(asset.sections).toEqual([{ key: 'content', items: [{ op: 'changed', field: 'content', before: 'sha256:a', after: 'sha256:b' }] }])
		expect(describeResourceDiff({ type: 'structural', changes: [{ op: 'remove', path: '/x', before: 1 }] }).sections)
			.toEqual([{ key: 'structure', items: [{ op: 'removed', label: '/x', before: 1 }] }])
		expect(describeResourceDiff({ type: 'opaque', files: [{ path: 'views/a.bin', after: 'sha256:c' }] }).sections[0]!.items)
			.toEqual([{ op: 'added', label: 'views/a.bin', after: 'sha256:c' }])
		expect(describeResourceDiff({ type: 'unsupported_kind' })).toEqual({ sections: [], unsupported: true })
		expect(formatDiffValue({ a: 1 })).toBe('{"a":1}')
		expect(formatDiffValue('x'.repeat(200))).toHaveLength(160)
	})
})
