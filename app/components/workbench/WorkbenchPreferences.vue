<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { en, zh_tw } from '@nuxt/ui/locale'
import { isWorkbenchLocale, saveWorkbenchLocale } from '../../utils/workbench-locale'

/**
 * Workbench chrome preferences: interface language and appearance (light / dark / system).
 * Appearance only affects the Workbench itself; Workspace themes for the previewed View
 * are chosen separately in the render context controls.
 */
const { t, locale, setLocale } = useI18n()

const locales = [
	{ ...en, code: 'en-US' },
	{ ...zh_tw, code: 'zh-TW' },
]

const localeModel = computed({
	get: () => locale.value,
	set: (value: string) => {
		if (!isWorkbenchLocale(value)) return
		saveWorkbenchLocale(value)
		void setLocale(value)
	},
})
</script>

<template>
  <div class="flex items-center gap-2">
    <UTooltip :text="t('workbench.preferences.languageHint')">
      <ULocaleSelect
        v-model="localeModel"
        :locales="locales"
        size="sm"
        variant="ghost"
        class="w-28"
        :aria-label="t('workbench.preferences.language')"
      />
    </UTooltip>
    <UTooltip :text="t('workbench.preferences.appearanceHint')">
      <UColorModeSelect
        size="sm"
        variant="ghost"
        class="w-28"
        :aria-label="t('workbench.preferences.appearance')"
      />
    </UTooltip>
  </div>
</template>
