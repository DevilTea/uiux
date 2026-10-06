import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { parse as parseSfc } from 'vue/compiler-sfc'
import { describe, expect, it } from 'vitest'
import { diagnosticMessageKey, diagnosticNamespaceKey } from '../app/utils/diagnostic-copy'
import { untranslatedWords } from './support/i18n-allowlist.mjs'

/**
 * Static guard for Workbench i18n completeness. `@intlify/vue-i18n/no-raw-text` (eslint.config.js)
 * covers raw template text and static attributes; this covers what it cannot see:
 *
 * - string literals in bound user-visible props and interpolations (`:label="'Retry'"`,
 *   `:actions="[{ label: 'Retry' }]"`, `{{ ok ? 'Done' : '' }}`);
 * - string literals a script sends to the screen (toast titles, menu and tab items, announcements);
 * - English left in the zh-TW catalog outside the shared allowlist (tests/support/i18n-allowlist.mjs);
 * - templates that render a server diagnostic's English `message` instead of `diagnosticText()`;
 * - a diagnostic code the server or domain can send without Workbench copy for it.
 */

const ROOT = join(import.meta.dirname, '..')
const APP = join(ROOT, 'app')

type Catalog = { [key: string]: string | Catalog }

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry)
		return statSync(path).isDirectory() ? walk(path) : [path]
	})
}

function flatten(catalog: Catalog, prefix = ''): Map<string, string> {
	const out = new Map<string, string>()
	for (const [key, value] of Object.entries(catalog)) {
		const path = prefix ? `${prefix}.${key}` : key
		if (typeof value === 'string') out.set(path, value)
		else for (const [k, v] of flatten(value, path)) out.set(k, v)
	}
	return out
}

const en = flatten(JSON.parse(readFileSync(join(APP, 'i18n', 'locales', 'en-US.json'), 'utf8')) as Catalog)
const zh = flatten(JSON.parse(readFileSync(join(APP, 'i18n', 'locales', 'zh-TW.json'), 'utf8')) as Catalog)

/** Props and attributes whose value a person reads or hears. */
const VISIBLE_ATTRS = new Set(['label', 'placeholder', 'title', 'aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'alt', 'description', 'empty', 'text', 'help', 'hint', 'legend', 'header', 'error'])
/** Object keys whose value a person reads (Nuxt UI items, actions, columns, toasts). */
const VISIBLE_KEYS = new Set(['label', 'title', 'description', 'placeholder', 'header', 'text', 'ariaLabel', 'aria-label', 'empty', 'help', 'hint', 'suffix', 'prefix'])
/** Calls whose string arguments reach the screen or a live region. */
const VISIBLE_CALLS = /(?:^|\.)(?:success|announce|setAttribute)$/

type Finding = Readonly<{ file: string; line: number; text: string }>

/** The slice of the Vue template AST (`@vue/compiler-core`) this guard reads. */
type TemplateNode = Readonly<{
	type: number
	loc: Readonly<{ start: Readonly<{ line: number }> }>
	props?: readonly TemplateProp[]
	content?: Readonly<{ type: number; content: string }>
	children?: readonly TemplateNode[]
	branches?: readonly TemplateNode[]
}>
type TemplateProp = Readonly<{
	type: number
	name: string
	value?: Readonly<{ content: string }>
	arg?: Readonly<{ type: number; content: string }>
	exp?: Readonly<{ type: number; content: string }>
	loc: Readonly<{ start: Readonly<{ line: number }> }>
}>
/** `NodeTypes` values from @vue/compiler-core. */
const ELEMENT = 1
const SIMPLE_EXPRESSION = 4
const INTERPOLATION = 5
const ATTRIBUTE = 6
const DIRECTIVE = 7

/** String literals in "output" position of an expression: the value itself, ternary branches, `||`/`??` operands. */
function outputLiterals(node: ts.Node, out: ts.Node[] = []): ts.Node[] {
	if (ts.isParenthesizedExpression(node)) return outputLiterals(node.expression, out)
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) out.push(node)
	else if (ts.isConditionalExpression(node)) { outputLiterals(node.whenTrue, out); outputLiterals(node.whenFalse, out) }
	else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.PlusToken].includes(node.operatorToken.kind)) {
		outputLiterals(node.left, out)
		outputLiterals(node.right, out)
	}
	return out
}

function literalText(node: ts.Node): string {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
	// A substitution reads as `0`, so an id built from parts (`settings-${kind}-title`) stays an identifier.
	if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join('0')
	return ''
}

function propertyName(name: ts.PropertyName): string | undefined {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
	return undefined
}

/** Visible literals anywhere inside an expression or script: object keys, calls and (optionally) the root. */
function visibleLiterals(source: ts.SourceFile, root: ts.Node, rootIsVisible: boolean): ts.Node[] {
	const found: ts.Node[] = rootIsVisible ? outputLiterals(root) : []
	const visit = (node: ts.Node) => {
		if (ts.isPropertyAssignment(node)) {
			const name = propertyName(node.name)
			if (name && VISIBLE_KEYS.has(name)) found.push(...outputLiterals(node.initializer))
		}
		else if (ts.isCallExpression(node) && VISIBLE_CALLS.test(node.expression.getText(source))) {
			const args = node.expression.getText(source).endsWith('setAttribute') ? node.arguments.slice(1) : node.arguments
			for (const argument of args) found.push(...outputLiterals(argument))
		}
		else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText(source) === 'document.title') {
			found.push(...outputLiterals(node.right))
		}
		ts.forEachChild(node, visit)
	}
	visit(root)
	return found
}

function scanExpression(code: string, rootIsVisible: boolean): string[] {
	const source = ts.createSourceFile('expr.ts', `(${code})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
	return visibleLiterals(source, source, false).concat(rootIsVisible ? outputLiterals((source.statements[0] as ts.ExpressionStatement).expression) : []).map(literalText)
}

function templateFindings(file: string, ast: TemplateNode): Finding[] {
	const findings: Finding[] = []
	const report = (line: number, texts: string[]) => {
		for (const text of texts) if (untranslatedWords(text).length) findings.push({ file, line, text })
	}
	const visit = (node: TemplateNode) => {
		if (node.type === ELEMENT) {
			const props = node.props ?? []
			// `translate="no"` marks literal content (ids, codes, the server's own words).
			if (props.some(prop => prop.type === ATTRIBUTE && prop.name === 'translate' && prop.value?.content === 'no')) return
			for (const prop of props) {
				if (prop.type !== DIRECTIVE || prop.name !== 'bind' || prop.exp?.type !== SIMPLE_EXPRESSION) continue
				const arg = prop.arg?.type === SIMPLE_EXPRESSION ? prop.arg.content : ''
				// Class names: Nuxt UI `ui` slots share keys with visible props (`{ label: 'truncate' }`).
				if (arg === 'ui' || arg === 'class' || arg === 'style') continue
				report(prop.loc.start.line, scanExpression(prop.exp.content, VISIBLE_ATTRS.has(arg)))
			}
		}
		if (node.type === INTERPOLATION && node.content?.type === SIMPLE_EXPRESSION) report(node.loc.start.line, scanExpression(node.content.content, true))
		for (const child of node.children ?? []) visit(child)
		for (const branch of node.branches ?? []) visit(branch)
	}
	visit(ast)
	return findings
}

function scriptFindings(file: string, code: string, lineOffset: number): Finding[] {
	const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
	return visibleLiterals(source, source, false)
		.map(node => ({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 + lineOffset, text: literalText(node) }))
		.filter(finding => untranslatedWords(finding.text).length > 0)
}

const appFiles = walk(APP).filter(path => /\.(vue|ts)$/.test(path) && !path.includes(`${join('app', 'i18n')}`))

describe('Workbench i18n guard', () => {
	it('sends no literal English to the screen from bound props, interpolations or scripts', () => {
		const findings: Finding[] = []
		for (const path of appFiles) {
			const file = relative(ROOT, path)
			const source = readFileSync(path, 'utf8')
			if (path.endsWith('.ts')) { findings.push(...scriptFindings(file, source, 0)); continue }
			const { descriptor } = parseSfc(source, { filename: path })
			if (descriptor.template?.ast) findings.push(...templateFindings(file, descriptor.template.ast as unknown as TemplateNode))
			for (const block of [descriptor.script, descriptor.scriptSetup]) {
				if (block) findings.push(...scriptFindings(file, block.content, block.loc.start.line - 1))
			}
		}
		expect(findings.map(item => `${item.file}:${item.line} "${item.text}"`)).toEqual([])
	})

	it('leaves no untranslated English in the zh-TW catalog outside the allowlist', () => {
		const offenders = [...zh].flatMap(([key, value]) => {
			const words = untranslatedWords(value)
			return words.length ? [`${key}: "${value}" (${words.join(', ')})`] : []
		})
		expect(offenders).toEqual([])
	})

	it('renders server diagnostics through diagnosticText(), never their English message', () => {
		// WbErrorDetails is the Details disclosure: the one place the server's own words belong.
		const raw = /(?:\{\{\s*|:(?:title|description|label)="\s*)(?:diagnostic|diag|finding|fault|problem|issue|item)\.message\b/
		const offenders: string[] = []
		for (const path of appFiles.filter(file => file.endsWith('.vue') && !file.endsWith('WbErrorDetails.vue'))) {
			readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
				if (raw.test(line)) offenders.push(`${relative(ROOT, path)}:${index + 1}`)
			})
		}
		expect(offenders).toEqual([])
	})
})

/** Diagnostic codes the server and domain emit: `code: '<ns>.<name>'` and `fn('<ns>.<name>', …)`. */
function emittedCodes(): Map<string, string> {
	const codes = new Map<string, string>()
	const patterns = [/code:\s*'([a-z_]+\.[a-z0-9_.]+)'/g, /\(\s*'([a-z_]+\.[a-z0-9_]+)'\s*,\s*[`'"a-zA-Z$]/g]
	for (const path of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'server'))].filter(file => file.endsWith('.ts'))) {
		const source = readFileSync(path, 'utf8')
		for (const pattern of patterns) for (const match of source.matchAll(pattern)) if (!codes.has(match[1]!)) codes.set(match[1]!, relative(ROOT, path))
	}
	return codes
}

/**
 * Codes the Workbench never shows, so they need only their namespace sentence: the preview wire
 * protocol (browser-to-browser validation), MCP-only discovery and lease requests, the
 * CLI-only access store, and internal sentinels.
 */
const NAMESPACE_ONLY = /^(?:protocol|discovery|lease|time|revision)\.|^access\.(?:home_inside_workspace|roster_exists|store_root_mismatch|store_unsafe|workspace_invalid)$/

describe('Workbench copy for server diagnostics', () => {
	const codes = emittedCodes()

	it('finds the codes it guards', () => {
		expect(codes.size).toBeGreaterThan(200)
		expect(codes.has('review.message_body_empty')).toBe(true)
	})

	it('has a namespace sentence in both catalogs for every code the server can send', () => {
		const missing = [...codes].filter(([code]) => !en.has(diagnosticNamespaceKey(code)) || !zh.has(diagnosticNamespaceKey(code))).map(([code, file]) => `${code} (${file})`)
		expect(missing).toEqual([])
	})

	it('has its own sentence for every code a Workbench surface can show', () => {
		const missing = [...codes]
			.filter(([code]) => !NAMESPACE_ONLY.test(code) && !en.has(diagnosticMessageKey(code)))
			.map(([code, file]) => `${code} (${file})`)
		expect(missing).toEqual([])
	})
})
