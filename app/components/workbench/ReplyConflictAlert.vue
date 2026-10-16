<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { replyConflictChange, type ThreadState } from '../../utils/reply-conflict'
import type { InboxStatus } from '../../utils/review-inbox'

/**
 * A reply refused for a revision conflict (Rule 01a116f0-95fc-77c6-a7ab-1318cb6d19af), in the
 * canvas thread bubble and the Reviews detail and sheet alike: the caution alert says what changed
 * since the reply was written and offers Send again, which sends the kept reply once against the
 * re-read revision. Nothing is resent without it (Rule 01a11485-f451-72eb-81ad-686aeec7b3eb).
 */
const props = defineProps<{
	before: ThreadState
	after: ThreadState
	/** The composer is shown and holds text: Send again has something to send. */
	canSend: boolean
	busy: boolean
}>()
const emit = defineEmits<{ (e: 'sendAgain'): void }>()

const { t } = useI18n()

const STATUS_LABEL: Record<InboxStatus, string> = {
	'open': 'thread.status.open',
	'ready-for-review': 'thread.status.ready',
	'resolved': 'thread.status.resolved',
	'dismissed': 'inbox.group.dismissed',
}

const change = computed(() => replyConflictChange(props.before, props.after))
const description = computed(() => {
	const parts: string[] = []
	if (change.value.newMessages) parts.push(t('comments.replyConflict.newReplies', change.value.newMessages))
	if (change.value.status) parts.push(t('comments.replyConflict.status', { status: t(STATUS_LABEL[change.value.status]) }))
	if (!parts.length) parts.push(t('comments.replyConflict.changed'))
	parts.push(props.after.status === 'resolved' ? t('comments.replyConflict.keptResolved') : t('comments.replyConflict.kept'))
	return parts.join(' ')
})
</script>

<template>
  <UAlert
    color="warning"
    variant="subtle"
    icon="i-lucide-refresh-cw"
    :title="t('comments.replyConflict.title')"
    :description="description"
    :ui="{ title: 'text-sm', description: 'text-xs' }"
    role="alert"
    data-reply-conflict
    :data-new-replies="change.newMessages"
    :data-status="change.status"
  >
    <template
      v-if="canSend"
      #actions
    >
      <UButton
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-send-horizontal"
        :label="t('comments.replyConflict.sendAgain')"
        :loading="busy"
        data-reply-send-again
        @click="emit('sendAgain')"
      />
    </template>
  </UAlert>
</template>
