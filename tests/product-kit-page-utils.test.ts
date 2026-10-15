import { describe, expect, it } from 'vitest'
import { componentDeclarations, MAX_DECLARATION_LENGTH } from '../app/utils/component-interface'
import { kitFileTree, kitPathAncestors, visibleKitTreeRows } from '../app/utils/kit-file-tree'
import { styleIssue, stylesThemesDraft, stylesThemesPayload, stylesThemesValid, themeAttributeIssues } from '../app/utils/product-kit-styles'
import { parseProductKitSection } from '../app/utils/workbench-routes'
import { emptyProductKit, validateProductKit } from '../src/domain/product-kit/schema'
import { themeAttributeNameProblem } from '../src/domain/product-kit/theme-attributes'

/**
 * The pure parts of the Product Kit page's Components, Styles & themes and Files sections (issue #141,
 * unit K13): the section query (Clause 01a11be8-5cab-7e50-89fe-b89c243d773d), the styles and themes
 * draft checked with the validator's own rules (Clauses 01a11bb1-8e98-7270-9662-682c048f9929 and
 * 01a11bb1-8efc-77df-a0bb-78033bb35d56), the kit file tree, and the props and emits declarations.
 */

describe('Product Kit page › section query', () => {
	it('takes overview, components, styles and files, and nothing else', () => {
		for (const section of ['overview', 'components', 'styles', 'files'])
			expect(parseProductKitSection({ section })).toBe(section)
		expect(parseProductKitSection({ section: 'adapters' })).toBeUndefined()
		expect(parseProductKitSection({ section: ['styles', 'files'] })).toBe('styles')
		expect(parseProductKitSection({})).toBeUndefined()
	})
})

describe('Product Kit page › theme attribute names', () => {
	const names = ['class', 'data-theme', 'data-x', 'data-Theme', 'data-', 'style', 'onclick', 'href', 'data theme', 'data-"x"', 'a=b', 'data-\u0001', '']
	it('refuses inline exactly what the Product Kit validator refuses, with the same code', () => {
		for (const name of names.filter(Boolean)) {
			const validation = validateProductKit({ ...emptyProductKit(), themes: { dark: { [name]: 'x' } } })
			const code = validation.ok ? undefined : validation.diagnostics[0]!.code
			expect(themeAttributeNameProblem(name), name).toBe(code)
		}
	})

	it('names each row\'s problem: empty, refused or set twice', () => {
		const issues = themeAttributeIssues({
			id: 'dark',
			attributes: [
				{ uid: 'a', name: 'data-theme', value: 'dark' },
				{ uid: 'b', name: ' data-theme ', value: 'x' },
				{ uid: 'c', name: 'style', value: 'color: red' },
				{ uid: 'd', name: 'data-Mode', value: '' },
				{ uid: 'e', name: 'a b', value: '' },
				{ uid: 'f', name: '  ', value: '' },
			],
		})
		expect(Object.fromEntries(issues)).toEqual({
			b: 'duplicate',
			c: 'product_kit.theme_attribute_not_allowed',
			d: 'product_kit.theme_attribute_not_allowed',
			e: 'product_kit.invalid_theme_attribute',
			f: 'required',
		})
	})
})

describe('Product Kit page › styles', () => {
	it('checks a specifier with the validator\'s rule', () => {
		expect(styleIssue({ uid: '1', specifier: '' })).toBe('required')
		expect(styleIssue({ uid: '1', specifier: './dist/theme.css' })).toBeUndefined()
		expect(styleIssue({ uid: '1', specifier: 'fake-ds/styles.css' })).toBeUndefined()
		expect(styleIssue({ uid: '1', specifier: '../outside.css' })).toBe('invalid')
		expect(styleIssue({ uid: '1', specifier: './a/../b.css' })).toBe('invalid')
		expect(styleIssue({ uid: '1', specifier: '/abs.css' })).toBe('invalid')
		expect(styleIssue({ uid: '1', specifier: 'https://example.com/a.css' })).toBe('invalid')
	})

	it('round-trips the Product Kit file\'s styles and themes, trimming names', () => {
		const kit = { styles: ['fake-ds/styles.css', './dist/theme.css'], themes: { dark: { 'class': 'dark', 'data-theme': 'dark' }, light: {} } }
		const draft = stylesThemesDraft(kit)
		expect(stylesThemesPayload(draft)).toEqual(kit)
		expect(stylesThemesValid(draft)).toBe(true)
		draft.styles[0]!.specifier = ' fake-ds/styles.css '
		draft.themes[0]!.attributes[0]!.name = ' class '
		expect(stylesThemesPayload(draft)).toEqual(kit)
		draft.themes[1]!.attributes.push({ uid: 'x', name: 'onload', value: 'x' })
		expect(stylesThemesValid(draft)).toBe(false)
	})
})

describe('Product Kit page › kit file tree', () => {
	const files = [
		{ path: 'package.json', size: 10 },
		{ path: 'src/button/Button.vue', size: 20 },
		{ path: 'src/a.css', size: 5 },
		{ path: 'dist/index.js', size: 7 },
		{ path: 'adapters/reference.ts', size: 30 },
	]

	it('lists directories first, then files, each by name', () => {
		const tree = kitFileTree(files)
		expect(tree.map(node => `${node.kind}:${node.path}`)).toEqual(['directory:adapters', 'directory:dist', 'directory:src', 'file:package.json'])
		const src = tree[2]!
		expect(src.kind === 'directory' && src.children.map(node => node.path)).toEqual(['src/button', 'src/a.css'])
	})

	it('shows the children of expanded directories only', () => {
		const tree = kitFileTree(files)
		expect(visibleKitTreeRows(tree, new Set()).map(row => row.node.path)).toEqual(['adapters', 'dist', 'src', 'package.json'])
		const rows = visibleKitTreeRows(tree, new Set(['src', 'src/button']))
		expect(rows.map(row => `${row.level}:${row.node.path}`)).toEqual(['1:adapters', '1:dist', '1:src', '2:src/button', '3:src/button/Button.vue', '2:src/a.css', '1:package.json'])
		expect(kitPathAncestors('src/button/Button.vue')).toEqual(['src', 'src/button'])
		expect(kitPathAncestors('package.json')).toEqual([])
	})
})

describe('Product Kit page › props and emits', () => {
	it('finds each defineProps and defineEmits call of a Vue file as written', () => {
		const source = [
			'<script setup lang="ts">',
			'import { defineProps } from \'vue\'',
			'// defineProps is a compiler macro',
			'const props = withDefaults(defineProps<{ label: string; onPress?: (event: MouseEvent) => void; tone?: \'a\' | \'b)\' }>(), { tone: \'a\' })',
			'const emit = defineEmits<(e: \'change\', id: number) => void>()',
			'</script>',
		].join('\n')
		const found = componentDeclarations('src/button/Button.vue', source)
		expect(found).toEqual([
			{ kind: 'props', file: 'src/button/Button.vue', text: 'defineProps<{ label: string; onPress?: (event: MouseEvent) => void; tone?: \'a\' | \'b)\' }>()' },
			{ kind: 'emits', file: 'src/button/Button.vue', text: 'defineEmits<(e: \'change\', id: number) => void>()' },
		])
	})

	it('reads the runtime forms, ignores other files, and cuts a long declaration', () => {
		expect(componentDeclarations('a.vue', 'defineProps({ size: { type: String, default: \'md\' } })\ndefineEmits([\'close\'])').map(item => item.text))
			.toEqual(['defineProps({ size: { type: String, default: \'md\' } })', 'defineEmits([\'close\'])'])
		expect(componentDeclarations('a.ts', 'defineProps<{ a: string }>()')).toEqual([])
		expect(componentDeclarations('a.vue', 'defineProps<{ a: string }>(')).toEqual([])
		const long = componentDeclarations('a.vue', `defineProps<{ ${'a: string; '.repeat(400)} }>()`)[0]!.text
		expect(long).toHaveLength(MAX_DECLARATION_LENGTH + 1)
		expect(long.endsWith('…')).toBe(true)
	})
})
