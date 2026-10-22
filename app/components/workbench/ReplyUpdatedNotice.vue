<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import type { ReplyConflictChange } from '../../utils/reply-conflict'
import type { InboxStatus } from '../../utils/review-inbox'

/**
 * The thread changed elsewhere while a reply is being drafted (Rule
 * 01a11485-f434-75ed-ab0a-e321468c8407), above the composer in the canvas thread bubble and the
 * Reviews detail and sheet alike: it names what changed since the draft started and keeps the draft
 * aimed at that revision until the user acknowledges it. Nothing is sent from here.
 *
 * The live region is always mounted and only its content appears, so a screen reader announces the
 * notice as it shows (a role mounted together with its content is often missed). Pass `change`
 * only while the notice applies.
 */
const props = defineProps<{ change?: ReplyConflictChange }>()
const emit = defineEmits<{ (e: 'acknowledge'): void }>()

const { t } = useI18n()

const STATUS_LABEL: Record<InboxStatus, string> = {
	'open': 'thread.status.open',
	'ready-for-review': 'thread.status.ready',
	'resolved': 'thread.status.resolved',
	'dismissed': 'inbox.group.dismissed',
}

const title = computed(() => {
	const change = props.change
	if (!change) return ''
	const parts: string[] = []
	if (change.newMessages) parts.push(t('comments.replyUpdated.newReplies', change.newMessages))
	if (change.status) parts.push(t('comments.replyUpdated.status', { status: t(STATUS_LABEL[change.status]) }))
	return parts.length ? t('comments.replyUpdated.titleWith', { changes: parts.join(t('common.listSeparator')) }) : t('comments.replyUpdated.title')
})
</script>

<template>
  <div
    role="status"
    aria-live="polite"
    class="empty:sr-only"
    data-reply-updated-region
  >
    <UAlert
      v-if="change"
      color="info"
      variant="subtle"
      icon="i-lucide-users"
      :title="title"
      :description="t('comments.replyUpdated.hint')"
      :ui="{ title: 'text-sm', description: 'text-xs' }"
      data-reply-updated
      :data-new-replies="change.newMessages"
      :data-status="change.status"
    >
      <template #actions>
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-check"
          :label="t('comments.replyUpdated.acknowledge')"
          data-reply-acknowledge
          @click="emit('acknowledge')"
        />
      </template>
    </UAlert>
  </div>
</template>
