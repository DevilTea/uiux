import { isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Masking of host paths in messages a Resource or a diagnostic repeats (an error's message, say).
 *
 * The rule is deliberately conservative: once an absolute path starts, it runs to the end of the
 * line, a quote, the start of another path, or path-terminating punctuation (`.,;:!?)]}>|` followed
 * by the end, a quote, or whitespace and a word with no path separator). A path may hold spaces,
 * tabs, apostrophes (`o'brien`) and punctuation before a space (`/Users/J. Smith/x`), and the next
 * word cannot tell a path with spaces (`/Users/John Smith`) from the prose after it, so the prose
 * after a path is masked with it until one of those ends: `in /a/b imported from /c/d` reads
 * `in <path> <path>`. A Workspace root standing alone, as a path ends, is kept as `<workspace>`
 * and the words after it stay. Masking too much is harmless; naming a host path is not.
 *
 * Every pattern runs in linear time: a check that looks across a run of whitespace or punctuation
 * is made only at the run's first character.
 */

/** A marker standing for the `index`-th Workspace root, written where the root occurs. */
const ROOT_MARK = '\u0001'
/** A marker standing for the `index`-th masked span, so a mask is never read again as a path. */
const SPAN_MARK = '\u0002'
const ROOT = String.raw`\u0001\d+\u0001`
const SPAN = String.raw`\u0002\d+\u0002`
/** A path starts after anything but a word character, `.`, `~` or a separator (so `kit/a.js` and `./a.js` stay). */
const LEAD = String.raw`(?<![A-Za-z0-9_.~\/\\\u0001])`
/** The start of an absolute path: `/` (not a lone one before whitespace), a drive (`C:\`) or a UNC prefix (`\\`). */
const START = String.raw`(?:\/(?!\s)|[A-Za-z]:\\|\\\\)`
/**
 * Where a path may end: the end, a line end, a quote, or a run of spaces and tabs (taken whole)
 * whose next word holds no path separator.
 */
const PATH_ENDS = String.raw`(?:$|[\r\n'"\x60]|[^\S\r\n]+(?![^\S\r\n])(?![^\s'"\x60]*[\/\\]))`
const PUNCTUATION = String.raw`[.,;:!?)\]}>|]`
/** Punctuation that ends a path where a path may end, checked from the first of a run. */
const CLOSE = String.raw`(?<!${PUNCTUATION})${PUNCTUATION}+(?=${PATH_ENDS})`
/** A quote ends a path, except an apostrophe a letter or digit follows (`o'brien`). */
const QUOTE_END = String.raw`["\x60]|'(?![\p{L}\p{N}_])`
/** A file URL: no whitespace, ending like a path. */
const FILE_URL = new RegExp(String.raw`file:(?:(?!${CLOSE}|${QUOTE_END})[^\s<>])*`, 'gu')
/** A path in quotes: everything up to the matching quote on the line, spaces included. */
const QUOTED = String.raw`(['"\x60])((?:${ROOT}|${START})[^\r\n]*?)(?=\1(?![\p{L}\p{N}_]))`
/**
 * A path outside quotes. A Workspace root starts one wherever it occurs, and is one by itself where
 * a path may end; another absolute path starts one after a non-path character. It ends at a line
 * end, a quote, path-terminating punctuation, or where another path starts after optional
 * whitespace (that one is masked on its own; the check is made from the first whitespace of a run).
 */
const NEXT_PATH = String.raw`(?<!\s)\s*(?:${LEAD}(?:${START}|${ROOT})|${SPAN})`
const BARE = String.raw`${ROOT}(?=${PUNCTUATION}*${PATH_ENDS})|(?:${ROOT}|${LEAD}${START})(?:(?!${CLOSE}|${QUOTE_END}|${NEXT_PATH})[^\r\n])*`
const PATHS = new RegExp(String.raw`${QUOTED}|${BARE}`, 'gu')
const ROOT_MARKS = new RegExp(ROOT, 'gu')
const SPAN_MARKS = new RegExp(SPAN, 'gu')

/**
 * `message` without host paths: a path inside a Workspace root becomes `<workspace>` and its path
 * below the root, and any other absolute path or file URL, including one that leaves a root
 * through `..` or only shares a root's name as a prefix (`<root>-other`), becomes `<path>`, so a
 * Resource or a diagnostic never names a host path outside the Workspace.
 */
export function maskHostPaths(message: string, roots: readonly string[]): string {
	const ordered = [...new Set(roots)].filter(root => root !== '').sort((a, b) => b.length - a.length)
	const spans: string[] = []
	const unmarkRoots = (text: string): string => text.replace(ROOT_MARKS, mark => ordered[Number(mark.slice(1, -1))]!)
	const unmarkSpans = (text: string): string => text.replace(SPAN_MARKS, mark => spans[Number(mark.slice(1, -1))]!)
	const span = (masked: string): string => {
		spans.push(unmarkSpans(masked))
		return `${SPAN_MARK}${spans.length - 1}${SPAN_MARK}`
	}
	const describe = (path: string): string => {
		const marked = new RegExp(String.raw`^${ROOT}`, 'u').exec(path)
		const candidates = marked
			? [[ordered[Number(marked[0].slice(1, -1))]!, unmarkRoots(path.slice(marked[0].length))] as const]
			: ordered.flatMap((root) => {
					const whole = unmarkRoots(path)
					return whole === root || whole.startsWith(`${root}/`) || whole.startsWith(`${root}\\`) ? [[root, whole.slice(root.length)] as const] : []
				})
		for (const [root, rest] of candidates) {
			const inside = relative(root, `${root}${rest}`)
			if (inside === '') return '<workspace>'
			if (!escapesBase(inside)) return `<workspace>/${inside.split(sep).join('/')}`
		}
		return '<path>'
	}

	let result = message.replaceAll(ROOT_MARK, '').replaceAll(SPAN_MARK, '').replace(FILE_URL, (url) => {
		try {
			return span(describe(fileURLToPath(url)))
		}
		catch {
			return span('<path>')
		}
	})
	// Only the trailing side of a root is checked: `<root>-other` is not the root, but the root
	// counts wherever it starts, whatever precedes it.
	ordered.forEach((root, index) => {
		const escaped = root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
		result = result.replace(new RegExp(String.raw`${escaped}(?=$|[\/\\\s'"\x60<>()\],.;:!?])`, 'gu'), `${ROOT_MARK}${index}${ROOT_MARK}`)
	})
	result = result.replace(PATHS, (match, quote: string | undefined, quoted: string | undefined) => {
		if (quote !== undefined && quoted !== undefined) return `${quote}${span(describe(quoted))}`
		const path = match.trimEnd()
		return `${span(describe(path))}${match.slice(path.length)}`
	})
	return unmarkSpans(result)
}

/** True when a `relative()` result leaves its base: `..` itself, a `../` prefix, or an absolute path (another drive). */
function escapesBase(rel: string): boolean {
	return rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel)
}
