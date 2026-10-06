<script setup lang="ts">
import { computed } from 'vue'
import { clearError, useHead, useI18n } from '#imports'
import type { NuxtError } from '#app'
import { en, zh_tw } from '@nuxt/ui/locale'
import { useToastRegionName } from './composables/useToastRegionName'

/**
 * The Workbench's own error page (an unknown route, or a fatal client error), in the Workbench
 * language. It replaces Nuxt's built-in English page. The requested path and the status code stay
 * literal; the error's own message is not shown because it is framework English.
 */
const props = defineProps<{ error: NuxtError }>()

const { locale, t } = useI18n()
const uiLocale = computed(() => locale.value === 'zh-TW' ? zh_tw : en)
useToastRegionName()
const notFound = computed(() => props.error.statusCode === 404)
const title = computed(() => notFound.value ? t('errorPage.notFoundTitle') : t('errorPage.title'))
const path = computed(() => {
	try { return window.location.pathname }
	catch { return '' }
})

useHead({
	htmlAttrs: { lang: locale },
	title: () => `${title.value} · ${t('app.title')}`,
})

function goHome(): void {
	void clearError({ redirect: '/' })
}
</script>

<template>
  <UApp
    :locale="uiLocale"
    :toaster="{ label: t('a11y.notification') }"
  >
    <main
      class="grid min-h-dvh place-items-center bg-default p-6"
      data-error-page
    >
      <UEmpty
        :icon="notFound ? 'i-lucide-map-pin-off' : 'i-lucide-circle-alert'"
        :title="title"
        :actions="[{ label: t('errorPage.home'), icon: 'i-lucide-house', color: 'neutral', variant: 'outline', onClick: goHome }]"
      >
        <template #description>
          <span v-if="notFound">
            {{ t('errorPage.notFoundDescription') }}
            <code
              v-if="path"
              class="font-mono text-toned"
              translate="no"
            >{{ path }}</code>
          </span>
          <span v-else>{{ t('errorPage.description') }}</span>
          <span
            v-if="error.statusCode"
            class="mt-1 block font-mono text-xs text-dimmed"
            translate="no"
          >HTTP {{ error.statusCode }}</span>
        </template>
      </UEmpty>
    </main>
  </UApp>
</template>
