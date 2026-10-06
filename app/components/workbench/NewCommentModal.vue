<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from '#imports'
import type { RadioGroupItem } from '@nuxt/ui'
import { useReviewInbox } from '../../composables/useReviewInbox'
import { useAccess } from '../../composables/useAccess'
import WbErrorDescription from './WbErrorDescription.vue'

/**
 * "New comment" from the Reviews inbox and "Comment on Workspace" from the command palette
 * (scope/edit decision 8). Where: the Workspace (feedback about the product as a whole), or the
 * root of the View the reviewer came from. Canvas comment mode is unchanged and stays the way to
 * comment on a Widget. The UI says "Workspace comment", never "scope" (R1).
 */
const props = withDefaults(defineProps<{ fromViewId?: string; fromViewName?: string }>(), { fromViewId: undefined, fromViewName: undefined })
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ (e: 'created', threadId: string): void }>()

const { t } = useI18n()
const inbox = useReviewInbox()
const access = useAccess()

const where = ref<string>('workspace')
const text = ref('')
const textarea = ref<{ textareaRef?: HTMLTextAreaElement }>()

const whereItems = computed<RadioGroupItem[]>(() => [
	{ value: 'workspace', label: t('inbox.compose.workspace'), description: t('inbox.compose.workspaceHint') },
	...(props.fromViewId ? [{ value: props.fromViewId, label: t('inbox.compose.view', { name: props.fromViewName ?? props.fromViewId }), description: t('inbox.compose.viewHint') }] : []),
])

watch(open, (value) => {
	if (!value) return
	where.value = 'workspace'
	inbox.resetCompose()
	void nextTick(() => textarea.value?.textareaRef?.focus())
}, { immediate: true })

const posting = computed(() => inbox.composeState.value.posting)
const error = computed(() => inbox.composeState.value.error)

async function submit(): Promise<void> {
	if (!text.value.trim() || posting.value) return
	const key = await inbox.createComment(where.value === 'workspace' ? { scope: 'workspace' } : { viewId: where.value }, text.value)
	if (!key) return
	text.value = ''
	open.value = false
	emit('created', key)
}

function onKeydown(event: KeyboardEvent): void {
	if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
		event.preventDefault()
		void submit()
	}
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('inbox.compose.title')"
    :description="t('inbox.compose.description')"
    :ui="{ content: 'max-w-md' }"
  >
    <template #body>
      <form
        class="grid gap-4"
        data-new-comment
        @submit.prevent="submit"
      >
        <URadioGroup
          v-if="whereItems.length > 1"
          v-model="where"
          :legend="t('inbox.compose.where')"
          :items="whereItems"
          variant="card"
          size="sm"
          data-new-comment-where
        />
        <p
          v-else
          class="flex items-center gap-1.5 text-sm text-muted"
          data-new-comment-where
        >
          <UIcon
            name="i-lucide-globe"
            class="size-4 shrink-0"
            aria-hidden="true"
          />
          {{ t('comments.workspaceComment') }} · {{ t('inbox.compose.workspaceHint') }}
        </p>
        <UFormField
          :label="t('inbox.compose.message')"
          :help="access.member.value ? t('comment.commentingAs', { name: access.member.value.nickname }) : undefined"
        >
          <UTextarea
            ref="textarea"
            v-model="text"
            :placeholder="t('comment.placeholder')"
            :rows="3"
            :maxrows="10"
            autoresize
            class="w-full"
            :ui="{ base: 'pointer-coarse:text-base' }"
            data-new-comment-text
            @keydown="onKeydown"
          />
        </UFormField>
        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="error.message"
          :ui="{ title: 'text-sm', description: 'text-xs' }"
          role="alert"
        >
          <template #description>
            <WbErrorDescription
              :headline="error.message"
              :diagnostics="error.diagnostics"
              :status-code="error.statusCode"
            />
          </template>
        </UAlert>
        <div class="flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('common.cancel')"
            @click="open = false"
          />
          <UButton
            type="submit"
            color="primary"
            variant="solid"
            :loading="posting"
            :disabled="!text.trim()"
            data-new-comment-submit
          >
            {{ inbox.composeState.value.created ? t('common.retry') : t('comment.send') }}
            <UKbd
              value="meta"
              size="sm"
              class="pointer-coarse:hidden"
            />
            <UKbd
              value="enter"
              size="sm"
              class="-ms-1 pointer-coarse:hidden"
            />
          </UButton>
        </div>
      </form>
    </template>
  </UModal>
</template>
