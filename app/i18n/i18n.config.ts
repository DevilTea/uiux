import { defineI18nConfig } from '#imports'

// Vue I18n options for the Workbench chrome catalogs (app/i18n/locales/*.json).
export default defineI18nConfig(() => ({
	legacy: false,
	fallbackLocale: 'en-US',
}))
