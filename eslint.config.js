import js from '@eslint/js'
import vueI18n from '@intlify/eslint-plugin-vue-i18n'
import vue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { RAW_TEXT_IGNORE_PATTERN } from './tests/support/i18n-allowlist.mjs'

export default tseslint.config(
	{
		ignores: ['.claude/**', '.impeccable/**', '.uiux-server-smoke-*/**', '.nuxt/**', '.output/**', 'coverage/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'],
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
		files: ['bin/**/*.{js,mjs}', 'server/**/*.ts', 'src/**/*.ts'],
		rules: {
			'no-console': 'error',
			'no-restricted-syntax': ['error',
				{ selector: 'Identifier[name=\'console\']', message: 'Write diagnostics through src/logging/diagnostics.ts (redacted) or the CLI writers in src/cli/output.ts.' },
				{ selector: 'MemberExpression[property.name=\'console\'][object.name=/^(globalThis|global)$/]', message: 'Raw console access is restricted to the sanctioned writer modules.' },
				{ selector: 'MemberExpression[object.name=\'process\'][property.name=/^(stdout|stderr)$/]', message: 'Raw stdio writes are restricted to the sanctioned writer modules (src/server/access/redaction.ts).' },
				{ selector: 'MemberExpression[object.name=/^(globalThis|global)$/][property.name=\'process\']', message: 'Raw stdio access through globalThis.process is restricted to the sanctioned writer modules.' },
			],
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
