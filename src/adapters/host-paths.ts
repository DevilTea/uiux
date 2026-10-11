import { isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Masking of host paths in messages a Resource or a diagnostic repeats (an error's message, say).
 *
 * The rule is deliberately conservative: once an absolute path starts, it runs to the end of the
 * line, a quote, the start of another path, or path-terminating punctuation (`.,;:!?)]}>|` followed
 * by whitespace, a quote or the end). A path may hold spaces, tabs and apostrophes (`o'brien`), and
 * the next word cannot tell a path with spaces (`/Users/John Smith`) from the prose after it, so the
 * prose after a path is masked with it until one of those ends: `in /a/b imported from /c/d` reads
 * `in <path> <path>`. Masking too much is harmless; naming a host path is not.
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
/** Punctuation that ends a path when whitespace, a quote or the end follows it. */
const CLOSE = String.raw`[.,;:!?)\]}>|]+(?=$|[\s'"\x60])`
/** A quote ends a path, except an apostrophe a letter or digit follows (`o'brien`). */
const QUOTE_END = String.raw`["\x60]|'(?![\p{L}\p{N}_])`
/** A file URL: no whitespace, ending like a path. */
const FILE_URL = new RegExp(String.raw`file:(?:(?!${CLOSE}|${QUOTE_END})[^\s<>])*`, 'gu')
/** A path in quotes: everything up to the matching quote on the line, spaces included. */
const QUOTED = String.raw`(['"\x60])((?:${ROOT}|${START})[^\r\n]*?)(?=\1(?![\p{L}\p{N}_]))`
/**
 * A path outside quotes. A Workspace root starts one wherever it occurs; another absolute path
 * starts one after a non-path character. It ends at a line end, a quote, path-terminating
 * punctuation, or where another path starts (that one is masked on its own).
 */
const BARE = String.raw`(?:${ROOT}|${LEAD}${START})(?:(?!${CLOSE}|${QUOTE_END}|\s*(?:${LEAD}(?:${START}|${ROOT})|${SPAN}))[^\r\n])*`
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
		const [, path = match, trailing = ''] = /^(.*?)(\s*)$/su.exec(match) ?? []
		return `${span(describe(path))}${trailing}`
	})
	return unmarkSpans(result)
}

/** True when a `relative()` result leaves its base: `..` itself, a `../` prefix, or an absolute path (another drive). */
function escapesBase(rel: string): boolean {
	return rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel)
}
