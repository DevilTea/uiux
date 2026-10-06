<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from '#imports'
import type { DropdownMenuItem } from '@nuxt/ui'
import type { ReviewThread } from '../../../src/domain/reviews/schema'
import { messageVersions, type ReviewTimelineItem } from '../../utils/review-timeline'
import { messageEditState } from '../../utils/review-message-actions'
import { relativeTime } from '../../utils/widget-inspection'
import { memberInitials } from '../../utils/member-initials'
import { useWorkbenchFormat } from '../../composables/useWorkbenchFormat'

/**
 * One Review message in a timeline (Part 7 10b; scope/edit decision 16), shared by the inbox
 * detail and the canvas thread bubble. It renders the avatar and the message column as two grid
 * cells of the parent row.
 *
 * - The author's own message gets **Edit** in its menu; the body turns into an inline editor
 *   (`⌘↵` saves, `Esc` cancels). After a later submission or resolution, Edit stays in the menu,
 *   disabled, with the reason.
 * - An edited message shows "· edited" after its time; it opens the read-only Edit history,
 *   newest first, for everyone who can read the thread.
 */
type MessageItem = Extract<ReviewTimelineItem, { kind: 'message' }>

const props = withDefaults(defineProps<{
	item: MessageItem
	thread: ReviewThread
	/** The signed-in member's stamped actor id (`member:<uuid>`). */
	me?: string
	/** Reviewer role and a live Workbench (not the publication, not a Viewer). */
	canEdit?: boolean
	compact?: boolean
	editing?: boolean
	saving?: boolean
}>(), { me: undefined, canEdit: false, compact: false, editing: false, saving: false })

const emit = defineEmits<{
	(e: 'update:editing', value: boolean): void
	(e: 'save', body: string): void
}>()

const { t, locale } = useI18n()
const fmt = useWorkbenchFormat()

const actor = computed(() => props.item.actor)
const name = computed(() => actor.value.displayName ?? actor.value.id ?? t('comments.unknownAuthor'))
const agent = computed(() => actor.value.type === 'agent')
const human = computed(() => actor.value.type === 'human')

const editState = computed(() => props.canEdit ? messageEditState(props.thread, props.item.id, props.me) : { kind: 'none' as const })
const frozenReason = computed(() => editState.value.kind === 'frozen' ? t(editState.value.by === 'submission' ? 'comments.frozen.submission' : 'comments.frozen.resolution') : undefined)

const menu = computed<DropdownMenuItem[][]>(() => {
	if (editState.value.kind === 'none') return []
	return [[{
		label: t('comments.edit'),
		icon: 'i-lucide-pencil',
		disabled: editState.value.kind === 'frozen',
		...(frozenReason.value ? { description: frozenReason.value } : {}),
		onSelect: () => startEditing(),
		'data-message-edit': '',
	}]]
})

// ---------------------------------------------------------------------------------------------
// Inline editor
// ---------------------------------------------------------------------------------------------

const draft = ref('')
const editor = ref<{ textareaRef?: HTMLTextAreaElement }>()
const changed = computed(() => draft.value.trim().length > 0 && draft.value !== props.item.body)

function startEditing(): void {
	if (editState.value.kind !== 'editable') return
	emit('update:editing', true)
}

watch(() => props.editing, (on) => {
	if (!on) return
	draft.value = props.item.body
	void nextTick(() => {
		const area = editor.value?.textareaRef
		area?.focus()
		area?.setSelectionRange(area.value.length, area.value.length)
	})
}, { immediate: true })

function cancel(): void {
	emit('update:editing', false)
}

function save(): void {
	if (!changed.value || props.saving) return
	emit('save', draft.value)
}

function onEditorKeydown(event: KeyboardEvent): void {
	if (event.key === 'Escape') {
		// The editor owns Escape: it must not also close the bubble or the sheet.
		event.preventDefault()
		event.stopPropagation()
		cancel()
	}
	else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
		event.preventDefault()
		event.stopPropagation()
		save()
	}
}

// ---------------------------------------------------------------------------------------------
// "· edited" and the Edit history
// ---------------------------------------------------------------------------------------------

const versions = computed(() => messageVersions(props.item))
const editedTime = computed(() => props.item.editedAt ? fmt.dateTime(props.item.editedAt) : '')
</script>

<template>
  <UAvatar
    :text="human ? memberInitials(name) : undefined"
    :icon="agent ? 'i-lucide-bot' : human ? undefined : 'i-lucide-cog'"
    :size="compact ? 'xs' : 'sm'"
    aria-hidden="true"
  />
  <div
    class="group/message min-w-0"
    :data-message-id="item.id"
    :data-message-edited="item.editedAt ? '' : undefined"
    :data-message-editable="editState.kind === 'editable' ? '' : undefined"
    :data-message-frozen="editState.kind === 'frozen' ? '' : undefined"
  >
    <div
      class="flex min-h-6 flex-wrap items-center gap-x-1.5 gap-y-0.5"
      :class="compact ? 'text-xs text-muted' : 'text-sm'"
    >
      <b class="font-semibold text-highlighted text-sm">{{ name }}</b>
      <UBadge
        v-if="agent"
        color="neutral"
        variant="soft"
        size="sm"
        :label="t('comments.agent')"
      />
      <time
        class="text-xs text-dimmed"
        :datetime="item.at"
        :title="fmt.dateTime(item.at)"
      >{{ relativeTime(item.at, locale) }}</time>
      <UPopover
        v-if="item.editedAt"
        :content="{ align: 'start', side: 'bottom' }"
      >
        <UButton
          color="neutral"
          variant="link"
          size="xs"
          class="p-0 text-xs text-dimmed hover:text-highlighted"
          :aria-label="t('comments.editedLabel', { time: editedTime })"
          :title="editedTime"
          data-message-edited-toggle
        >
          · {{ t('comments.edited') }}
        </UButton>
        <template #content>
          <div
            class="grid w-80 max-w-[calc(100vw-2rem)] gap-2 p-3"
            data-edit-history
          >
            <p class="text-xs font-medium text-muted">
              {{ t('comments.editHistory') }}
            </p>
            <ol class="grid max-h-72 gap-2.5 overflow-y-auto">
              <li
                v-for="(version, index) in versions"
                :key="`${version.at}-${index}`"
                class="grid gap-0.5 border-t border-default pt-2 first:border-t-0 first:pt-0"
                data-edit-version
              >
                <span class="flex items-center gap-1.5 text-xs text-dimmed">
                  <time
                    :datetime="version.at"
                    :title="fmt.dateTime(version.at)"
                  >{{ fmt.dateTime(version.at) }}</time>
                  <UBadge
                    v-if="version.current"
                    color="neutral"
                    variant="soft"
                    size="sm"
                    :label="t('comments.editCurrent')"
                  />
                  <UBadge
                    v-else-if="index === versions.length - 1"
                    color="neutral"
                    variant="outline"
                    size="sm"
                    :label="t('comments.editOriginal')"
                  />
                </span>
                <p
                  class="text-sm break-words whitespace-pre-wrap text-default"
                  v-text="version.body"
                />
              </li>
            </ol>
          </div>
        </template>
      </UPopover>
      <span class="flex-1" />
      <UDropdownMenu
        v-if="menu.length && !editing"
        :items="menu"
        :content="{ align: 'end' }"
        :ui="{ itemDescription: 'max-w-56 whitespace-normal' }"
      >
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-ellipsis"
          class="-my-1 opacity-100 sm:opacity-0 sm:group-hover/message:opacity-100 sm:focus-visible:opacity-100 sm:data-[state=open]:opacity-100 pointer-coarse:opacity-100"
          :aria-label="t('comments.messageActions')"
          data-message-menu
        />
      </UDropdownMenu>
    </div>

    <div
      v-if="editing"
      class="mt-1 grid gap-1.5"
      data-message-editor
    >
      <UTextarea
        ref="editor"
        v-model="draft"
        :aria-label="t('comments.editMessage')"
        :rows="1"
        :maxrows="compact ? 6 : 10"
        autoresize
        class="w-full"
        :ui="{ base: 'pointer-coarse:text-base' }"
        @keydown="onEditorKeydown"
      />
      <div class="flex justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          data-message-edit-cancel
          @click="cancel"
        >
          {{ t('common.cancel') }}
          <UKbd
            value="escape"
            size="sm"
            class="pointer-coarse:hidden"
          />
        </UButton>
        <UButton
          color="primary"
          variant="solid"
          size="xs"
          :loading="saving"
          :disabled="!changed"
          data-message-edit-save
          @click="save"
        >
          {{ t('comments.editSave') }}
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
    </div>
    <p
      v-else
      class="break-words whitespace-pre-wrap text-default"
      :class="compact ? 'text-sm leading-normal' : 'mt-1 max-w-[68ch] text-body'"
      data-message-body
      v-text="item.body"
    />
  </div>
</template>
