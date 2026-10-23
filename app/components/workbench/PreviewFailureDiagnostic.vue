<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import { previewFailureCopyKeys } from '../../../src/preview/failure-diagnostic'

/**
 * The inline Preview diagnostic (issue #111): persistent and non-modal, under the canvas bar while
 * Preview is unavailable after a non-recoverable failure. The title comes from the failure
 * category and the body from the recognized reason (else the category's generic copy); the reason
 * code and the correlation identities stay in the collapsed technical details. Retry Preview is
 * the one shared recovery action, and it stays focusable but disabled while its retry is pending.
 */
const { t } = useI18n()
const { preview } = useWorkbench()

const failure = computed(() => preview.failureDiagnostic.value)
const copy = computed(() => failure.value ? previewFailureCopyKeys(failure.value) : undefined)
const pending = computed(() => preview.retryPending.value)
const detailsOpen = ref(false)

const identities = computed(() => {
	const correlation = failure.value?.correlation ?? {}
	return [
		{ key: 'previewSessionId', label: t('session.sessionId'), value: correlation.previewSessionId },
		{ key: 'runtimeGenerationId', label: t('session.generation'), value: correlation.runtimeGenerationId },
	].filter(entry => entry.value !== undefined)
})

function retry(): void {
	if (!pending.value) preview.retry()
}
</script>

<template>
  <div
    v-if="failure && copy"
    class="flex gap-3 border-b border-default bg-error/5 px-3 py-2.5"
    data-preview-failure
    :data-category="failure.category"
    :data-reason="failure.reason"
  >
    <UIcon
      name="i-lucide-octagon-alert"
      class="mt-0.5 size-4 shrink-0 text-error"
      aria-hidden="true"
    />
    <div class="grid min-w-0 flex-1 gap-1.5">
      <div
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
        <UButton
          color="neutral"
          variant="outline"
          size="xs"
          :icon="pending ? 'i-lucide-loader-circle' : 'i-lucide-rotate-ccw'"
          :class="pending ? 'cursor-not-allowed opacity-75 [&_svg]:animate-spin motion-reduce:[&_svg]:animate-none' : ''"
          :aria-disabled="pending ? 'true' : undefined"
          :label="t('previewFailure.retry')"
          data-preview-retry
          @click="retry"
        />
        <span
          v-if="pending"
          role="status"
          class="text-xs text-muted"
        >{{ t('previewFailure.retryPending') }}</span>
      </div>
      <UCollapsible
        v-model:open="detailsOpen"
        class="text-start"
        data-preview-failure-details
      >
        <UButton
          color="neutral"
          variant="link"
          size="xs"
          class="px-0"
          :trailing-icon="detailsOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
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
