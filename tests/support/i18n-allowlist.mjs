/**
 * The one allowlist for Workbench chrome copy (roadmap R2, PRODUCT.md zh-TW terminology policy).
 *
 * Shared by the `@intlify/vue-i18n/no-raw-text` lint rule (eslint.config.js), the static guard
 * (tests/workbench-i18n-guard.test.ts) and the zh-TW browser walk
 * (tests/workbench-i18n-browser.test.ts). Anything English that is not listed here must come from
 * the chrome catalogs in app/i18n/locales, translated. Keep it tight: every entry says why.
 */

/** Domain nouns that stay English inside Chinese UI (PRODUCT.md, plus the role names). */
export const GLOSSARY_NOUNS = [
	'View', 'Variant', 'Widget', 'Review', 'Flow', 'UX', 'Spec', 'Decision', 'Evidence', 'Handoff',
	'Workspace', 'Locale', 'Asset', 'MCP',
	// PRODUCT.md adds these three to the zh-TW policy.
	'RootShell', 'Adapter', 'IR',
	// Role names.
	'Owner', 'Editor', 'Reviewer', 'Viewer',
	// Owner decision, 2026-10-06: these technical nouns also stay English in zh-TW.
	// (Checks → 「檢查」 and Catalog → 「型錄」 are translated, so they are not listed.)
	'Token', 'Agent', 'Slot', 'Runtime', 'Manifest', 'Bundle', 'Schema',
	// Owner decision, 2026-10-09: the version timeline's Checkpoint stays English in zh-TW.
	'Checkpoint',
]

/** Other English words a zh-TW string may carry, each a name or a literal rather than prose. */
export const ALLOWED_WORDS = [
	// The product's own name.
	'UIUX', 'Workbench',
	// Keyboard keys as printed on the keys (shortcut help and announcements).
	'Esc', 'Escape', 'Enter', 'Shift', 'Tab', 'Command', 'Control', 'Ctrl', 'Cmd', 'Alt', 'Option',
	// The language switcher names English in English (an endonym), as every language picker does.
	'English',
	// Proper nouns and standard terms zh-TW software keeps in Latin script.
	'Git', 'Vue', 'Playwright', 'Cookie',
	// The HTTP auth scheme an MCP client must send literally (`Authorization: Bearer <token>`).
	'Bearer',
	// The canonical Handoff readiness claim, a literal value (PRODUCT.md terminology).
	'implementation-ready',
	// Units.
	'px',
]

/**
 * Whole-text patterns that are literal by construction: no letters at all; identifiers, paths, file
 * names and code (create_view, adapter.materialization_unavailable, .uiux/workspace.json,
 * image/svg+xml, @scope/adapter; hyphen-only forms must be lowercase so "Read-only" still fails);
 * BCP 47 tags; acronyms.
 */
export const LITERAL_PATTERNS = [
	String.raw`[^\p{L}]+`,
	String.raw`[\w@+./…:-]*[._/@+:][\w@+./…:-]*`,
	String.raw`[a-z0-9]+(?:-[a-z0-9]+)+`,
	String.raw`[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2})?`,
	String.raw`[A-Z]{2,5}s?`,
]

const NOUNS = String.raw`(?:${GLOSSARY_NOUNS.join('|')}|UX Flow)s?`

/** `no-raw-text` ignorePattern: a whole template text that may stay literal. */
export const RAW_TEXT_IGNORE_PATTERN = `^(?:${[...LITERAL_PATTERNS, NOUNS].join('|')})?$`

const WORD_ALLOWED = new Set([...GLOSSARY_NOUNS, ...GLOSSARY_NOUNS.map(noun => `${noun}s`), ...ALLOWED_WORDS])
const LITERAL_TOKEN = new RegExp(`^(?:${LITERAL_PATTERNS.join('|')})$`, 'u')

/**
 * The English words left in a piece of UI text once names, literals and content are set aside.
 * `「…」` quotes a literal value (an example key or event name) and `uiux <command>` is a CLI
 * command; neither is prose. `{param}` placeholders are values supplied at runtime.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function untranslatedWords(text) {
	const rest = text
		.replace(/\{[^}]*\}/g, ' ')
		.replace(/「[^」]*」/g, ' ')
		.replace(/\buiux [a-z][a-z-]*/g, ' ')
		.replace(/Authorization: Bearer/g, ' ')
	const words = []
	for (const raw of rest.split(/[\s，。、：；！？（）「」『』・／·•…—–,;!?()[\]"“”]+/u)) {
		const token = raw.replace(/[.:]+$/g, '')
		if (!token || !/\p{L}/u.test(token) || !/[A-Za-z]/.test(token)) continue
		if (LITERAL_TOKEN.test(token) || WORD_ALLOWED.has(token)) continue
		// camelCase or PascalCase compounds are identifiers (TextInput, widgetId).
		if (/^[A-Za-z]+$/.test(token) && /[a-z][A-Z]/.test(token)) continue
		// Single letters are shortcut keys (C, J, K).
		if (/^[A-Za-z]$/.test(token)) continue
		const word = token.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '')
		if (!word || WORD_ALLOWED.has(word)) continue
		// A run of CJK with an embedded Latin word (rare): report only the Latin part.
		for (const latin of word.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []) {
			if (!WORD_ALLOWED.has(latin) && !LITERAL_TOKEN.test(latin) && latin.length > 1) words.push(latin)
		}
	}
	return words
}
