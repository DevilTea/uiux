<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n, useRouter } from '#imports'
import { useAuthoringAccess } from '../../composables/useAuthoringAccess'
import { useWorkbench } from '../../composables/useWorkbench'
import { useViewMetadataEditor } from '../../composables/useViewMetadataEditor'
import { diagnosticText } from '../../utils/diagnostic-copy'
import KitBadge from '~/components/kit/ui/Badge.vue'
import KitButton from '~/components/kit/ui/Button.vue'
import DeleteResourceAction from './DeleteResourceAction.vue'
import LockBadge from './LockBadge.vue'
import LockedSaveAlert from './LockedSaveAlert.vue'

/**
 * The View page header: the View's name as the page heading, its `feature` tag, and the edit lease
 * badge. A member with `views.write` renames the View and sets or clears its tag in place, on every
 * device tier (Rule 01a1537a-333f-7246-b39c-5feca6f4b3c7; renaming is not structural editing, so the
 * tablet and phone read-only Rules 01a116f0-9059 and 01a116f0-909c leave it out). Deleting the View is
 * structural: it is offered on a desktop window to a member with `views.write` (Rule
 * 01a1144e-50dd-7b92-aa5e-e175e34bf424), after the impact is shown and acknowledged.
 */
const props = defineProps<{ viewId: string }>()

const { t } = useI18n()
const router = useRouter()
const { selectedView } = useWorkbench()
const editor = useViewMetadataEditor()
const { editing, draft, saving, conflict, locked, invalid, nameError, canRename, heldByOther } = editor

const { canEdit: canDelete } = useAuthoringAccess('views.write', () => ({ kind: 'view', key: props.viewId }))

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
	{ label: t('viewHeader.discardMine'), color: 'neutral' as const, variant: 'outline' as const, size: 'sm' as const, onClick: () => { void editor.discardMine().then(() => focus('[data-view-rename]')) } },
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
      <KitBadge
        v-if="view?.resource.feature"
        icon="tag"
        truncate
        class="max-w-48"
        data-view-feature
      >
        <span class="sr-only">{{ t('viewHeader.feature') }}</span>
        <span translate="no">{{ view.resource.feature }}</span>
      </KitBadge>
      <UTooltip
        v-if="canRename"
        :text="heldByOther ? t('viewHeader.lockedHint') : t('viewHeader.edit')"
      >
        <span
          class="inline-flex"
          :tabindex="heldByOther ? 0 : undefined"
          :aria-label="heldByOther ? t('viewHeader.lockedHint') : undefined"
          data-view-rename-wrap
        >
          <KitButton
            variant="ghost"
            size="xs"
            icon="pencil"
            icon-only
            :label="t('viewHeader.editNamed', { name })"
            :disabled="heldByOther"
            data-view-rename
            @click="start"
          />
        </span>
      </UTooltip>
      <div class="ms-auto flex items-center gap-1">
        <DeleteResourceAction
          v-if="canDelete && view"
          kind="view"
          :resource-key="viewId"
          :name="name"
          @deleted="router.push('/')"
        />
        <LockBadge
          kind="view"
          :resource-key="viewId"
        />
      </div>
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
          <KitButton
            type="submit"
            variant="primary"
            size="sm"
            :label="saving ? t('common.saving') : t('common.save')"
            :loading="saving"
            :disabled="!!conflict || heldByOther"
            data-view-metadata-save
          />
          <KitButton
            variant="outline"
            size="sm"
            :label="t('common.cancel')"
            :disabled="saving"
            data-view-metadata-cancel
            @click="cancel"
          />
          <LockBadge
            kind="view"
            :resource-key="viewId"
          />
          <span
            v-if="heldByOther"
            class="text-sm text-muted"
            data-view-locked-hint
          >{{ t('viewHeader.lockedHint') }}</span>
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
