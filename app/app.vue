<script setup lang="ts">
import { computed } from 'vue'
import { useHead, useI18n } from '#imports'
import { en, zh_tw } from '@nuxt/ui/locale'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from './composables/useMediaQuery'
import { useToastRegionName } from './composables/useToastRegionName'

const { locale, t } = useI18n()

// Nuxt UI component strings (close buttons, empty lists, color mode labels) follow the Workbench locale.
const uiLocale = computed(() => locale.value === 'zh-TW' ? zh_tw : en)

// Toasts: bottom-right on desktop, top on phones where the bottom bar and sheets live (brief h).
// `label` names each toast for screen readers (reka-ui's default is the English "Notification").
const isPhone = useMediaQuery(WORKBENCH_BREAKPOINTS.phone)
const toaster = computed(() => ({ position: isPhone.value ? 'top-center' as const : 'bottom-right' as const, label: t('a11y.notification') }))
useToastRegionName()

useHead({
	htmlAttrs: { lang: locale },
	title: () => t('app.title'),
})
</script>

<template>
  <UApp
    :locale="uiLocale"
    :tooltip="{ delayDuration: 300 }"
    :toaster="toaster"
  >
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
