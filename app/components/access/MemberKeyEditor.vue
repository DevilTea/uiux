<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '#imports'
import type { DropdownMenuItem } from '@nuxt/ui'
import { isCatalogKey, isHumanOnlyKey, keyRequirements, type PermissionKey } from '../../../src/application/access/keys'
import { memberLabel, type LabelPreset } from '../../../src/application/access/labels'
import type { MemberKind } from '../../../src/application/access/principal'
import { applyPreset, catalogByDomain, toggleKey } from '../../utils/member-keys'
import { memberLabelText } from '../../utils/member-label'

/**
 * The Members page key checklist (Rules 01a11c09-ba80-7bef-96fe-4a4bae3ab528 and
 * 01a11c09-baec-71e2-b578-6efd9ee7ec98): the catalog grouped by domain, each key with its
 * identifier and description, a preset to start from, and the label the keys would get, updated as
 * they change. `humanOnly` keys are marked and disabled for an Agent; checking a key checks its
 * requirements. Keys this UIUX version does not know are listed apart, kept and granting nothing.
 *
 * The Access presets page edits a preset's keys with it too (`subject: 'preset'`, kind `human`): a
 * preset has no label of its own, and one holding an unknown key labels no member (Rule
 * 01a11c09-ca9b-7c86-9277-22b0397bee03). `readonly` shows the keys without letting them change.
 */
const keys = defineModel<string[]>('keys', { required: true })
const props = withDefaults(defineProps<{
	kind: MemberKind
	presets: readonly LabelPreset[]
	subject?: 'member' | 'preset'
	readonly?: boolean
}>(), { subject: 'member', readonly: false })
const { t } = useI18n()

const domains = catalogByDomain()
const messageId = (value: string) => value.replace(/[.-]/gu, '_')

const held = computed(() => new Set(keys.value))
const unknownKeys = computed(() => keys.value.filter(key => !isCatalogKey(key)))
const label = computed(() => memberLabelText(memberLabel({ kind: props.kind, keys: keys.value }, props.presets), t('access.label.custom')))
/** Rule 01a11c09-bb58-7164-873e-c7882ce448a5: granting `members.manage` grants the power to grant every key. */
const grantsManage = computed(() => held.value.has('members.manage'))

/** A checked key's requirements that are not checked: the server refuses the set (`access.key_requires`) until they are. */
function missingFor(key: PermissionKey): readonly PermissionKey[] {
	return held.value.has(key) ? keyRequirements(key).filter(requirement => !held.value.has(requirement)) : []
}

const disabledFor = (key: PermissionKey) => props.kind === 'agent' && isHumanOnlyKey(key)

function setKey(key: string, checked: boolean): void {
	keys.value = isCatalogKey(key) ? toggleKey(keys.value, key, checked, props.kind) : checked ? [...keys.value, key] : keys.value.filter(item => item !== key)
}

/** An unknown key once held stays listed after it is unchecked, so it can be checked again before saving. */
const unknownListed = ref<string[]>([])
watch(unknownKeys, (next) => {
	unknownListed.value = [...new Set([...unknownListed.value, ...next])]
}, { immediate: true })

const appliedNote = ref('')
watch(() => props.kind, () => { appliedNote.value = '' })

function startFrom(preset: LabelPreset): void {
	const applied = applyPreset(preset.keys, keys.value, props.kind)
	keys.value = applied.keys
	appliedNote.value = applied.dropped.length > 0
		? t('access.keys.appliedAgent', { preset: preset.name, keys: applied.dropped.join(', ') })
		: t('access.keys.applied', { preset: preset.name })
}

const presetItems = computed<DropdownMenuItem[]>(() => props.presets.map(preset => ({
	label: preset.name,
	onSelect: () => startFrom(preset),
})))
</script>

<template>
  <div
    class="space-y-4"
    data-key-editor
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="flex items-center gap-2 text-sm">
        <span
          v-if="subject === 'member'"
          class="text-muted"
        >{{ t('access.keys.resultingLabel') }}</span>
        <UBadge
          v-if="subject === 'member'"
          color="neutral"
          variant="soft"
          data-key-editor-label
        >
          {{ label }}
        </UBadge>
        <span
          class="text-xs text-muted"
          data-key-editor-count
        >{{ t('access.keys.count', { n: keys.length }, keys.length) }}</span>
      </p>
      <UDropdownMenu
        v-if="presets.length > 0 && !readonly"
        :items="presetItems"
        :content="{ align: 'end' }"
      >
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          trailing-icon="i-lucide-chevron-down"
          data-key-editor-preset
        >
          {{ t('access.keys.startFromPreset') }}
        </UButton>
      </UDropdownMenu>
    </div>

    <p
      class="text-xs text-muted"
      aria-live="polite"
      data-key-editor-applied
    >
      {{ appliedNote }}
    </p>

    <UAlert
      v-if="grantsManage"
      color="warning"
      variant="subtle"
      icon="i-lucide-shield-alert"
      :title="subject === 'preset' ? t('access.keys.manageWarningPresetTitle') : t('access.keys.manageWarningTitle')"
      :description="t('access.keys.manageWarning')"
      data-key-editor-manage-warning
    />

    <section
      v-for="group in domains"
      :key="group.domain"
      class="space-y-1"
      :data-key-domain="group.domain"
    >
      <h3 class="text-xs font-medium text-muted">
        {{ t(`access.keys.domain.${messageId(group.domain)}`) }}
      </h3>
      <ul class="divide-y divide-(--ui-border) rounded-md border border-default">
        <li
          v-for="key in group.keys"
          :key="key"
          class="px-2 py-1.5"
          :data-key="key"
        >
          <UCheckbox
            :model-value="held.has(key)"
            :disabled="readonly || disabledFor(key)"
            :ui="{ wrapper: 'min-w-0 flex-1' }"
            @update:model-value="(value: boolean | 'indeterminate') => setKey(key, value === true)"
          >
            <template #label>
              <span class="flex flex-wrap items-center gap-1.5">
                <code
                  class="font-mono text-xs text-highlighted"
                  translate="no"
                >{{ key }}</code>
                <UBadge
                  v-if="isHumanOnlyKey(key)"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  icon="i-lucide-user-round"
                  data-key-human-only
                >
                  {{ t('access.keys.humanOnly') }}
                </UBadge>
              </span>
            </template>
            <template #description>
              <span class="block text-xs text-muted">{{ t(`access.keys.description.${messageId(key)}`) }}</span>
              <span
                v-if="disabledFor(key)"
                class="block text-xs text-muted"
              >{{ t('access.keys.humanOnlyAgent') }}</span>
              <span
                v-if="missingFor(key).length > 0"
                class="flex items-center gap-1 text-xs text-warning"
                data-key-missing
              >
                <UIcon
                  name="i-lucide-triangle-alert"
                  class="size-3.5 shrink-0"
                />
                <i18n-t
                  keypath="access.keys.missing"
                  scope="global"
                  tag="span"
                >
                  <template #keys>
                    <code
                      class="font-mono"
                      translate="no"
                    >{{ missingFor(key).join(', ') }}</code>
                  </template>
                </i18n-t>
              </span>
            </template>
          </UCheckbox>
        </li>
      </ul>
    </section>

    <section
      v-if="unknownListed.length > 0"
      class="space-y-1"
      data-key-domain="unknown"
    >
      <h3 class="text-xs font-medium text-muted">
        {{ t('access.keys.unknownTitle') }}
      </h3>
      <p class="text-xs text-muted">
        {{ subject === 'preset' ? t('access.keys.unknownHelpPreset') : t('access.keys.unknownHelp') }}
      </p>
      <ul class="divide-y divide-(--ui-border) rounded-md border border-default">
        <li
          v-for="key in unknownListed"
          :key="key"
          class="px-2 py-1.5"
          :data-key="key"
        >
          <UCheckbox
            :model-value="held.has(key)"
            :disabled="readonly"
            @update:model-value="(value: boolean | 'indeterminate') => setKey(key, value === true)"
          >
            <template #label>
              <code
                class="font-mono text-xs text-highlighted"
                translate="no"
              >{{ key }}</code>
            </template>
          </UCheckbox>
        </li>
      </ul>
    </section>
  </div>
</template>
