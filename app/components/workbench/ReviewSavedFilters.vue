<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from '#imports'
import KitButton from '~/components/kit/ui/Button.vue'
import { useReviewInbox } from '../../composables/useReviewInbox'
import { MAX_SAVED_FILTERS, MAX_SAVED_FILTER_NAME } from '../../utils/saved-inbox-filters'

/**
 * Per-browser saved filters of the Reviews inbox (issue #62): a menu next to the quick filters
 * that applies, renames and deletes saved filters and saves the current one under a name. The
 * menu is a popover of ordinary buttons, so Tab, Enter, Space and Escape work as everywhere else;
 * Escape inside the name field cancels the edit before the popover closes.
 */
const { t } = useI18n()
const inbox = useReviewInbox()

const open = ref(false)
/** The name form: saving the current filter, or renaming one saved filter. */
const editing = ref<{ mode: 'save' } | { mode: 'rename'; id: string }>()
const name = ref('')
const error = ref<string>()
const nameInput = ref<{ inputRef?: HTMLInputElement }>()
const saveButton = ref<{ $el?: HTMLElement }>()

const active = computed(() => inbox.savedFilters.value.find(item => item.id === inbox.activeSavedId.value))
const triggerLabel = computed(() => active.value ? t('inbox.saved.menuNamed', { name: active.value.name }) : t('inbox.saved.menu'))

watch(name, () => { error.value = undefined })
watch(open, (value) => {
	if (!value) cancel()
})

function focusName(): void {
	void nextTick(() => nameInput.value?.inputRef?.focus())
}
function startSave(): void {
	editing.value = { mode: 'save' }
	name.value = ''
	error.value = undefined
	focusName()
}
function startRename(id: string): void {
	const item = inbox.savedFilters.value.find(entry => entry.id === id)
	if (!item) return
	editing.value = { mode: 'rename', id }
	name.value = item.name
	error.value = undefined
	focusName()
}
function cancel(): void {
	editing.value = undefined
	error.value = undefined
}
function submit(): void {
	const current = editing.value
	if (!current) return
	const refusal = current.mode === 'save' ? inbox.saveCurrentFilter(name.value) : inbox.renameSavedFilter(current.id, name.value)
	if (refusal) {
		error.value = t(`inbox.saved.errors.${refusal}`, { n: MAX_SAVED_FILTERS })
		focusName()
		return
	}
	cancel()
}
function remove(id: string): void {
	inbox.deleteSavedFilter(id)
	cancel()
	void nextTick(() => saveButton.value?.$el?.focus())
}
function apply(id: string): void {
	inbox.applySavedFilter(id)
	open.value = false
}
</script>

<template>
  <div class="contents">
    <UPopover
      v-model:open="open"
      :content="{ align: 'start' }"
    >
      <UButton
        size="xs"
        color="neutral"
        :variant="active ? 'soft' : 'ghost'"
        icon="i-lucide-bookmark"
        trailing-icon="i-lucide-chevron-down"
        :label="active ? active.name : t('inbox.saved.menu')"
        :aria-label="triggerLabel"
        class="max-w-full pointer-coarse:min-h-11"
        :ui="{ label: 'truncate' }"
        data-review-saved-trigger
      />
      <template #content>
        <div
          class="w-80 max-w-[calc(100vw-2rem)] p-2"
          data-review-saved
        >
          <ul
            v-if="inbox.savedFilters.value.length"
            class="mb-2 flex flex-col gap-0.5"
            :aria-label="t('inbox.saved.list')"
          >
            <li
              v-for="item in inbox.savedFilters.value"
              :key="item.id"
              class="flex items-center gap-0.5"
              :data-review-saved-item="item.name"
            >
              <UButton
                size="sm"
                color="neutral"
                :variant="item.id === inbox.activeSavedId.value ? 'soft' : 'ghost'"
                :icon="item.id === inbox.activeSavedId.value ? 'i-lucide-check' : 'i-lucide-bookmark'"
                :label="item.name"
                :aria-label="t('inbox.saved.apply', { name: item.name })"
                :aria-pressed="item.id === inbox.activeSavedId.value"
                class="min-w-0 flex-1 justify-start pointer-coarse:min-h-11"
                :ui="{ label: 'truncate' }"
                data-review-saved-apply
                @click="apply(item.id)"
              />
              <KitButton
                size="sm"
                variant="ghost"
                icon="pencil"
                icon-only
                :label="t('inbox.saved.renameNamed', { name: item.name })"
                data-review-saved-rename
                @click="startRename(item.id)"
              />
              <KitButton
                size="sm"
                variant="ghost"
                icon="trash-2"
                icon-only
                :label="t('inbox.saved.deleteNamed', { name: item.name })"
                data-review-saved-delete
                @click="remove(item.id)"
              />
            </li>
          </ul>
          <p
            v-else
            class="px-2 pb-2 text-sm text-muted"
          >
            {{ t('inbox.saved.empty') }}
          </p>

          <form
            v-if="editing"
            class="flex flex-col gap-2 border-t border-default px-1 pt-2"
            data-review-saved-form
            @submit.prevent="submit"
            @keydown.escape.stop.prevent="cancel"
          >
            <UFormField
              :label="t('inbox.saved.nameLabel')"
              :error="error"
              :ui="{ label: 'text-xs font-medium text-muted' }"
            >
              <UInput
                ref="nameInput"
                v-model="name"
                :maxlength="MAX_SAVED_FILTER_NAME"
                :placeholder="t('inbox.saved.namePlaceholder')"
                class="w-full"
                :ui="{ base: 'pointer-coarse:text-base' }"
                data-review-saved-name
              />
            </UFormField>
            <div class="flex justify-end gap-2">
              <KitButton
                type="button"
                size="sm"
                variant="ghost"
                :label="t('inbox.saved.cancel')"
                @click="cancel"
              />
              <KitButton
                type="submit"
                size="sm"
                variant="primary"
                :label="editing.mode === 'save' ? t('inbox.saved.save') : t('inbox.saved.rename')"
                data-review-saved-submit
              />
            </div>
          </form>
          <KitButton
            v-else
            ref="saveButton"
            size="sm"
            variant="outline"
            icon="bookmark-plus"
            :label="t('inbox.saved.saveCurrent')"
            :disabled="!inbox.canSaveFilters.value"
            full-width
            data-review-saved-save
            @click="startSave"
          />
          <p class="px-1 pt-2 text-xs text-muted">
            {{ t('inbox.saved.browserOnly') }}
          </p>
        </div>
      </template>
    </UPopover>
    <p
      v-if="inbox.savedNotice.value"
      class="basis-full text-xs text-muted"
      data-review-saved-changed
    >
      {{ t('inbox.saved.changed', { name: inbox.savedNotice.value.name, n: inbox.savedNotice.value.dropped }, inbox.savedNotice.value.dropped) }}
    </p>
  </div>
</template>
