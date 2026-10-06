import { fileURLToPath } from 'node:url'
import { defineNuxtConfig } from 'nuxt/config'

const publicationMode = process.env.UIUX_PUBLICATION_MODE === '1'
const publicationBase = process.env.UIUX_APP_BASE_URL || '/'
const publicationOutput = process.env.UIUX_NITRO_OUTPUT_DIR

export default defineNuxtConfig({
	ssr: false,
	app: {
		baseURL: publicationBase,
		head: {
			// Edge-to-edge on notched phones (safe areas are padded by the shell), and the layout
			// viewport shrinks above the virtual keyboard so sheets and composers stay visible.
			viewport: 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content',
			link: [{
				rel: 'icon',
				type: 'image/svg+xml',
				href: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%227%22 fill=%22%23171717%22/%3E%3Cpath d=%22M8 10h16v4H8zm0 8h10v4H8z%22 fill=%22%23a78bfa%22/%3E%3C/svg%3E',
			}],
		},
	},
	runtimeConfig: {
		public: {
			uiuxMode: publicationMode ? 'publication' : 'live',
		},
	},
	modules: ['@nuxt/ui', '@nuxtjs/i18n'],
	ui: {
		theme: {
			// `annotation` is a first-class Nuxt UI color (Marker magenta, human comments only).
			colors: ['primary', 'secondary', 'annotation', 'success', 'info', 'warning', 'error'],
		},
		// Inter and JetBrains Mono ship as npm packages bundled by Vite (see `css` below), so
		// builds, including `uiux publish` on a user's machine, never fetch fonts from a network
		// provider and a missing package fails the build instead of silently falling back.
		fonts: false,
	},
	i18n: {
		// Workbench chrome catalogs only. Workspace locales live in the selected Workspace's i18n/*.json.
		restructureDir: 'app/i18n',
		langDir: 'locales',
		strategy: 'no_prefix',
		defaultLocale: 'en-US',
		detectBrowserLanguage: false,
		locales: [
			{ code: 'en-US', language: 'en-US', name: 'English', file: 'en-US.json' },
			{ code: 'zh-TW', language: 'zh-TW', name: '繁體中文', file: 'zh-TW.json' },
		],
	},
	icon: publicationMode
		? {
				provider: 'none',
				clientBundle: {
					scan: true,
					icons: ['lucide:loader-circle'],
				},
			}
		: {
				// Icons the server-unreachable state needs while the icon API is down with the server.
				clientBundle: { icons: ['lucide:unplug', 'lucide:refresh-cw', 'lucide:loader-circle', 'lucide:circle-alert'] },
			},
	css: [
		'@fontsource-variable/inter/wght.css',
		'@fontsource/jetbrains-mono/latin-400.css',
		'@fontsource/jetbrains-mono/latin-500.css',
		'@fontsource/jetbrains-mono/latin-ext-400.css',
		'@fontsource/jetbrains-mono/latin-ext-500.css',
		'~/assets/css/main.css',
	],
	hooks: {
		// `server/error.ts` answers `persistence.busy` as a retryable 503 and otherwise falls through
		// to Nuxt's own error handler, so it must run first in Nitro's error handler chain.
		'nitro:config'(config) {
			const existing = config.errorHandler ? [config.errorHandler].flat() : []
			config.errorHandler = [fileURLToPath(new URL('./server/error.ts', import.meta.url)), ...existing]
		},
	},
	nitro: {
		preset: publicationMode ? 'static' : 'node-server',
		...(publicationOutput ? { output: { dir: publicationOutput } } : {}),
		prerender: {
			routes: publicationMode ? ['/', '/preview'] : [],
		},
		externals: {
			external: [
				'@deviltea/widget-core',
				'@deviltea/widget-core/inspection',
				'@deviltea/widget-core/integration',
				'@deviltea/widget-vue',
			],
		},
	},
})
