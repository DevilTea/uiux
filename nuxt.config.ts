import { defineNuxtConfig } from 'nuxt/config'

export default defineNuxtConfig({
	ssr: false,
	modules: ['@nuxt/ui'],
	nitro: {
		preset: 'node-server',
	},
})
