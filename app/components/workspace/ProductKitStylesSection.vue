<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from '#imports'
import KitBadge from '~/components/kit/ui/Badge.vue'
import KitButton from '~/components/kit/ui/Button.vue'
import type { ProductKit } from '../../../src/domain/product-kit/schema'
import type { SettingsSection } from '../../composables/useSettingsSection'
import {
	newStyleRow,
	newThemeAttributeRow,
	styleIssue,
	stylesThemesValid,
	themeAttributeIssues,
	type StyleIssue,
	type StylesThemesDraft,
	type ThemeAttributeIssue,
	type ThemeMapping,
} from '../../utils/product-kit-styles'
import AuthoringConflictAlert from './AuthoringConflictAlert.vue'
import AuthoringErrorAlert from './AuthoringErrorAlert.vue'
import AuthoringSaveBar from './AuthoringSaveBar.vue'

/**
 * The Styles & themes section of the Product Kit page (Rule 01a11bb1-b918-7cb5-b581-a3fd3f647f09):
 * the ordered `styles` (Clause 01a11bb1-8e98-7270-9662-682c048f9929) and the root attributes each
 * Workspace theme sets on the Preview document (`themes`, Clause 01a11bb1-8efc-77df-a0bb-78033bb35d56).
 * The page saves both through `update_product_kit` (`PUT /api/product-kit/settings`) with the
 * Product Kit file's revision; `canEdit` reflects `product-kit.write`, its edit lease and a
 * desktop-width window.
 *
 * A draft is checked with the validator's own rules first: a style is a portable specifier, and a
 * theme attribute name is `class` or a lowercase `data-*` name (Discussion #139,
 * https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18920581). Whether a `./` style
 * names a CSS file inside `kit/` (or, with a declared build, of its output) is the server's to say.
 */
const props = defineProps<{
	section: SettingsSection<StylesThemesDraft, ProductKit>
	canEdit: boolean
	/** The Workspace's theme registry, whose IDs `themes` maps. */
	workspaceThemes: readonly Readonly<{ id: string; label: string }>[]
}>()
const emit = defineEmits<{ save: []; discard: []; reload: []; keepMine: [] }>()
const { t } = useI18n()

const draft = computed<StylesThemesDraft>(() => props.section.draft ?? { styles: [], themes: [] })
/** Set by a save attempt: from then on, empty fields are named too. */
const showAll = ref(false)

function update(next: Partial<StylesThemesDraft>): void {
	props.section.setDraft({ ...draft.value, ...next })
}

// Styles.
function styleIssueText(issue: StyleIssue): string {
	return issue === 'required' ? t('productKit.styles.issue.required') : t('diagnostics.product_kit.invalid_style_specifier')
}
function shownStyleIssue(index: number): StyleIssue | undefined {
	const issue = styleIssue(draft.value.styles[index]!)
	return issue === 'required' && !showAll.value ? undefined : issue
}
function setStyle(index: number, specifier: string): void {
	update({ styles: draft.value.styles.map((row, at) => at === index ? { ...row, specifier } : row) })
}
function addStyle(): void {
	const row = newStyleRow()
	update({ styles: [...draft.value.styles, row] })
	void nextTick(() => document.querySelector<HTMLInputElement>(`[data-style-input="${row.uid}"]`)?.focus())
}
function removeStyle(index: number): void {
	update({ styles: draft.value.styles.filter((_, at) => at !== index) })
}
function moveStyle(index: number, to: number): void {
	const styles = [...draft.value.styles]
	const [row] = styles.splice(index, 1)
	styles.splice(to, 0, row!)
	update({ styles })
	void nextTick(() => document.querySelector<HTMLElement>(`[data-style-row="${row!.uid}"] [data-move="${to < index ? 'up' : 'down'}"]`)?.focus())
}

// Themes.
const themeLabels = computed(() => new Map(props.workspaceThemes.map(theme => [theme.id, theme.label])))
const unmapped = computed(() => props.workspaceThemes.filter(theme => !draft.value.themes.some(mapping => mapping.id === theme.id)))
const mapItems = computed(() => unmapped.value.map(theme => ({ label: theme.label ? `${theme.label} (${theme.id})` : theme.id, onSelect: () => mapTheme(theme.id) })))

function attributeIssueText(issue: ThemeAttributeIssue): string {
	switch (issue) {
		case 'required': return t('productKit.themes.issue.required')
		case 'duplicate': return t('productKit.themes.issue.duplicate')
		default: return t(`diagnostics.${issue}`)
	}
}
function shownAttributeIssue(theme: ThemeMapping, uid: string): ThemeAttributeIssue | undefined {
	const issue = themeAttributeIssues(theme).get(uid)
	return issue === 'required' && !showAll.value ? undefined : issue
}
function updateTheme(id: string, change: (theme: ThemeMapping) => ThemeMapping): void {
	update({ themes: draft.value.themes.map(theme => theme.id === id ? change(theme) : theme) })
}
function setAttribute(id: string, uid: string, field: 'name' | 'value', value: string): void {
	updateTheme(id, theme => ({ ...theme, attributes: theme.attributes.map(row => row.uid === uid ? { ...row, [field]: value } : row) }))
}
function addAttribute(id: string): void {
	const row = newThemeAttributeRow()
	updateTheme(id, theme => ({ ...theme, attributes: [...theme.attributes, row] }))
	void nextTick(() => document.querySelector<HTMLInputElement>(`[data-theme-attribute-name="${row.uid}"]`)?.focus())
}
function removeAttribute(id: string, uid: string): void {
	updateTheme(id, theme => ({ ...theme, attributes: theme.attributes.filter(row => row.uid !== uid) }))
}
function mapTheme(id: string): void {
	const row = newThemeAttributeRow('data-theme')
	update({ themes: [...draft.value.themes, { id, attributes: [row] }] })
	void nextTick(() => document.querySelector<HTMLInputElement>(`[data-theme-attribute-value="${row.uid}"]`)?.focus())
}
function unmapTheme(id: string): void {
	update({ themes: draft.value.themes.filter(theme => theme.id !== id) })
}

function save(): void {
	showAll.value = true
	if (!stylesThemesValid(draft.value)) {
		void nextTick(() => document.querySelector<HTMLElement>('#product-kit-styles [aria-invalid="true"]')?.focus())
		return
	}
	emit('save')
}
function discard(): void {
	showAll.value = false
	emit('discard')
}

defineExpose({ save })
</script>

<template>
  <section
    id="product-kit-styles"
    aria-labelledby="product-kit-styles-title"
    class="flex flex-col gap-6"
    data-product-kit-section="styles"
  >
    <header class="space-y-1">
      <h2
        id="product-kit-styles-title"
        tabindex="-1"
        class="text-title font-semibold text-highlighted focus:outline-none"
      >
        {{ t('productKit.styles.sectionTitle') }}
      </h2>
      <p class="text-sm text-muted">
        {{ t('productKit.styles.sectionDescription') }}
      </p>
    </header>

    <AuthoringConflictAlert
      v-if="section.conflict"
      :title="t('productKit.conflict')"
      :theirs="section.theirs"
      :yours="section.draftPayload"
      @reload="emit('reload')"
      @keep-mine="emit('keepMine')"
    />
    <AuthoringErrorAlert
      v-else-if="section.error"
      :title="t('productKit.saveFailed')"
      :error="section.error"
      @close="section.clearError()"
    />

    <!-- Styles -->
    <div
      class="flex flex-col gap-3"
      data-styles
    >
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0 space-y-1">
          <h3 class="text-sm font-semibold text-highlighted">
            {{ t('productKit.styles.title') }}
          </h3>
          <p
            id="product-kit-styles-help"
            class="text-xs text-muted"
          >
            {{ t('productKit.styles.help') }}
          </p>
        </div>
        <KitButton
          v-if="canEdit"
          variant="outline"
          size="sm"
          icon="plus"
          data-style-add
          @click="addStyle"
        >
          {{ t('productKit.styles.add') }}
        </KitButton>
      </div>
      <p
        v-if="!draft.styles.length"
        class="rounded-md border border-dashed border-default p-3 text-sm text-muted"
        data-styles-empty
      >
        {{ t('productKit.styles.empty') }}
      </p>
      <ol
        v-else
        class="flex flex-col gap-2"
      >
        <li
          v-for="(row, index) in draft.styles"
          :key="row.uid"
          class="flex flex-col gap-1"
          :data-style-row="row.uid"
        >
          <div class="flex items-center gap-2">
            <span class="w-5 shrink-0 text-end text-xs text-muted tabular-nums">{{ index + 1 }}</span>
            <template v-if="canEdit">
              <UInput
                :model-value="row.specifier"
                class="min-w-0 flex-1 font-mono"
                spellcheck="false"
                autocomplete="off"
                :placeholder="t('productKit.styles.placeholder')"
                :aria-label="t('productKit.styles.specifierLabel', { n: index + 1 })"
                aria-describedby="product-kit-styles-help"
                :aria-invalid="shownStyleIssue(index) ? 'true' : undefined"
                :color="shownStyleIssue(index) ? 'error' : undefined"
                :data-style-input="row.uid"
                @update:model-value="value => setStyle(index, String(value ?? ''))"
              />
              <KitButton
                variant="ghost"
                size="xs"
                icon="arrow-up"
                icon-only
                :label="t('productKit.styles.moveUp')"
                :disabled="index === 0"
                data-move="up"
                @click="moveStyle(index, index - 1)"
              />
              <KitButton
                variant="ghost"
                size="xs"
                icon="arrow-down"
                icon-only
                :label="t('productKit.styles.moveDown')"
                :disabled="index === draft.styles.length - 1"
                data-move="down"
                @click="moveStyle(index, index + 1)"
              />
              <KitButton
                variant="ghost"
                size="xs"
                icon="trash-2"
                icon-only
                :label="t('productKit.styles.remove')"
                @click="removeStyle(index)"
              />
            </template>
            <code
              v-else
              class="min-w-0 flex-1 font-mono text-xs break-all text-default"
              translate="no"
              data-style-value
            >{{ row.specifier }}</code>
          </div>
          <p
            v-if="canEdit && shownStyleIssue(index)"
            class="ms-7 text-xs text-error"
            :data-style-issue="shownStyleIssue(index)"
          >
            {{ styleIssueText(shownStyleIssue(index)!) }}
          </p>
        </li>
      </ol>
    </div>

    <USeparator />

    <!-- Themes -->
    <div
      class="flex flex-col gap-3"
      data-themes
    >
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0 space-y-1">
          <h3 class="text-sm font-semibold text-highlighted">
            {{ t('productKit.themes.title') }}
          </h3>
          <p
            id="product-kit-themes-help"
            class="text-xs text-muted"
          >
            {{ t('productKit.themes.help') }}
          </p>
        </div>
        <UDropdownMenu
          v-if="canEdit && mapItems.length"
          :items="mapItems"
        >
          <KitButton
            variant="outline"
            size="sm"
            icon="plus"
            trailing-icon="chevron-down"
            data-theme-map
          >
            {{ t('productKit.themes.map') }}
          </KitButton>
        </UDropdownMenu>
      </div>
      <p
        v-if="!draft.themes.length"
        class="rounded-md border border-dashed border-default p-3 text-sm text-muted"
        data-themes-empty
      >
        {{ workspaceThemes.length ? t('productKit.themes.empty') : t('productKit.themes.noWorkspaceThemes') }}
      </p>
      <div
        v-for="theme in draft.themes"
        :key="theme.id"
        class="flex flex-col gap-2 rounded-md border border-default p-3"
        :data-theme-mapping="theme.id"
      >
        <div class="flex items-center justify-between gap-3">
          <div class="flex min-w-0 items-baseline gap-2">
            <code
              class="font-mono text-sm font-medium text-highlighted"
              translate="no"
            >{{ theme.id }}</code>
            <span
              v-if="themeLabels.get(theme.id)"
              class="truncate text-xs text-muted"
            >{{ themeLabels.get(theme.id) }}</span>
            <KitBadge
              v-else
              tone="warning"
              data-theme-unknown
            >
              {{ t('productKit.themes.notWorkspaceTheme') }}
            </KitBadge>
          </div>
          <KitButton
            v-if="canEdit"
            variant="ghost"
            size="xs"
            icon="trash-2"
            icon-only
            :label="t('productKit.themes.unmap', { id: theme.id })"
            @click="unmapTheme(theme.id)"
          />
        </div>
        <p
          v-if="!theme.attributes.length"
          class="text-xs text-muted"
        >
          {{ t('productKit.themes.noAttributes') }}
        </p>
        <ul class="flex flex-col gap-2">
          <li
            v-for="row in theme.attributes"
            :key="row.uid"
            class="flex flex-col gap-1"
            :data-theme-attribute="row.uid"
          >
            <div
              v-if="canEdit"
              class="flex items-center gap-2"
            >
              <UInput
                :model-value="row.name"
                class="w-48 shrink-0 font-mono"
                spellcheck="false"
                autocomplete="off"
                :placeholder="t('productKit.themes.namePlaceholder')"
                :aria-label="t('productKit.themes.nameLabel', { id: theme.id })"
                aria-describedby="product-kit-themes-help"
                :aria-invalid="shownAttributeIssue(theme, row.uid) ? 'true' : undefined"
                :color="shownAttributeIssue(theme, row.uid) ? 'error' : undefined"
                :data-theme-attribute-name="row.uid"
                @update:model-value="value => setAttribute(theme.id, row.uid, 'name', String(value ?? ''))"
              />
              <UInput
                :model-value="row.value"
                class="min-w-0 flex-1 font-mono"
                spellcheck="false"
                autocomplete="off"
                :aria-label="t('productKit.themes.valueLabel', { id: theme.id, name: row.name })"
                :data-theme-attribute-value="row.uid"
                @update:model-value="value => setAttribute(theme.id, row.uid, 'value', String(value ?? ''))"
              />
              <KitButton
                variant="ghost"
                size="xs"
                icon="x"
                icon-only
                :label="t('productKit.themes.removeAttribute')"
                @click="removeAttribute(theme.id, row.uid)"
              />
            </div>
            <div
              v-else
              class="flex items-baseline gap-2 font-mono text-xs"
              translate="no"
            >
              <code class="text-highlighted">{{ row.name }}</code>
              <code class="break-all text-default">{{ row.value }}</code>
            </div>
            <p
              v-if="canEdit && shownAttributeIssue(theme, row.uid)"
              class="text-xs text-error"
              :data-theme-attribute-issue="shownAttributeIssue(theme, row.uid)"
            >
              {{ attributeIssueText(shownAttributeIssue(theme, row.uid)!) }}
            </p>
          </li>
        </ul>
        <div v-if="canEdit">
          <KitButton
            variant="ghost"
            size="xs"
            icon="plus"
            data-theme-attribute-add
            @click="addAttribute(theme.id)"
          >
            {{ t('productKit.themes.addAttribute') }}
          </KitButton>
        </div>
      </div>
    </div>

    <AuthoringSaveBar
      v-if="canEdit && section.dirty"
      :count="section.changeCount"
      :saving="section.saving"
      :disabled="section.conflict"
      @discard="discard"
      @save="save"
    />
  </section>
</template>
