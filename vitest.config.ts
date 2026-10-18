import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: {
		alias: {
			// The server supplies the public Adapter authoring entry to Adapter modules through a Node resolve
			// hook (`src/adapters/host-adapter-entry.ts`), but Vitest loads an Adapter module that the source
			// imports through Vite, not Node's loader; this alias stands in for the hook there.
			// tests/adapter-entry.test.ts runs the hook itself under Node's loader.
			'@deviltea/uiux/adapter': fileURLToPath(new URL('./src/adapter-entry/index.js', import.meta.url)),
		},
	},
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		globalSetup: ['tests/support/global-setup.ts'],
		setupFiles: ['tests/support/uiux-home-guard.ts'],
	},
})
