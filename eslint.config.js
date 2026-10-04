import js from '@eslint/js'
import vue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
	{
		ignores: ['.nuxt/**', '.output/**', 'coverage/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'],
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
)
