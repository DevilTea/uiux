<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../../composables/useWorkbench'
import { threadAuthorInitials, useCanvasComments } from '../../../composables/useCanvasComments'
import { flattenWidgetTree } from '../../../../src/preview/widget-tree'

/**
 * The inline composer at the click point (brief c, sections 5 and 6): Widget chip, Variant scope,
 * the message, "Commenting as", Cancel and Comment ⌘↵. No dialog, no form page.
 */
const { t } = useI18n()
const workbench = useWorkbench()
const comments = useCanvasComments()!
const { contextOptions, widgetTreeResult } = workbench

const composer = computed(() => comments.composer.value!)
const textarea = ref<{ textareaRef?: HTMLTextAreaElement }>()

const widgetType = computed(() => {
	const tree = widgetTreeResult.value
	return tree?.status === 'valid' ? flattenWidgetTree(tree.root).find(node => node.id === composer.value.widgetId)?.type : undefined
})
const variant = computed(() => contextOptions.value.variants.selected || '')
const scopeItems = computed(() => [
	{ label: t('comment.scopeThis'), value: 'this' },
	{ label: t('comment.scopeAll'), value: 'all' },
])
const scope = computed({
	get: () => composer.value.scope,
	set: (value: 'this' | 'all') => comments.patchComposer({ scope: value }),
})
const text = computed({
	get: () => composer.value.text,
	set: (value: string) => comments.setComposerText(value),
})
const name = computed(() => comments.member.value?.nickname ?? '')

function focus(): void {
	void nextTick(() => {
		const element = textarea.value?.textareaRef
		element?.focus({ preventScroll: true })
		element?.setSelectionRange(element.value.length, element.value.length)
	})
}
onMounted(focus)
watch(() => composer.value.sequence, focus)
watch(() => composer.value.askingDiscard, (asking) => { if (!asking) focus() })

function onKeydown(event: KeyboardEvent): void {
	if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
		event.preventDefault()
		void comments.sendComposer()
	}
}
</script>

<template>
  <div
    class="grid w-80 max-w-[calc(100vw-2rem)] gap-2.5 p-3"
    data-comment-composer
    @keydown="onKeydown"
  >
    <span
      id="comment-composer-title"
      class="sr-only"
    >{{ t('comment.placeholder') }}</span>
    <div class="flex min-w-0 items-center gap-2">
      <span
        class="min-w-0 truncate rounded-sm border border-default px-1.5 font-mono text-xs leading-5 text-muted"
        :title="`${widgetType ?? 'Widget'} · #${composer.widgetId}`"
        data-composer-target
      >{{ widgetType ?? 'Widget' }} · #{{ composer.widgetId }}</span>
      <span class="flex-1" />
      <USelect
        v-if="variant"
        v-model="scope"
        :items="scopeItems"
        size="xs"
        variant="ghost"
        :aria-label="t('comments.scopeLabel')"
        class="shrink-0"
        data-composer-scope
      />
      <span
        v-else
        class="shrink-0 text-xs text-muted"
      >{{ t('comment.scopeAll') }}</span>
    </div>
    <UTextarea
      ref="textarea"
      v-model="text"
      :placeholder="t('comment.placeholder')"
      :aria-label="t('comment.placeholder')"
      :rows="2"
      :maxrows="8"
      autoresize
      :readonly="composer.posting"
      class="w-full"
      data-composer-text
    />
    <div
      v-if="composer.askingDiscard"
      class="flex flex-wrap items-center gap-2 rounded-md bg-muted p-2 text-sm"
      data-composer-discard
    >
      <span class="me-auto">{{ t('comment.discard') }}</span>
      <UButton
        size="xs"
        color="neutral"
        variant="outline"
        :label="t('comments.keepEditing')"
        @click="comments.patchComposer({ askingDiscard: false })"
      />
      <UButton
        size="xs"
        color="error"
        variant="soft"
        :label="t('comments.discardAction')"
        @click="comments.closeComposer(true)"
      />
    </div>
    <UAlert
      v-if="composer.error"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="composer.error.message"
      :description="composer.error.diagnostics.map(item => item.message).filter(item => item !== composer.error?.message).join(' ') || undefined"
      :actions="[{ label: t('common.retry'), color: 'error', variant: 'outline', size: 'xs', icon: 'i-lucide-refresh-cw', onClick: () => { void comments.sendComposer() } }]"
      :ui="{ title: 'text-sm', description: 'text-xs' }"
      data-composer-error
    />
    <div class="flex flex-wrap items-center gap-2">
      <span class="me-auto flex min-w-0 items-center gap-1.5 text-xs text-muted">
        <UAvatar
          :text="threadAuthorInitials({ type: 'human', displayName: name })"
          size="2xs"
          :alt="name"
          aria-hidden="true"
        />
        <span class="truncate">{{ t('comment.commentingAs', { name }) }}</span>
      </span>
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        :label="t('common.cancel')"
        @click="comments.closeComposer()"
      />
      <UButton
        size="sm"
        color="primary"
        variant="solid"
        :loading="composer.posting"
        :disabled="!composer.text.trim()"
        data-composer-send
        @click="comments.sendComposer()"
      >
        {{ t('comment.send') }}
        <UKbd
          value="meta"
          size="sm"
          class="bg-transparent text-current ring-current/35 pointer-coarse:hidden"
        />
        <UKbd
          value="enter"
          size="sm"
          class="-ms-1 bg-transparent text-current ring-current/35 pointer-coarse:hidden"
        />
      </UButton>
    </div>
  </div>
</template>
