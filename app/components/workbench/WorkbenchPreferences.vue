<script setup lang="ts">
import { computed } from 'vue'
import { useColorMode, useI18n } from '#imports'
import type { DropdownMenuItem } from '@nuxt/ui'
import { useWorkbenchShell } from '../../composables/useWorkbenchShell'
import {
	clearSavedWorkbenchLocale,
	isWorkbenchLocale,
	readSavedWorkbenchLocale,
	resolveInitialWorkbenchLocale,
	saveWorkbenchLocale,
	type WorkbenchLocale,
} from '../../utils/workbench-locale'

/**
 * Workbench chrome preferences: theme and language. Both change the Workbench only; the
 * previewed View keeps its own render context (Locale and theme in the canvas bar).
 */
const { t, locale, setLocale } = useI18n()
const colorMode = useColorMode()
const shell = useWorkbenchShell()

const savedLocale = computed(() => {
	// Re-evaluated whenever the active locale changes.
	void locale.value
	return readSavedWorkbenchLocale()
})

function browserLanguages(): readonly string[] {
	return navigator.languages?.length ? navigator.languages : [navigator.language]
}

function chooseLanguage(value: WorkbenchLocale | 'system'): void {
	if (value === 'system') {
		clearSavedWorkbenchLocale()
		void setLocale(resolveInitialWorkbenchLocale(null, browserLanguages()))
		return
	}
	if (!isWorkbenchLocale(value)) return
	saveWorkbenchLocale(value)
	void setLocale(value)
}

function chooseTheme(value: 'system' | 'light' | 'dark'): void {
	colorMode.preference = value
}

const items = computed<DropdownMenuItem[][]>(() => {
	const theme = colorMode.preference
	const language = isWorkbenchLocale(savedLocale.value) ? savedLocale.value : 'system'
	const option = (label: string, checked: boolean, select: () => void, icon?: string): DropdownMenuItem => ({
		label,
		icon,
		type: 'checkbox',
		checked,
		onUpdateChecked: select,
		onSelect: (event: Event) => event.preventDefault(),
	})
	return [
		[
			{ type: 'label', label: t('prefs.theme'), description: t('prefs.themeHint') },
			option(t('prefs.system'), theme === 'system', () => chooseTheme('system'), 'i-lucide-monitor'),
			option(t('prefs.light'), theme === 'light', () => chooseTheme('light'), 'i-lucide-sun'),
			option(t('prefs.dark'), theme === 'dark', () => chooseTheme('dark'), 'i-lucide-moon'),
		],
		[
			{ type: 'label', label: t('prefs.language'), description: t('prefs.languageHint') },
			option(t('prefs.system'), language === 'system', () => chooseLanguage('system')),
			option(t('prefs.english'), language === 'en-US', () => chooseLanguage('en-US')),
			option(t('prefs.traditionalChinese'), language === 'zh-TW', () => chooseLanguage('zh-TW')),
		],
		[
			{
				label: t('prefs.singleKey'),
				type: 'checkbox',
				checked: shell.singleKeyShortcuts.value,
				onUpdateChecked: (checked: boolean) => shell.setSingleKeyShortcuts(checked),
				onSelect: (event: Event) => event.preventDefault(),
			},
			{
				label: t('prefs.shortcuts'),
				icon: 'i-lucide-keyboard',
				kbds: ['?'],
				onSelect: () => { shell.shortcutsOpen.value = true },
			},
		],
	]
})
</script>

<template>
  <UDropdownMenu
    :items="items"
    :content="{ align: 'end' }"
    :ui="{ content: 'w-72', label: 'flex-col items-start gap-0.5', itemDescription: 'text-xs text-muted whitespace-normal' }"
  >
    <UTooltip :text="t('prefs.title')">
      <UButton
        color="neutral"
        variant="ghost"
        icon="i-lucide-sliders-horizontal"
        :aria-label="t('prefs.title')"
      />
    </UTooltip>
    <template #item-label="{ item }">
      <span class="block">{{ item.label }}</span>
      <span
        v-if="item.type === 'label' && item.description"
        class="block text-xs font-normal text-muted"
      >{{ item.description }}</span>
    </template>
  </UDropdownMenu>
</template>
