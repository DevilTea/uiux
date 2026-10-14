/** `data-` and then at least one character that an HTML attribute name may hold. */
// eslint-disable-next-line no-control-regex
const DATA_ATTRIBUTE_NAME = /^data-[^\s"'>/=\u0000-\u001F\u007F]+$/u

/**
 * The root attribute names a Product Kit theme may set on the Preview document element (Clause
 * 01a11bb1-8efc-77df-a0bb-78033bb35d56): `class` and `data-*`, nothing else, so a theme can never set
 * an event handler, a `style` or a URL-bearing attribute on a same-origin document. The Product Kit
 * validator refuses any other name; the Preview runtime ignores one that reaches it anyway.
 */
export function isAllowedThemeAttributeName(name: string): boolean {
	return name === 'class' || DATA_ATTRIBUTE_NAME.test(name)
}
