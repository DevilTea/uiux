import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		globalSetup: ['tests/support/global-setup.ts'],
		setupFiles: ['tests/support/uiux-home-guard.ts'],
	},
})
