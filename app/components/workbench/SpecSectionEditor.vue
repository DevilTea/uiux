<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useI18n } from '#imports'
import type { SelectItem } from '@nuxt/ui'
import type { SpecDraft, SpecEditor } from '../../composables/useSpecEditor'
import type { ReferenceDraft } from '../../utils/widget-inspection'
import LockedSaveAlert from './LockedSaveAlert.vue'

/**
 * The edit form for one Spec section (desktop only). Saves through `update_view_spec` with the
 * revision read when editing started; a conflict keeps the draft and offers a comparison.
 */
const props = defineProps<{
	editor: SpecEditor
	title: string
	viewItems: readonly SelectItem[]
	lang?: string
}>()

const { t } = useI18n()
const root = ref<HTMLElement>()
const { draft, saving, conflict, locked, heldByOther, theirs, invalid, fieldErrors } = props.editor

const typeItems = computed<SelectItem[]>(() => [
	{ label: t('spec.ref.external'), value: 'external' },
	{ label: t('spec.ref.view'), value: 'view' },
])

onMounted(async () => {
	await nextTick()
	root.value?.querySelector<HTMLElement>('textarea, input, button[role="combobox"]')?.focus()
})

function addItem(): void {
	const value = draft.value
	if (value && 'items' in value) {
		value.items.push('')
		void focusLast('textarea')
	}
}

function removeItem(index: number): void {
	const value = draft.value
	if (value && 'items' in value) value.items.splice(index, 1)
}

function addReference(): void {
	const value = draft.value
	if (value?.section !== 'references') return
	value.references.push({ type: 'external', uri: '', label: '', relation: '' })
	void focusLast('[data-reference-row]:last-child button[role="combobox"]')
}

function removeReference(index: number): void {
	const value = draft.value
	if (value?.section === 'references') value.references.splice(index, 1)
}

function setReferenceType(index: number, type: unknown): void {
	const value = draft.value
	if (value?.section !== 'references') return
	const current = value.references[index]
	if (!current || current.type === type) return
	const next: ReferenceDraft = type === 'view'
		? { type: 'view', viewId: '', variantName: '', relation: current.relation }
		: { type: 'external', uri: '', label: '', relation: current.relation }
	value.references.splice(index, 1, next)
}

async function focusLast(selector: string): Promise<void> {
	await nextTick()
	const all = root.value?.querySelectorAll<HTMLElement>(selector)
	all?.[all.length - 1]?.focus()
}

/** Plain-text rendering of a draft, for the side-by-side comparison. */
function describe(value: SpecDraft | undefined): string {
	if (!value) return ''
	if (value.section === 'intent') return value.intent
	if (value.section === 'references') {
		return value.references.map(reference => reference.type === 'view'
			? [reference.viewId, reference.variantName, reference.relation].filter(Boolean).join(' · ')
			: [reference.label, reference.uri, reference.relation].filter(Boolean).join(' · ')).join('\n')
	}
	return value.items.filter(item => item.trim()).map(item => `• ${item}`).join('\n')
}

function onKeydown(event: KeyboardEvent): void {
	if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
		event.preventDefault()
		void props.editor.save()
	}
	else if (event.key === 'Escape' && !event.defaultPrevented && !conflict.value) {
		event.preventDefault()
		props.editor.cancel()
	}
}

const conflictActions = computed(() => [
	{ label: conflict.value?.comparing ? t('spec.hideCompare') : t('spec.compare'), color: 'warning' as const, variant: 'outline' as const, size: 'sm' as const, icon: 'i-lucide-columns-2', onClick: () => props.editor.reviewTheirs() },
	{ label: t('spec.discardMine'), color: 'neutral' as const, variant: 'outline' as const, size: 'sm' as const, onClick: () => { void props.editor.discardMine() } },
])
</script>

<template>
  <div
    ref="root"
    class="grid gap-2"
    data-spec-editor
    @keydown="onKeydown"
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
      :title="t('spec.conflict')"
      :description="t('spec.conflictBody')"
      :actions="conflictActions"
      orientation="vertical"
      role="alert"
      data-spec-conflict
    />

    <div
      v-if="conflict?.comparing"
      class="grid gap-2"
      data-spec-compare
    >
      <div class="grid gap-1">
        <h4 class="text-xs font-medium text-muted">
          {{ t('spec.mine') }}
        </h4>
        <p
          class="rounded-md bg-muted px-2 py-1.5 text-sm whitespace-pre-wrap text-default"
          :lang="lang"
        >
          {{ describe(draft) }}
        </p>
      </div>
      <div class="grid gap-1">
        <h4 class="text-xs font-medium text-muted">
          {{ t('spec.theirs') }}
        </h4>
        <p
          v-if="theirs"
          class="rounded-md bg-muted px-2 py-1.5 text-sm whitespace-pre-wrap text-default"
          :lang="lang"
          data-spec-theirs
        >
          {{ describe(theirs) }}
        </p>
        <p
          v-else-if="conflict.latest === undefined"
          class="text-sm text-dimmed"
        >
          {{ t('spec.loadingTheirs') }}
        </p>
      </div>
      <div
        v-if="conflict.latest"
        class="flex flex-wrap items-center gap-2"
      >
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          icon="i-lucide-pencil"
          :label="t('spec.keepMine')"
          data-spec-keep-mine
          @click="editor.keepMine()"
        />
        <span class="text-xs text-muted">{{ t('spec.keepMineHint') }}</span>
      </div>
    </div>

    <UAlert
      v-if="invalid?.length"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="t('spec.invalidTitle')"
    >
      <template #description>
        <ul class="list-disc space-y-0.5 ps-4">
          <li
            v-for="(item, index) in invalid"
            :key="index"
          >
            <span
              v-if="item.path"
              class="font-mono"
              translate="no"
            >{{ item.path }}</span> {{ item.message }}
          </li>
        </ul>
      </template>
    </UAlert>

    <UForm
      v-if="draft"
      :state="draft"
      :disabled="saving"
      class="grid gap-2"
      @submit="editor.save()"
    >
      <UFormField
        v-if="draft.section === 'intent'"
        :label="title"
        :ui="{ label: 'sr-only' }"
      >
        <UTextarea
          v-model="draft.intent"
          autoresize
          :rows="3"
          :maxrows="12"
          class="w-full"
          :ui="{ base: 'text-body' }"
          :lang="lang"
        />
      </UFormField>

      <template v-else-if="draft.section === 'references'">
        <ol
          v-if="draft.references.length"
          class="grid gap-2"
        >
          <li
            v-for="(reference, index) in draft.references"
            :key="index"
            class="grid gap-1.5 border-b border-muted pb-2"
            data-reference-row
          >
            <div class="flex items-end gap-1.5">
              <UFormField
                :label="t('spec.ref.type')"
                class="w-28 shrink-0"
              >
                <USelect
                  :model-value="reference.type"
                  :items="typeItems"
                  class="w-full"
                  @update:model-value="setReferenceType(index, $event)"
                />
              </UFormField>
              <UFormField
                v-if="reference.type === 'external'"
                :label="t('spec.ref.uri')"
                :error="fieldErrors[`references.${index}.uri`]"
                class="min-w-0 flex-1"
              >
                <UInput
                  v-model="reference.uri"
                  type="url"
                  inputmode="url"
                  class="w-full font-mono"
                  translate="no"
                />
              </UFormField>
              <UFormField
                v-else
                :label="t('spec.ref.view')"
                :error="fieldErrors[`references.${index}.viewId`]"
                class="min-w-0 flex-1"
              >
                <USelect
                  v-model="reference.viewId"
                  :items="viewItems as SelectItem[]"
                  :placeholder="t('spec.ref.pickView')"
                  class="w-full"
                />
              </UFormField>
              <UTooltip :text="t('spec.ref.remove', { n: index + 1 })">
                <UButton
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-x"
                  :aria-label="t('spec.ref.remove', { n: index + 1 })"
                  @click="removeReference(index)"
                />
              </UTooltip>
            </div>
            <div class="grid grid-cols-2 gap-1.5">
              <UFormField
                v-if="reference.type === 'external'"
                :label="t('spec.ref.label')"
              >
                <UInput
                  v-model="reference.label"
                  class="w-full"
                  :lang="lang"
                />
              </UFormField>
              <UFormField
                v-else
                :label="t('spec.ref.variant')"
                :hint="t('spec.ref.variantHint')"
                :ui="{ hint: 'sr-only' }"
              >
                <UInput
                  v-model="reference.variantName"
                  class="w-full font-mono"
                  :placeholder="t('inspect.detail.baseState')"
                  translate="no"
                />
              </UFormField>
              <UFormField
                :label="t('spec.ref.relation')"
                :hint="t('spec.ref.relationHint')"
                :ui="{ hint: 'sr-only' }"
              >
                <UInput
                  v-model="reference.relation"
                  class="w-full"
                  placeholder="design"
                />
              </UFormField>
            </div>
          </li>
        </ol>
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-plus"
          class="justify-self-start"
          :label="t('spec.ref.add')"
          @click="addReference"
        />
      </template>

      <template v-else>
        <ol class="grid gap-1.5">
          <li
            v-for="(_, index) in draft.items"
            :key="index"
            class="flex items-start gap-1"
          >
            <UTextarea
              v-model="draft.items[index]"
              autoresize
              :rows="1"
              :maxrows="12"
              class="min-w-0 flex-1"
              :ui="{ base: 'text-body' }"
              :aria-label="t('spec.itemLabel', { n: index + 1 })"
              :lang="lang"
            />
            <UTooltip :text="t('spec.removeItem', { n: index + 1 })">
              <UButton
                color="neutral"
                variant="ghost"
                icon="i-lucide-x"
                :aria-label="t('spec.removeItem', { n: index + 1 })"
                @click="removeItem(index)"
              />
            </UTooltip>
          </li>
        </ol>
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-plus"
          class="justify-self-start"
          :label="t('spec.addItem')"
          @click="addItem"
        />
      </template>

      <div class="flex items-center justify-end gap-2 pt-1">
        <UTooltip
          :text="t('common.cancel')"
          :kbds="['escape']"
        >
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            :label="t('common.cancel')"
            :disabled="saving"
            data-spec-cancel
            @click="editor.cancel()"
          />
        </UTooltip>
        <UTooltip
          :text="t('common.save')"
          :kbds="['meta', 'enter']"
        >
          <UButton
            type="submit"
            color="primary"
            variant="solid"
            size="sm"
            :label="saving ? t('common.saving') : t('common.save')"
            :loading="saving"
            :disabled="!!conflict || heldByOther"
            data-spec-save
          />
        </UTooltip>
      </div>
    </UForm>
  </div>
</template>
