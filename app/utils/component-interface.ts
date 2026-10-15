/**
 * The props and emits a registry component declares, as its source text shows them, for browsing a
 * component on the Product Kit page (Rule 01a11bb1-b918-7cb5-b581-a3fd3f647f09). This is a reading
 * aid, not a parser: it finds each `defineProps` and `defineEmits` call of a Vue single-file
 * component (`withDefaults` included) and returns the call's text as written, so a type named there
 * reads in the file itself. A component written another way shows no declaration here.
 *
 * The work is bounded, since a kit file may hold up to 8 MiB and this runs in the viewer's tab: one
 * call's closing `)` is looked for within `MAX_DECLARATION_SCAN` characters of its callee, and one
 * file's calls scan at most `MAX_FILE_SCAN` characters in all. A file that runs into either bound is
 * `complete: false`; the declarations found are still returned.
 */
export type ComponentDeclaration = Readonly<{ kind: 'props' | 'emits'; file: string; text: string }>
export type FileDeclarations = Readonly<{ declarations: ComponentDeclaration[]; complete: boolean }>

/** The longest declaration shown; a longer one is cut and ends with `…`. */
export const MAX_DECLARATION_LENGTH = 2000
/** How far past its callee one call's closing `)` is looked for. */
export const MAX_DECLARATION_SCAN = 8 * MAX_DECLARATION_LENGTH
/** How many characters one file's calls may scan in all. */
export const MAX_FILE_SCAN = 64 * MAX_DECLARATION_LENGTH

const CALLEE = /\b(defineProps|defineEmits)\b/gu
const OPEN = new Set(['(', '{', '['])
const CLOSE = new Set([')', '}', ']'])

/** The index just past the string or comment starting at `start`, or `start` when none starts there. */
function skipQuoted(text: string, start: number): number {
	const character = text[start]
	if (character === '/' && text[start + 1] === '/') {
		const end = text.indexOf('\n', start)
		return end === -1 ? text.length : end
	}
	if (character === '/' && text[start + 1] === '*') {
		const end = text.indexOf('*/', start + 2)
		return end === -1 ? text.length : end + 2
	}
	if (character !== '"' && character !== '\'' && character !== '`') return start
	let index = start + 1
	while (index < text.length && text[index] !== character) index += text[index] === '\\' ? 2 : 1
	return index + 1
}

/**
 * Where the call at the start of `text` (its callee, `calleeLength` long) ends: past its generic type
 * argument, if any, and the matching `)` of its argument list. `end` is `undefined` when the call
 * does not close within `text`; `scanned` is how far the search went.
 */
function callEnd(text: string, calleeLength: number): Readonly<{ end?: number; scanned: number }> {
	let index = calleeLength
	while (/\s/u.test(text[index] ?? '')) index += 1
	// The generic type argument: `<` … `>`, where the `>` of an arrow (`=>`) closes nothing.
	if (text[index] === '<') {
		let angles = 0
		while (index < text.length) {
			const skipped = skipQuoted(text, index)
			if (skipped !== index) {
				index = skipped
				continue
			}
			const character = text[index]!
			if (character === '<') angles += 1
			else if (character === '>' && text[index - 1] !== '=') angles -= 1
			index += 1
			if (angles === 0) break
		}
		while (/\s/u.test(text[index] ?? '')) index += 1
	}
	if (text[index] !== '(') return { scanned: Math.min(index, text.length) }
	let depth = 0
	while (index < text.length) {
		const skipped = skipQuoted(text, index)
		if (skipped !== index) {
			index = skipped
			continue
		}
		const character = text[index]!
		if (OPEN.has(character)) depth += 1
		else if (CLOSE.has(character)) {
			depth -= 1
			if (depth === 0) return character === ')' ? { end: index + 1, scanned: index + 1 } : { scanned: index + 1 }
		}
		index += 1
	}
	return { scanned: text.length }
}

/** The `defineProps` and `defineEmits` calls of one file, in source order, within the scan bounds. */
export function componentDeclarations(file: string, source: string): FileDeclarations {
	if (!file.endsWith('.vue')) return { declarations: [], complete: true }
	const declarations: ComponentDeclaration[] = []
	let budget = MAX_FILE_SCAN
	let complete = true
	for (const match of source.matchAll(CALLEE)) {
		if (budget <= 0) return { declarations, complete: false }
		const start = match.index
		const window = Math.min(MAX_DECLARATION_SCAN, budget)
		const limit = Math.min(source.length, start + window)
		// Not a call (`import { defineProps }`, prose naming it): no `(` or `<` follows.
		const { end, scanned } = callEnd(source.slice(start, limit), match[0].length)
		budget -= Math.max(scanned, match[0].length)
		if (end === undefined) {
			// Stopped at a bound rather than at the end of the file: the call may close further on.
			if (scanned >= window && limit < source.length) complete = false
			continue
		}
		const text = source.slice(start, start + end)
		declarations.push({
			kind: match[1] === 'defineProps' ? 'props' : 'emits',
			file,
			text: text.length > MAX_DECLARATION_LENGTH ? `${text.slice(0, MAX_DECLARATION_LENGTH)}…` : text,
		})
	}
	return { declarations, complete }
}
