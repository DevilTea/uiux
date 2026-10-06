<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'

/**
 * The preview session chip in the canvas bar (brief b, sections 6 and 8): "Live", "Connecting
 * preview…", "Reconnecting…" or "Preview stopped". The session and generation identities stay one
 * click away in a popover, never in the default reading path.
 */
const { t } = useI18n()
const { preview } = useWorkbench()

const status = computed(() => {
	switch (preview.sessionStatus.value) {
		case 'live':
			return { color: 'neutral' as const, dot: 'bg-(--ui-text-muted)', label: t('session.live'), hint: t('session.liveHint') }
		case 'reconnecting':
			return { color: 'warning' as const, dot: 'bg-warning', label: t('session.reconnecting'), hint: t('session.reconnectingHint') }
		case 'stopped':
			return { color: 'error' as const, dot: 'bg-error', label: t('session.stopped'), hint: t('session.stoppedHint') }
		default:
			return { color: 'neutral' as const, dot: 'bg-accented', label: t('session.connecting'), hint: t('session.connectingHint') }
	}
})
const pending = computed(() => preview.sessionStatus.value === 'connecting' || preview.sessionStatus.value === 'reconnecting')
</script>

<template>
  <UPopover :content="{ align: 'end', sideOffset: 6 }">
    <UButton
      :color="status.color"
      variant="ghost"
      size="sm"
      class="gap-1.5 px-2 font-medium"
      :class="status.color === 'neutral' ? 'text-muted' : ''"
      :aria-label="t('session.chipLabel', { status: status.label })"
      data-session-status
      :data-status="preview.sessionStatus.value"
    >
      <span
        class="size-2 shrink-0 rounded-full"
        :class="[status.dot, pending ? 'animate-pulse motion-reduce:animate-none' : '']"
        aria-hidden="true"
      />
      <span
        role="status"
        class="text-xs"
      >{{ status.label }}</span>
    </UButton>

    <template #content>
      <div class="grid w-72 gap-3 p-3">
        <p class="text-sm text-default">
          {{ status.hint }}
        </p>
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt class="text-muted">
            {{ t('session.sessionId') }}
          </dt>
          <dd class="truncate font-mono text-toned">
            {{ preview.previewSessionId.value }}
          </dd>
          <dt class="text-muted">
            {{ t('session.generation') }}
          </dt>
          <dd class="truncate font-mono text-toned">
            {{ preview.runtimeGenerationId.value }}
          </dd>
        </dl>
        <UButton
          v-if="preview.sessionStatus.value !== 'live'"
          color="neutral"
          variant="outline"
          size="sm"
          icon="i-lucide-rotate-ccw"
          class="justify-self-start"
          @click="preview.retry()"
        >
          {{ t('session.retry') }}
        </UButton>
      </div>
    </template>
  </UPopover>
</template>
