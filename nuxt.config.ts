import { defineNuxtConfig } from 'nuxt/config'

export default defineNuxtConfig({
	ssr: false,
	modules: ['@nuxt/ui'],
	css: ['~/assets/css/main.css'],
	nitro: {
		preset: 'node-server',
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
