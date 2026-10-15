/**
 * `data-` and then at least one character that an HTML attribute name may hold, with no ASCII
 * uppercase letter: HTML lowercases attribute names, so `data-X` and `data-x` would name one attribute.
 */
// eslint-disable-next-line no-control-regex
const DATA_ATTRIBUTE_NAME = /^data-[^\s"'>/=A-Z\u0000-\u001F\u007F]+$/u

/**
 * The root attribute names a Product Kit theme may set on the Preview document element (Clause
 * 01a11bb1-8efc-77df-a0bb-78033bb35d56): `class` and lowercase `data-*`, nothing else, so a theme can never set
 * an event handler, a `style` or a URL-bearing attribute on a same-origin document. The Product Kit
 * validator refuses any other name; the Preview runtime ignores one that reaches it anyway.
 */
export function isAllowedThemeAttributeName(name: string): boolean {
	return name === 'class' || DATA_ATTRIBUTE_NAME.test(name)
}

/** An HTML attribute name: non-empty, without whitespace, `"`, `'`, `>`, `/`, `=` or an ASCII control character. */
// eslint-disable-next-line no-control-regex
const HTML_ATTRIBUTE_NAME = /^[^\s"'>/=\u0000-\u001F\u007F]+$/u

/**
 * The code the Product Kit validator refuses a theme root attribute name with, or `undefined` when it
 * accepts the name. The Workbench checks a draft with the same function before it saves.
 */
export function themeAttributeNameProblem(name: string): 'product_kit.invalid_theme_attribute' | 'product_kit.theme_attribute_not_allowed' | undefined {
	if (!HTML_ATTRIBUTE_NAME.test(name)) return 'product_kit.invalid_theme_attribute'
	if (!isAllowedThemeAttributeName(name)) return 'product_kit.theme_attribute_not_allowed'
	return undefined
}
