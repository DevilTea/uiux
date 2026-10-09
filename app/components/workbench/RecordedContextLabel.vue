<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import type { ReviewRenderContext } from '../../../src/domain/reviews/schema'
import { resolveRecordedContext } from '../../../src/preview/render-context-options'
import { useWorkbench } from '../../composables/useWorkbench'
import { recordedContextParts, recordedContextText } from '../../utils/thread-render-context'

/**
 * A thread header's recorded render context (Rule 01a1170f-c11d), such as "zh-TW · mobile · dark":
 * only the members the thread records, as identities in the mono register. A key that no longer
 * exists in the Workspace is struck through in the warning ink and named as gone for assistive
 * tech (Rule 01a1170f-c165), so the state is not carried by color alone.
 */
const props = defineProps<{ context?: ReviewRenderContext }>()

const { t } = useI18n()
const workbench = useWorkbench()

const parts = computed(() => {
	const keys = workbench.renderContextKeys.value
	return recordedContextParts(props.context, keys && props.context ? resolveRecordedContext(props.context, keys).missing : [])
})
const text = computed(() => recordedContextText(parts.value))
const title = computed(() => t('threadContext.label', { context: text.value }))
</script>

<template>
  <span
    v-if="parts.length"
    class="inline-flex min-w-0 items-center gap-1 rounded-sm border border-default px-1.5 font-mono leading-5"
    :title="title"
    data-thread-context
    :data-context="text"
  >
    <UIcon
      name="i-lucide-scan-eye"
      class="size-3.5 shrink-0"
      aria-hidden="true"
    />
    <span class="sr-only">{{ t('threadContext.srPrefix') }}</span>
    <span class="min-w-0 truncate">
      <template
        v-for="(part, index) in parts"
        :key="part.member"
      >
        <template v-if="index">
          <span aria-hidden="true">{{ ' · ' }}</span>
          <span class="sr-only">{{ t('common.listSeparator') }}</span>
        </template>
        <span
          :class="part.missing ? 'text-warning line-through' : ''"
          :data-context-member="part.member"
          :data-context-missing="part.missing ? '' : undefined"
        >{{ part.key }}</span>
        <span
          v-if="part.missing"
          class="sr-only"
        >{{ t('threadContext.missingSr') }}</span>
      </template>
    </span>
  </span>
</template>
