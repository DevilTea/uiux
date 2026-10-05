<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from '#imports'
import { isCanonicalLocaleTag } from '../../../src/domain/validation'
import type { WorkspaceManifest } from '../../../src/domain/workspace/schema'
import type { Diagnostic } from '../../composables/workbench-types'
import type { SettingsSection } from '../../composables/useSettingsSection'
import AuthoringConflictAlert from './AuthoringConflictAlert.vue'
import AuthoringErrorAlert from './AuthoringErrorAlert.vue'
import AuthoringSaveBar from './AuthoringSaveBar.vue'

/** General: the primary Locale. Other `i18n` fields in the manifest ride along untouched. */
const props = defineProps<{
	section: SettingsSection<WorkspaceManifest['i18n']>
	canEdit: boolean
	locales: readonly string[]
	diagnostics: readonly Diagnostic[]
}>()
const emit = defineEmits<{ save: []; discard: []; reload: []; keepMine: [] }>()
const { t } = useI18n()

const showIssues = ref(false)
const tag = computed({
	get: () => props.section.draft?.defaultLocale ?? '',
	set: (value: string) => props.section.setDraft({ ...(props.section.draft ?? {}), defaultLocale: value.trim() }),
})

const items = computed(() => [...new Set([...props.locales, ...(tag.value ? [tag.value] : [])])].sort())
const tagError = computed(() => showIssues.value && !isCanonicalLocaleTag(tag.value) ? t('settings.locale.tagInvalid') : undefined)
const tagHasFile = computed(() => !tag.value || props.locales.includes(tag.value))
const sectionDiagnostics = computed(() => props.diagnostics.filter(item => item.path.startsWith('/i18n')))

function onCreate(value: string): void {
	tag.value = value
	showIssues.value = true
}

function save(): void {
	showIssues.value = true
	if (!isCanonicalLocaleTag(tag.value)) {
		document.querySelector<HTMLElement>('#settings-general [aria-invalid="true"], #settings-general button[role="combobox"]')?.focus()
		return
	}
	emit('save')
}

defineExpose({ save })
</script>

<template>
  <section
    id="settings-general"
    aria-labelledby="settings-general-title"
    class="flex scroll-mt-6 flex-col gap-4"
    data-settings-section
  >
    <header class="space-y-1">
      <h2
        id="settings-general-title"
        tabindex="-1"
        class="text-title font-semibold text-highlighted focus:outline-none"
      >
        {{ t('settings.general') }}
      </h2>
      <p class="text-sm text-muted">
        {{ t('settings.locale.description') }}
      </p>
    </header>

    <AuthoringConflictAlert
      v-if="section.conflict"
      :title="t('settings.conflict')"
      :theirs="section.theirs"
      :yours="section.draftPayload"
      @reload="emit('reload')"
      @keep-mine="emit('keepMine')"
    />
    <AuthoringErrorAlert
      v-else-if="section.error"
      :title="t('settings.saveFailed')"
      :error="section.error"
      @close="section.clearError()"
    />
    <UAlert
      v-for="diagnostic in sectionDiagnostics"
      :key="diagnostic.code + diagnostic.path"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="diagnostic.message"
      :description="diagnostic.path"
      :ui="{ description: 'font-mono text-xs' }"
    />

    <UFormField
      :label="t('settings.locale.primaryLocale')"
      :help="t('settings.locale.primaryLocaleHelp')"
      :error="tagError"
      name="defaultLocale"
    >
      <USelectMenu
        v-if="canEdit"
        v-model="tag"
        :items="items"
        create-item
        :search-input="{ placeholder: t('settings.locale.searchLocale') }"
        :aria-invalid="!!tagError || undefined"
        class="w-full max-w-xs"
        :ui="{ base: 'font-mono', item: 'font-mono' }"
        @create="onCreate"
      />
      <p
        v-else
        class="font-mono text-xs text-highlighted"
      >
        {{ tag }}
      </p>
    </UFormField>

    <p
      v-if="!tagHasFile"
      class="flex items-start gap-2 text-xs text-muted"
    >
      <UIcon
        name="i-lucide-triangle-alert"
        class="mt-0.5 size-3.5 shrink-0 text-warning"
      />
      <i18n-t
        keypath="settings.locale.noFile"
        scope="global"
        tag="span"
      >
        <template #locale>
          <code class="font-mono">{{ tag }}</code>
        </template>
        <template #link>
          <ULink
            to="/workspace/locales"
            class="text-default underline"
          >
            {{ t('nav.locales') }}
          </ULink>
        </template>
      </i18n-t>
    </p>

    <AuthoringSaveBar
      v-if="canEdit && section.dirty"
      :count="section.changeCount"
      :saving="section.saving"
      :disabled="section.conflict"
      @discard="emit('discard')"
      @save="save"
    />
  </section>
</template>
