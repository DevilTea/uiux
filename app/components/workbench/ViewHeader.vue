<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import { useViewMetadataEditor } from '../../composables/useViewMetadataEditor'
import { diagnosticText } from '../../utils/diagnostic-copy'
import LockBadge from './LockBadge.vue'
import LockedSaveAlert from './LockedSaveAlert.vue'

/**
 * The View page header: the View's name as the page heading, its `feature` tag, and the edit lease
 * badge. A member with `views.write` renames the View and sets or clears its tag in place, on every
 * device tier (Rule 01a1537a-333f-7246-b39c-5feca6f4b3c7; renaming is not structural editing, so the
 * tablet and phone read-only Rules 01a116f0-9059 and 01a116f0-909c leave it out).
 */
const props = defineProps<{ viewId: string }>()

const { t } = useI18n()
const { selectedView } = useWorkbench()
const editor = useViewMetadataEditor()
const { editing, draft, saving, conflict, locked, invalid, nameError, canRename, heldByOther } = editor

const root = ref<HTMLElement>()
const view = computed(() => selectedView.value?.key === props.viewId ? selectedView.value : undefined)
const name = computed(() => view.value?.resource.name || t('workbench.canvas.label'))

async function focus(selector: string): Promise<void> {
	await nextTick()
	root.value?.querySelector<HTMLElement>(selector)?.focus()
}

function start(): void {
	editor.start()
	if (editing.value) void focus('[data-view-name-input] input, input[data-view-name-input]')
}

function cancel(): void {
	if (saving.value) return
	editor.cancel()
	void focus('[data-view-rename]')
}

async function save(): Promise<void> {
	const saved = await editor.save()
	if (saved) void focus('[data-view-rename]')
	else if (nameError.value) void focus('[data-view-name-input] input, input[data-view-name-input]')
}

function onKeydown(event: KeyboardEvent): void {
	if (event.key === 'Escape' && !event.defaultPrevented) {
		event.preventDefault()
		cancel()
	}
}

const conflictActions = computed(() => [
	{ label: t('viewHeader.keepMine'), color: 'warning' as const, variant: 'outline' as const, size: 'sm' as const, disabled: !conflict.value?.latest, onClick: () => { void editor.keepMine() } },
	{ label: t('spec.discardMine'), color: 'neutral' as const, variant: 'outline' as const, size: 'sm' as const, onClick: () => { void editor.discardMine().then(() => focus('[data-view-rename]')) } },
])
</script>

<template>
  <header
    ref="root"
    class="shrink-0 border-b border-default bg-default px-3 py-1.5"
    data-view-header
  >
    <div
      v-if="!editing"
      class="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1"
    >
      <h1
        class="min-w-0 truncate text-title font-semibold text-highlighted"
        data-view-name
      >
        {{ name }}
      </h1>
      <UBadge
        v-if="view?.resource.feature"
        color="neutral"
        variant="subtle"
        size="sm"
        icon="i-lucide-tag"
        class="max-w-48"
        data-view-feature
      >
        <span class="sr-only">{{ t('viewHeader.feature') }}</span>
        <span
          class="truncate"
          translate="no"
        >{{ view.resource.feature }}</span>
      </UBadge>
      <UTooltip
        v-if="canRename"
        :text="heldByOther ? t('viewHeader.lockedHint') : t('viewHeader.edit')"
      >
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-pencil"
          class="pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center"
          :aria-label="t('viewHeader.editNamed', { name })"
          :disabled="heldByOther"
          data-view-rename
          @click="start"
        />
      </UTooltip>
      <LockBadge
        kind="view"
        :resource-key="viewId"
        class="ms-auto"
      />
    </div>

    <template v-else>
      <h1 class="sr-only">
        {{ name }}
      </h1>
      <UForm
        :state="draft"
        :disabled="saving"
        class="flex flex-wrap items-start gap-2 py-1"
        data-view-metadata-form
        @submit="save"
        @keydown="onKeydown"
      >
        <UFormField
          :label="t('viewHeader.name')"
          :error="nameError"
          class="min-w-48 flex-[2_1_14rem]"
          size="sm"
        >
          <UInput
            v-model="draft.name"
            class="w-full"
            autocomplete="off"
            data-view-name-input
          />
        </UFormField>
        <UFormField
          :label="t('viewHeader.feature')"
          :help="t('viewHeader.featureHelp')"
          class="min-w-40 flex-[1_1_10rem]"
          size="sm"
        >
          <UInput
            v-model="draft.feature"
            class="w-full"
            autocomplete="off"
            :placeholder="t('viewHeader.featurePlaceholder')"
            data-view-feature-input
          />
        </UFormField>
        <div class="flex items-center gap-2 self-center sm:pt-5">
          <UButton
            type="submit"
            color="primary"
            variant="solid"
            size="sm"
            :label="saving ? t('common.saving') : t('common.save')"
            :loading="saving"
            :disabled="!!conflict || heldByOther"
            data-view-metadata-save
          />
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            :label="t('common.cancel')"
            :disabled="saving"
            data-view-metadata-cancel
            @click="cancel"
          />
        </div>
      </UForm>

      <div
        v-if="locked || conflict || invalid?.length"
        class="grid gap-2 pb-1"
      >
        <LockedSaveAlert
          v-if="locked"
          :lock="locked.lock"
          @dismiss="locked = undefined"
        />
        <UAlert
          v-if="conflict"
          color="warning"
          variant="subtle"
          icon="i-lucide-history"
          :title="t('viewHeader.conflict')"
          :description="conflict.latest
            ? t('viewHeader.conflictBody', { name: conflict.latest.resource.name, feature: conflict.latest.resource.feature || t('viewHeader.noFeature') })
            : t('spec.conflictBody')"
          :actions="conflictActions"
          orientation="vertical"
          role="alert"
          data-view-metadata-conflict
        />
        <UAlert
          v-if="invalid?.length"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          role="alert"
          :title="t('viewHeader.invalidTitle')"
        >
          <template #description>
            <ul class="list-disc space-y-0.5 ps-4">
              <li
                v-for="(item, index) in invalid"
                :key="index"
              >
                {{ diagnosticText(item) }}
              </li>
            </ul>
          </template>
        </UAlert>
      </div>
    </template>
  </header>
</template>
