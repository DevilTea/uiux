import js from '@eslint/js'
import vueI18n from '@intlify/eslint-plugin-vue-i18n'
import vue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { RAW_TEXT_IGNORE_PATTERN } from './tests/support/i18n-allowlist.mjs'

export default tseslint.config(
	{
		ignores: ['.claude/**', '.impeccable/**', '.nuxt/**', '.output/**', 'coverage/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'],
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
