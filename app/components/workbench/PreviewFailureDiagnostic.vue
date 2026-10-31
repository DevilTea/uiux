<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from '#imports'
import KitButton from '~/components/kit/ui/Button.vue'
import KitIcon from '~/components/kit/ui/Icon.vue'
import { useWorkbench } from '../../composables/useWorkbench'
import { previewFailureCopyKeys } from '../../../src/preview/failure-diagnostic'

/**
 * The inline Preview diagnostic (issue #111): persistent and non-modal, under the canvas bar while
 * Preview is unavailable after a non-recoverable failure. The title comes from the failure
 * category and the body from the recognized reason (else the category's generic copy); the reason
 * code and the correlation identities stay in the collapsed technical details. Retry Preview is
 * the one shared recovery action, and it stays focusable but disabled while a retry is in flight.
 * The alert is keyed on the failing generation, so a repeated failure is announced again; when
 * Preview recovers with focus inside the diagnostic, focus moves to the canvas region.
 */
const { t } = useI18n()
const { preview } = useWorkbench()

const failure = computed(() => preview.failureDiagnostic.value)
const copy = computed(() => failure.value ? previewFailureCopyKeys(failure.value) : undefined)
const disabled = computed(() => preview.retryDisabled.value)
const statusText = computed(() => {
	if (disabled.value) return t('previewFailure.retryPending')
	return preview.retryInFlight.value ? t('previewFailure.retryStalled') : ''
})
const alertKey = computed(() => failure.value ? `${failure.value.reason}\u0000${failure.value.correlation?.runtimeGenerationId ?? ''}` : '')
const detailsOpen = ref(false)
const root = ref<HTMLElement>()

// Runs before the DOM update, while the diagnostic that held focus is still in the document.
watch(failure, (next) => {
	if (next || !root.value?.contains(document.activeElement)) return
	void nextTick(() => document.querySelector<HTMLElement>('[data-canvas]')?.focus({ preventScroll: true }))
}, { flush: 'pre' })

const identities = computed(() => {
	const correlation = failure.value?.correlation ?? {}
	return [
		{ key: 'previewSessionId', label: t('session.sessionId'), value: correlation.previewSessionId },
		{ key: 'runtimeGenerationId', label: t('session.generation'), value: correlation.runtimeGenerationId },
	].filter(entry => entry.value !== undefined)
})

function retry(): void {
	if (!disabled.value) preview.retry()
}
</script>

<template>
  <div
    v-if="failure && copy"
    ref="root"
    class="flex gap-3 border-b border-default bg-error/5 px-3 py-2.5"
    data-preview-failure
    :data-category="failure.category"
    :data-reason="failure.reason"
  >
    <KitIcon
      name="octagon-alert"
      class="mt-0.5 text-error"
    />
    <div class="grid min-w-0 flex-1 gap-1.5">
      <div
        :key="alertKey"
        role="alert"
        class="grid gap-0.5"
      >
        <p
          class="text-sm font-medium text-highlighted"
          data-preview-failure-title
        >
          {{ t(copy.title) }}
        </p>
        <p
          class="text-xs text-toned"
          data-preview-failure-body
        >
          {{ t(copy.body) }}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <KitButton
          variant="outline"
          size="xs"
          :icon="disabled ? 'loader-circle' : 'rotate-ccw'"
          :class="disabled ? 'cursor-not-allowed opacity-75 [&_svg]:animate-spin motion-reduce:[&_svg]:animate-none' : ''"
          :aria-disabled="disabled ? 'true' : undefined"
          :label="t('previewFailure.retry')"
          data-preview-retry
          @click="retry"
        />
        <span
          role="status"
          class="text-xs text-muted"
          data-preview-retry-status
        >{{ statusText }}</span>
      </div>
      <UCollapsible
        v-model:open="detailsOpen"
        class="text-start"
        data-preview-failure-details
      >
        <KitButton
          variant="link-muted"
          size="xs"
          trailing-icon="chevron-down"
          :expanded="detailsOpen"
          :label="t('previewFailure.details')"
        />
        <template #content>
          <dl class="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt class="text-muted">
              {{ t('previewFailure.reasonLabel') }}
            </dt>
            <dd
              class="break-all font-mono text-toned"
              translate="no"
              data-preview-failure-reason
            >
              {{ failure.reason }}
            </dd>
            <template v-if="failure.detail">
              <dt class="text-muted">
                {{ t('previewFailure.detailLabel') }}
              </dt>
              <dd
                class="break-words font-mono text-toned"
                translate="no"
              >
                {{ failure.detail }}
              </dd>
            </template>
            <template
              v-for="identity in identities"
              :key="identity.key"
            >
              <dt class="text-muted">
                {{ identity.label }}
              </dt>
              <dd
                class="break-all font-mono text-toned"
                translate="no"
                :data-preview-failure-identity="identity.key"
              >
                {{ identity.value }}
              </dd>
            </template>
          </dl>
        </template>
      </UCollapsible>
    </div>
  </div>
</template>
