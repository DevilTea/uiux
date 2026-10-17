import { describe, expect, it } from 'vitest'
import {
	adapterRepair,
	adapterRows,
	adapterSelections,
	buildSettingsPayload,
	collectAssetReferences,
	countMessageChanges,
	diffJson,
	localeCellState,
	localeKeyDiff,
	localeTableKeys,
	moveItem,
	packageNameOf,
	productKitAdapterWrites,
	registryRecord,
	registryRowIssues,
	registryRows,
	sameJson,
} from '../app/utils/workspace-authoring'
import { emptyProductKit, type ProductKit } from '../src/domain/product-kit/schema'
import type { WorkspaceManifest } from '../src/domain/workspace/schema'
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from '../src/product/workspace-schema'

/** Pure rules behind the Workspace authoring pages (roadmap R10, brief g). */

const MANIFEST: WorkspaceManifest = {
	schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
	i18n: { defaultLocale: 'en-US' },
	viewports: {
		mobile: { dimensions: { width: 390, height: 844 }, label: 'Mobile' },
		desktop: { dimensions: { width: 1920, height: 1080 }, label: 'FHD Desktop', note: 'kept' },
		tablet: { dimensions: { width: 1024, height: 768 }, label: 'Tablet' },
	},
	themes: { light: { label: 'Light' }, dark: { label: 'Dark', tokens: { accent: 'iris' } } },
}

describe('Workspace settings payload', () => {
	it('lists Viewports widest first', () => {
		expect(registryRows(MANIFEST.viewports, 'viewports').map(row => row.key)).toEqual(['desktop', 'tablet', 'mobile'])
	})

	it('round-trips registry entries, including fields the page does not edit', () => {
		expect(sameJson(registryRecord(registryRows(MANIFEST.viewports, 'viewports'), 'viewports'), MANIFEST.viewports)).toBe(true)
		expect(sameJson(registryRecord(registryRows(MANIFEST.themes, 'themes'), 'themes'), MANIFEST.themes)).toBe(true)
	})

	it('drops an emptied label instead of writing an empty string', () => {
		const rows = registryRows(MANIFEST.themes, 'themes')
		rows.find(row => row.key === 'dark')!.label = ''
		expect(registryRecord(rows, 'themes').dark).toEqual({ tokens: { accent: 'iris' } })
	})

	it('resends every other section exactly as saved, because the route is a full replace', () => {
		const payload = buildSettingsPayload(MANIFEST, 'themes', { light: {} })
		expect(payload.themes).toEqual({ light: {} })
		expect(payload.viewports).toEqual(MANIFEST.viewports)
		expect(payload.i18n).toEqual(MANIFEST.i18n)
		// The Adapters are the Product Kit file's, never part of the settings.
		expect(Object.keys(payload).sort()).toEqual(['i18n', 'themes', 'viewports'])
	})

	it('flags empty, spaced, duplicate keys and missing dimensions', () => {
		const rows = registryRows(MANIFEST.viewports, 'viewports')
		rows[0]!.key = 'tablet'
		rows[2]!.key = 'my phone'
		rows[2]!.width = null
		const issues = registryRowIssues(rows, 'viewports')
		expect(issues.get(rows[0]!.uid)).toEqual(['keyTaken'])
		expect(issues.get(rows[1]!.uid)).toEqual(['keyTaken'])
		expect(issues.get(rows[2]!.uid)).toEqual(['keyWhitespace', 'dimensionRequired'])
	})

	it('keeps Adapter order and config, and moves items without mutating the input', () => {
		const rows = adapterRows([{ moduleSpecifier: 'a' }, { moduleSpecifier: 'b', config: { x: 1 } }])
		const moved = moveItem(rows, 1, 0)
		expect(adapterSelections(moved)).toEqual([{ moduleSpecifier: 'b', config: { x: 1 } }, { moduleSpecifier: 'a' }])
		expect(rows.map(row => row.moduleSpecifier)).toEqual(['a', 'b'])
		expect(moveItem(rows, 0, 5)).toEqual(rows)
	})

	it('prints repair commands and never for a Workspace-relative module', () => {
		expect(packageNameOf('@scope/pkg/sub')).toBe('@scope/pkg')
		expect(adapterRepair('adapter.resolution_failed', '@scope/pkg/sub')).toEqual({ kind: 'command', command: 'pnpm add @scope/pkg' })
		expect(adapterRepair('adapter.api_version_incompatible', 'widgets')).toEqual({ kind: 'command', command: 'pnpm add widgets@latest' })
		expect(adapterRepair('adapter.resolution_failed', './adapters/missing.ts')).toEqual({ kind: 'file', path: './adapters/missing.ts' })
		expect(adapterRepair('adapter.config_schema_violation', 'widgets')).toBeUndefined()
	})

	it('lists differing leaves for the Compare dialog', () => {
		expect(diffJson({ a: { label: 'A' }, b: {} }, { a: { label: 'B' }, c: {} })).toEqual([
			{ path: '/a/label', theirs: 'A', yours: 'B' },
			{ path: '/b', theirs: '{}', yours: undefined },
			{ path: '/c', theirs: undefined, yours: '{}' },
		])
	})
})

describe('Adapters from schemaVersion 5 (Product Kit file)', () => {
	const KIT: ProductKit = {
		...emptyProductKit(),
		designSystems: ['@acme/ds'],
		adapters: [{ moduleSpecifier: './a.ts', config: { x: 1 } }, { moduleSpecifier: 'b' }, { moduleSpecifier: './a.ts' }],
		styles: ['./styles.css'],
		themes: { dark: { 'data-theme': 'dark' } },
	}

	it('writes nothing for an unchanged selection', () => {
		expect(productKitAdapterWrites(KIT, KIT.adapters)).toEqual({})
	})

	it('changes only configs with update_product_kit, resending styles and themes', () => {
		const selections = [{ moduleSpecifier: './a.ts' }, { moduleSpecifier: 'b', config: { y: 2 } }, { moduleSpecifier: './a.ts' }]
		expect(productKitAdapterWrites(KIT, selections)).toEqual({ update: { adapters: selections, styles: KIT.styles, themes: KIT.themes } })
	})

	it('reorders with compose_product_kit alone when each entry keeps the config of its occurrence', () => {
		const selections = [{ moduleSpecifier: 'b' }, { moduleSpecifier: './a.ts', config: { x: 1 } }, { moduleSpecifier: './a.ts' }]
		expect(productKitAdapterWrites(KIT, selections)).toEqual({ compose: { designSystems: ['@acme/ds'], adapters: ['b', './a.ts', './a.ts'] } })
	})

	it('adds an Adapter with compose_product_kit, then gives it its config with update_product_kit', () => {
		const selections = [...KIT.adapters, { moduleSpecifier: '@acme/widgets', config: { z: true } }]
		expect(productKitAdapterWrites(KIT, selections)).toEqual({
			compose: { designSystems: ['@acme/ds'], adapters: ['./a.ts', 'b', './a.ts', '@acme/widgets'] },
			update: { adapters: selections, styles: KIT.styles, themes: KIT.themes },
		})
	})
})

describe('Locale key diff', () => {
	const en = { 'a.title': 'Title', 'a.cta': 'Pay', 'a.empty': '' }
	const zh = { 'a.title': '標題', 'a.cta': ' ', 'z.extra': '多' }

	it('marks empty, whitespace-only and missing cells', () => {
		expect(localeCellState(en['a.empty'])).toBe('empty')
		expect(localeCellState(zh['a.cta'])).toBe('whitespace')
		expect(localeCellState(undefined)).toBe('missing')
		expect(localeCellState('Pay')).toBe('value')
	})

	it('names missing and extra keys against the primary Locale', () => {
		expect(localeKeyDiff(en, zh)).toEqual({ missing: ['a.empty'], extra: ['z.extra'] })
		expect(localeKeyDiff(en, en)).toEqual({ missing: [], extra: [] })
	})

	it('orders rows by the primary Locale, then keys only others have', () => {
		expect(localeTableKeys('en-US', { 'en-US': en, 'zh-TW': zh })).toEqual(['a.title', 'a.cta', 'a.empty', 'z.extra'])
	})

	it('counts added, removed and changed keys', () => {
		expect(countMessageChanges(en, { ...en, 'a.title': 'New', 'b.new': '' })).toBe(2)
		expect(countMessageChanges(en, { 'a.title': 'Title' })).toBe(2)
	})
})

describe('Asset usage', () => {
	it('finds every $asset binding in a View', () => {
		const view = { ir: { props: { icon: { $asset: 'one' } }, slots: { content: [{ props: { image: { $asset: 'two' }, list: [{ $asset: 'one' }] } }] } } }
		expect([...collectAssetReferences(view)].sort()).toEqual(['one', 'two'])
	})
})
