<script setup lang="ts">
import { computed } from 'vue'
import { useHead, useI18n } from '#imports'
import { en, zh_tw } from '@nuxt/ui/locale'

const { locale, t } = useI18n()

// Nuxt UI component strings (close buttons, empty lists, color mode labels) follow the Workbench locale.
const uiLocale = computed(() => locale.value === 'zh-TW' ? zh_tw : en)

useHead({
	htmlAttrs: { lang: locale },
	title: () => t('app.title'),
})
</script>

<template>
  <UApp
    :locale="uiLocale"
    :tooltip="{ delayDuration: 300 }"
  >
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
