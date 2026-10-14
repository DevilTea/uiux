<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { useI18n } from '#imports'
import type { KitBuildState, KitBuildStatus } from '../../../src/application/ports/kit-build'
import { describeFetchError, type FetchErrorDetails } from '../../utils/fetch-error'
import { useWorkbenchFeedback } from '../../composables/useWorkbenchFeedback'
import AuthoringErrorAlert from './AuthoringErrorAlert.vue'

/**
 * The build, in the Overview section of the Product Kit page (Rule 01a11bb1-b918-7cb5-b581-a3fd3f647f09):
 * the kit build state (Clause 01a11bb1-8856-737f-945c-e44c596f7782) with why the last run failed,
 * `restart_kit_build` (Clause 01a11be8-5b64-72b3-ad18-81994368a1ed) for a holder of
 * `product-kit.write`, and the build log (Clause 01a11bb1-891e-7fa5-bf48-4c459fd60d11), which only a
 * holder of `product-kit.source.read` may read. The server enforces both keys; this only reflects them.
 */
const props = defineProps<{
	build: KitBuildStatus
	canRestart: boolean
	canReadLog: boolean
}>()
const emit = defineEmits<{ restarted: [] }>()
const { t } = useI18n()
const feedback = useWorkbenchFeedback()

// Untyped request helper: Nitro's typed-route inference overflows on this many routes.
const api = $fetch as unknown as <T = unknown>(url: string, options?: Readonly<Record<string, unknown>>) => Promise<T>

const STATE: Record<KitBuildState, { color: 'neutral' | 'info' | 'success' | 'error'; icon: string }> = {
	none: { color: 'neutral', icon: 'i-lucide-circle-dashed' },
	building: { color: 'info', icon: 'i-lucide-loader-circle' },
	ready: { color: 'success', icon: 'i-lucide-check' },
	failed: { color: 'error', icon: 'i-lucide-circle-alert' },
}
const state = computed(() => STATE[props.build.state])

const restarting = ref(false)
const restartError = shallowRef<FetchErrorDetails>()
async function restart(): Promise<void> {
	if (!props.canRestart || restarting.value) return
	restarting.value = true
	restartError.value = undefined
	try {
		const result = await api<{ status: 'restarted' | 'no_build' }>('/api/product-kit/build/restart', { method: 'POST' })
		feedback.success(t(result.status === 'no_build' ? 'productKit.build.noBuildDeclared' : 'productKit.build.restarted'))
		emit('restarted')
		if (logOpen.value) void loadLog()
	}
	catch (cause) {
		restartError.value = describeFetchError(cause, t('productKit.build.restartFailed'))
	}
	finally {
		restarting.value = false
	}
}

const logOpen = ref(false)
const log = ref<string>()
const logLoading = ref(false)
const logError = shallowRef<FetchErrorDetails>()
async function loadLog(): Promise<void> {
	if (!props.canReadLog) return
	logLoading.value = true
	try {
		log.value = (await api<{ log: string }>('/api/product-kit/build/log')).log
		logError.value = undefined
	}
	catch (cause) {
		logError.value = describeFetchError(cause, t('productKit.build.logFailed'))
	}
	finally {
		logLoading.value = false
	}
}
function onLogOpen(open: boolean): void {
	logOpen.value = open
	if (open) void loadLog()
}
</script>

<template>
  <section
    id="product-kit-build"
    aria-labelledby="product-kit-build-title"
    class="flex scroll-mt-6 flex-col gap-4"
    data-product-kit-section="build"
  >
    <header class="flex items-start justify-between gap-4">
      <div class="min-w-0 space-y-1">
        <h2
          id="product-kit-build-title"
          tabindex="-1"
          class="text-title font-semibold text-highlighted focus:outline-none"
        >
          {{ t('productKit.build.title') }}
        </h2>
        <p class="text-sm text-muted">
          {{ t('productKit.build.description') }}
        </p>
      </div>
      <UButton
        v-if="canRestart"
        icon="i-lucide-refresh-cw"
        class="shrink-0"
        :loading="restarting"
        data-kit-build-restart
        @click="restart"
      >
        {{ t('productKit.build.restart') }}
      </UButton>
    </header>

    <div
      class="flex flex-col gap-1"
      role="status"
      data-kit-build-state
      :data-state="build.state"
    >
      <div class="flex items-center gap-2">
        <UBadge
          :color="state.color"
          variant="subtle"
          size="sm"
          :icon="state.icon"
          :ui="build.state === 'building' ? { leadingIcon: 'animate-spin motion-reduce:animate-none' } : undefined"
        >
          {{ t(`productKit.build.state.${build.state}`) }}
        </UBadge>
        <span class="text-xs text-muted">{{ t(`productKit.build.stateHelp.${build.state}`) }}</span>
      </div>
      <p
        v-if="build.state === 'failed' && build.message"
        class="text-xs break-words text-error"
        data-kit-build-message
      >
        {{ build.message }}
      </p>
    </div>

    <AuthoringErrorAlert
      v-if="restartError"
      :title="t('productKit.build.restartFailed')"
      :error="restartError"
      @close="restartError = undefined"
    />

    <p
      v-if="!canReadLog"
      class="flex items-center gap-1.5 text-xs text-muted"
      data-access-notice="build-log"
      data-missing-key="product-kit.source.read"
    >
      <UIcon
        name="i-lucide-user-lock"
        class="size-3.5 shrink-0"
      />
      {{ t('productKit.build.logRequiresKey', { key: 'product-kit.source.read' }) }}
    </p>
    <UCollapsible
      v-else
      :open="logOpen"
      @update:open="onLogOpen"
    >
      <UButton
        color="neutral"
        variant="link"
        trailing-icon="i-lucide-chevron-down"
        class="px-0"
        :ui="{ trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform' }"
        data-kit-build-log-toggle
      >
        {{ t('productKit.build.log') }}
      </UButton>
      <template #content>
        <div class="flex flex-col gap-2 pt-1">
          <UAlert
            v-if="logError"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="logError.message"
            :actions="[{ label: t('common.retry'), color: 'neutral', variant: 'outline', onClick: () => { void loadLog() } }]"
          />
          <pre
            v-else-if="log"
            class="max-h-96 overflow-auto rounded-md border border-default bg-muted p-3 font-mono text-xs whitespace-pre-wrap text-default"
            tabindex="0"
            :aria-label="t('productKit.build.log')"
            translate="no"
            data-kit-build-log
          >{{ log }}</pre>
          <p
            v-else-if="!logLoading"
            class="text-sm text-muted"
            data-kit-build-log-empty
          >
            {{ t('productKit.build.logEmpty') }}
          </p>
          <div>
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              icon="i-lucide-refresh-cw"
              :loading="logLoading"
              @click="loadLog"
            >
              {{ t('productKit.build.reloadLog') }}
            </UButton>
          </div>
        </div>
      </template>
    </UCollapsible>
  </section>
</template>
