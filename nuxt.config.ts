import { defineNuxtConfig } from 'nuxt/config'

const publicationMode = process.env.UIUX_PUBLICATION_MODE === '1'
const publicationBase = process.env.UIUX_APP_BASE_URL || '/'
const publicationOutput = process.env.UIUX_NITRO_OUTPUT_DIR

export default defineNuxtConfig({
	ssr: false,
	app: {
		baseURL: publicationBase,
		head: {
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
		: {},
	css: ['~/assets/css/main.css'],
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
