import { isStyleSpecifier, type ProductKit } from '../../src/domain/product-kit/schema'
import { themeAttributeNameProblem } from '../../src/domain/product-kit/theme-attributes'
import { nextRowUid } from './workspace-authoring'

/**
 * The draft of the Styles & themes section of the Product Kit page: the Product Kit file's `styles`
 * (Clause 01a11bb1-8e98-7270-9662-682c048f9929) and `themes` (Clause 01a11bb1-8efc-77df-a0bb-78033bb35d56),
 * saved through `update_product_kit`. Rows carry a `uid` so a list can be reordered and edited in
 * place; the payload is what the Product Kit file holds.
 *
 * The draft is checked with the validator's own functions (`isStyleSpecifier`,
 * `themeAttributeNameProblem`), so a name the server would refuse is refused inline first. What only
 * the kit project can tell (a declared package, a file of the build output, a CSS file) stays the
 * server's to refuse.
 */
export type StyleRow = { uid: string; specifier: string }
export type ThemeAttributeRow = { uid: string; name: string; value: string }
export type ThemeMapping = { id: string; attributes: ThemeAttributeRow[] }
export type StylesThemesDraft = { styles: StyleRow[]; themes: ThemeMapping[] }
export type StylesThemesPayload = Readonly<{ styles: string[]; themes: Record<string, Record<string, string>> }>

export function stylesThemesDraft(kit: Pick<ProductKit, 'styles' | 'themes'>): StylesThemesDraft {
	return {
		styles: kit.styles.map(specifier => ({ uid: nextRowUid(), specifier })),
		themes: Object.entries(kit.themes).map(([id, attributes]) => ({
			id,
			attributes: Object.entries(attributes).map(([name, value]) => ({ uid: nextRowUid(), name, value })),
		})),
	}
}

/** The draft as `update_product_kit` takes it; specifiers and attribute names are trimmed. */
export function stylesThemesPayload(draft: StylesThemesDraft): StylesThemesPayload {
	const themes: Record<string, Record<string, string>> = {}
	for (const theme of draft.themes) {
		const attributes: Record<string, string> = {}
		for (const row of theme.attributes) attributes[row.name.trim()] = row.value
		themes[theme.id] = attributes
	}
	return { styles: draft.styles.map(row => row.specifier.trim()), themes }
}

export type StyleIssue = 'required' | 'invalid'
export type ThemeAttributeIssue = 'required' | 'duplicate' | 'product_kit.invalid_theme_attribute' | 'product_kit.theme_attribute_not_allowed'

export function styleIssue(row: StyleRow): StyleIssue | undefined {
	const specifier = row.specifier.trim()
	if (!specifier) return 'required'
	return isStyleSpecifier(specifier) ? undefined : 'invalid'
}

/** Each attribute row's problem, by its `uid`. */
export function themeAttributeIssues(theme: ThemeMapping): Map<string, ThemeAttributeIssue> {
	const issues = new Map<string, ThemeAttributeIssue>()
	const seen = new Set<string>()
	for (const row of theme.attributes) {
		const name = row.name.trim()
		const problem = name ? themeAttributeNameProblem(name) : 'required'
		if (problem) issues.set(row.uid, problem)
		else if (seen.has(name)) issues.set(row.uid, 'duplicate')
		seen.add(name)
	}
	return issues
}

/** True when nothing in the draft would be refused for its form. */
export function stylesThemesValid(draft: StylesThemesDraft): boolean {
	return draft.styles.every(row => !styleIssue(row)) && draft.themes.every(theme => themeAttributeIssues(theme).size === 0)
}

export function newStyleRow(): StyleRow {
	return { uid: nextRowUid(), specifier: '' }
}

export function newThemeAttributeRow(name = ''): ThemeAttributeRow {
	return { uid: nextRowUid(), name, value: '' }
}
