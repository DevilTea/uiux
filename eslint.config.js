import js from '@eslint/js'
import vueI18n from '@intlify/eslint-plugin-vue-i18n'
import vue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { RAW_TEXT_IGNORE_PATTERN } from './tests/support/i18n-allowlist.mjs'

const GLOBAL_OBJECT = '/^(globalThis|global)$/'
const STDIO = '/^(stdout|stderr)$/'
const CONSOLE_MODULE = '/^(node:)?console$/'
const PROCESS_MODULE = '/^(node:)?process$/'
const stdioMessage = 'Raw stdio writes are restricted to the sanctioned writer modules (src/server/access/redaction.ts).'
const globalMessage = 'Raw console and process access through globalThis is restricted to the sanctioned writer modules.'
const consoleModuleMessage = 'The node:console module bypasses the redacted logger; write diagnostics through src/logging/diagnostics.ts.'

// Known gap (issue #290): a lint rule cannot follow arbitrary aliases (`const c = globalThis` is
// flagged, but `const c = (0, eval)('this')` or a value returned from a function is not).
const restrictedRawOutput = [
	{ selector: 'Identifier[name=\'console\']', message: 'Write diagnostics through src/logging/diagnostics.ts (redacted) or the CLI writers in src/cli/output.ts.' },
	{ selector: `MemberExpression[property.name='console'][object.name=${GLOBAL_OBJECT}]`, message: 'Raw console access is restricted to the sanctioned writer modules.' },
	{ selector: `MemberExpression[object.name='process'][property.name=${STDIO}]`, message: stdioMessage },
	{ selector: `MemberExpression[object.name='process'][computed=true][property.value=${STDIO}]`, message: stdioMessage },
	{ selector: `MemberExpression[object.name=${GLOBAL_OBJECT}][property.name='process']`, message: 'Raw stdio access through globalThis.process is restricted to the sanctioned writer modules.' },
	// Computed and aliased access to the global object.
	{ selector: `MemberExpression[object.name=${GLOBAL_OBJECT}][computed=true][property.value=/^(console|process)$/]`, message: globalMessage },
	{ selector: `VariableDeclarator[init.name=${GLOBAL_OBJECT}]`, message: globalMessage },
	{ selector: `AssignmentExpression[right.name=${GLOBAL_OBJECT}]`, message: globalMessage },
	// The node:console module, by import, dynamic import or require.
	{ selector: `ImportDeclaration[source.value=${CONSOLE_MODULE}]`, message: consoleModuleMessage },
	{ selector: `ImportExpression[source.value=${CONSOLE_MODULE}]`, message: consoleModuleMessage },
	{ selector: `CallExpression[callee.name='require'][arguments.0.value=${CONSOLE_MODULE}]`, message: consoleModuleMessage },
	// node:process: an alias or a named stdout/stderr import hides the `process.stdout` access.
	{ selector: `ImportDeclaration[source.value=${PROCESS_MODULE}] > ImportSpecifier[imported.name=${STDIO}]`, message: stdioMessage },
	{ selector: `ImportDeclaration[source.value=${PROCESS_MODULE}] > :matches(ImportDefaultSpecifier, ImportNamespaceSpecifier)[local.name!='process']`, message: 'Import node:process as `process` so raw stdio access stays visible to lint.' },
	{ selector: `CallExpression[callee.name='require'][arguments.0.value=${PROCESS_MODULE}]`, message: 'Use the global or an imported `process`; require(\'node:process\') hides stdio access.' },
	// Direct file-descriptor and device writes.
	{ selector: 'CallExpression[callee.property.name=\'writeSync\']:matches([arguments.0.value=1], [arguments.0.value=2])', message: 'Writing to file descriptor 1 or 2 bypasses redaction.' },
	{ selector: 'CallExpression[callee.name=\'writeSync\']:matches([arguments.0.value=1], [arguments.0.value=2])', message: 'Writing to file descriptor 1 or 2 bypasses redaction.' },
	{ selector: 'Literal[value=/^\\/dev\\/(stdout|stderr|fd\\/[12])$/]', message: 'Writing to a stdio device bypasses redaction.' },
	// A child process that inherits stdio writes its output unredacted.
	{ selector: 'Property[key.name=\'stdio\'] Literal[value=\'inherit\']', message: 'A child process with inherited stdio bypasses redaction; pipe and forward through the redacted logger.' },
]

export default tseslint.config(
	{
		ignores: ['.claude/**', '.impeccable/**', '.uiux/kit/dist/**', '.uiux-server-smoke-*/**', '.nuxt/**', '.output/**', 'coverage/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	...vue.configs['flat/recommended'],
	{
		files: ['**/*.{js,mjs,ts}'],
		languageOptions: {
			globals: globals.node,
		},
		rules: {
			'vue/one-component-per-file': 'off',
		},
	},
	{
		files: ['**/*.vue'],
		languageOptions: {
			parserOptions: { parser: tseslint.parser },
			globals: { ...globals.browser, $fetch: 'readonly' },
		},
		rules: {
			'vue/multi-word-component-names': 'off',
		},
	},
	{
		// Secrets never appear in logs (Rule 01a11485-ed17-791a-a30e-1b63fa6f16ce, issue #169): server
		// and library code writes diagnostics only through `src/logging/diagnostics.ts`, which the
		// server's console redaction (`installLogRedaction`) covers. Raw console and stdio access is
		// restricted to the sanctioned writer modules below. Tests and scripts are outside this scope.
		files: ['bin/**/*.{js,mjs}', 'server/**/*.{ts,js,vue}', 'src/**/*.{ts,js,mjs}'],
		rules: {
			'no-console': 'error',
			'no-restricted-syntax': ['error', ...restrictedRawOutput],
		},
	},
	{
		// Sanctioned writers: the redacting logger, the log-redaction installer and unredacted
		// bootstrap banner, the CLI output helpers (a command's own requested output) and the CLI entrypoint.
		files: ['src/logging/diagnostics.ts', 'src/server/access/redaction.ts', 'src/cli/output.ts', 'bin/uiux.mjs'],
		rules: {
			'no-console': 'off',
			'no-restricted-syntax': 'off',
		},
	},
	{
		// Workbench chrome copy comes from the catalogs (app/i18n/locales); a literal English string
		// in a template is a missing translation. What may stay literal is listed, with reasons, in
		// tests/support/i18n-allowlist.mjs. Bound props (`:label="'…'"`) and script strings are outside
		// this rule's reach; tests/workbench-i18n-guard.test.ts covers them.
		files: ['app/**/*.vue'],
		plugins: { '@intlify/vue-i18n': vueI18n },
		rules: {
			'@intlify/vue-i18n/no-raw-text': ['error', {
				attributes: {
					'/.+/': ['label', 'placeholder', 'title', 'aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'alt', 'description', 'empty', 'text', 'help', 'hint', 'legend'],
				},
				// Code, keyboard keys and preformatted samples are literal by definition (names are lowercased).
				ignoreNodes: ['code', 'kbd', 'pre', 'samp', 'ukbd'],
				ignorePattern: RAW_TEXT_IGNORE_PATTERN,
			}],
		},
	},
)
