import { defineConfig } from '@playwright/test'

export default defineConfig({
	testDir: './tests/browser',
	fullyParallel: true,
	reporter: 'list',
	use: {
		baseURL: 'http://127.0.0.1:4173',
	},
	webServer: {
		command: 'pnpm run preview',
		url: 'http://127.0.0.1:4173',
		reuseExistingServer: !process.env.CI,
		env: {
			HOST: '127.0.0.1',
			PORT: '4173',
			NITRO_HOST: '127.0.0.1',
			NITRO_PORT: '4173',
		},
	},
})
