/**
 * The props and emits a registry component declares, as its source text shows them, for browsing a
 * component on the Product Kit page (Rule 01a11bb1-b918-7cb5-b581-a3fd3f647f09). This is a reading
 * aid, not a parser: it finds each `defineProps` and `defineEmits` call of a Vue single-file
 * component (`withDefaults` included) and returns the call's text as written, so a type named there
 * reads in the file itself. A component written another way shows no declaration here.
 */
export type ComponentDeclaration = Readonly<{ kind: 'props' | 'emits'; file: string; text: string }>

/** The longest declaration shown; a longer one is cut and ends with `…`. */
export const MAX_DECLARATION_LENGTH = 2000

const CALLEE = /\b(defineProps|defineEmits)\b/gu
const OPEN = new Set(['(', '{', '['])
const CLOSE = new Set([')', '}', ']'])

/** The index just past the string or comment starting at `start`, or `start` when none starts there. */
function skipQuoted(source: string, start: number): number {
	const character = source[start]
	if (character === '/' && source[start + 1] === '/') {
		const end = source.indexOf('\n', start)
		return end === -1 ? source.length : end
	}
	if (character === '/' && source[start + 1] === '*') {
		const end = source.indexOf('*/', start + 2)
		return end === -1 ? source.length : end + 2
	}
	if (character !== '"' && character !== '\'' && character !== '`') return start
	let index = start + 1
	while (index < source.length && source[index] !== character) index += source[index] === '\\' ? 2 : 1
	return index + 1
}

/**
 * The end of the call starting at `start` (the callee's first character): past its generic type
 * argument, if any, and the matching `)` of its argument list. `undefined` when the call never closes.
 */
function callEnd(source: string, start: number, calleeLength: number): number | undefined {
	let index = start + calleeLength
	while (/\s/u.test(source[index] ?? '')) index += 1
	// The generic type argument: `<` … `>`, where the `>` of an arrow (`=>`) closes nothing.
	if (source[index] === '<') {
		let angles = 0
		while (index < source.length) {
			const skipped = skipQuoted(source, index)
			if (skipped !== index) {
				index = skipped
				continue
			}
			const character = source[index]!
			if (character === '<') angles += 1
			else if (character === '>' && source[index - 1] !== '=') angles -= 1
			index += 1
			if (angles === 0) break
		}
		while (/\s/u.test(source[index] ?? '')) index += 1
	}
	if (source[index] !== '(') return undefined
	let depth = 0
	while (index < source.length) {
		const skipped = skipQuoted(source, index)
		if (skipped !== index) {
			index = skipped
			continue
		}
		const character = source[index]!
		if (OPEN.has(character)) depth += 1
		else if (CLOSE.has(character)) {
			depth -= 1
			if (depth === 0) return character === ')' ? index + 1 : undefined
		}
		index += 1
	}
	return undefined
}

/** The `defineProps` and `defineEmits` calls of one file, in source order. */
export function componentDeclarations(file: string, source: string): ComponentDeclaration[] {
	if (!file.endsWith('.vue')) return []
	const declarations: ComponentDeclaration[] = []
	for (const match of source.matchAll(CALLEE)) {
		const start = match.index
		// Not a call (`import { defineProps }`, prose naming it): no `(` or `<` follows.
		const end = callEnd(source, start, match[0].length)
		if (end === undefined) continue
		const text = source.slice(start, end)
		declarations.push({
			kind: match[1] === 'defineProps' ? 'props' : 'emits',
			file,
			text: text.length > MAX_DECLARATION_LENGTH ? `${text.slice(0, MAX_DECLARATION_LENGTH)}…` : text,
		})
	}
	return declarations
}
