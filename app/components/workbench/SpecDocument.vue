<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from '#imports'
import type { SelectItem } from '@nuxt/ui'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchShell } from '../../composables/useWorkbenchShell'
import { useWorkbenchFormat } from '../../composables/useWorkbenchFormat'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from '../../composables/useMediaQuery'
import { useSpecEditor } from '../../composables/useSpecEditor'
import type { DecisionRead, ReferenceRead } from '../../composables/workbench-types'
import { flattenWidgetTree } from '../../../src/preview/widget-tree'
import { viewLocation } from '../../utils/workbench-routes'
import { decisionChangedAt, decisionSourceThread, type SpecSectionKey } from '../../utils/widget-inspection'
import SpecMentionText from './SpecMentionText.vue'
import SpecSectionEditor from './SpecSectionEditor.vue'

/**
 * The Spec tab (brief e): the View's Spec as a document. Mono section markers, 14px prose at a
 * 68ch measure, hairlines between sections. Decisions and References are sections, not tabs.
 * Desktop edits one section at a time; tablet reads; mobile reads with §1 open and the rest folded.
 */
const emit = defineEmits<{ (e: 'openThread', threadId: string): void }>()

const { t } = useI18n()
const fmt = useWorkbenchFormat()
const workbench = useWorkbench()
const shell = useWorkbenchShell()
const { selectedView, views, isReadOnly, workspace, widgetTreeResult } = workbench
const editor = useSpecEditor(workbench)

const isDesktop = useMediaQuery(WORKBENCH_BREAKPOINTS.desktop)
const notMobile = useMediaQuery('(min-width: 768px)')
const isMobile = computed(() => !notMobile.value)
/** Editing is a desktop task; tablet is review-focused and mobile reads. */
const canEdit = computed(() => isDesktop.value && !isReadOnly.value)

const spec = computed(() => selectedView.value?.resource.spec)
const authoredLang = computed(() => workspace.value?.resource.i18n?.defaultLocale || undefined)
const widgetIds = computed<ReadonlySet<string>>(() => widgetTreeResult.value?.status === 'valid'
	? new Set(flattenWidgetTree(widgetTreeResult.value.root).map(node => node.id))
	: new Set())

type SectionKey = SpecSectionKey | 'decisions'
type Section = Readonly<{ key: SectionKey; marker: number; title: string; empty: string; count?: number; editable: boolean }>

const sections = computed<readonly Section[]>(() => {
	const value = spec.value
	return [
		{ key: 'intent', marker: 1, title: t('spec.intent'), empty: t('spec.empty.intent'), editable: true },
		{ key: 'entryConditions', marker: 2, title: t('spec.entry'), empty: t('spec.empty.entry'), count: value?.entryConditions.length, editable: true },
		{ key: 'interactionRules', marker: 3, title: t('spec.rules'), empty: t('spec.empty.rules'), count: value?.interactionRules.length, editable: true },
		{ key: 'constraints', marker: 4, title: t('spec.constraints'), empty: t('spec.empty.constraints'), count: value?.constraints.length, editable: true },
		{ key: 'accessibility', marker: 5, title: t('spec.a11y'), empty: t('spec.empty.a11y'), count: value?.accessibility.length, editable: true },
		// Decisions are recorded from Review threads; `update_view_spec` preserves them untouched.
		{ key: 'decisions', marker: 6, title: t('spec.decisions'), empty: t('spec.empty.decisions'), count: value?.decisions.length, editable: false },
		{ key: 'references', marker: 7, title: t('spec.refs'), empty: t('spec.empty.refs'), count: value?.references.length, editable: true },
	]
})

function listOf(key: SectionKey): readonly string[] {
	const value = spec.value
	if (!value) return []
	if (key === 'entryConditions' || key === 'interactionRules' || key === 'constraints' || key === 'accessibility') return value[key]
	return []
}

function isEmpty(key: SectionKey): boolean {
	const value = spec.value
	if (!value) return true
	if (key === 'intent') return !value.intent.trim()
	if (key === 'decisions') return !value.decisions.length
	if (key === 'references') return !value.references.length
	return !listOf(key).length
}

// Mobile folds every section but §1 (Intent); larger screens show the whole document.
const openOnMobile = ref<Set<SectionKey>>(new Set(['intent']))
watch(() => selectedView.value?.key, () => { openOnMobile.value = new Set(['intent']) })
function isOpen(key: SectionKey): boolean {
	return !isMobile.value || openOnMobile.value.has(key)
}
function toggle(key: SectionKey): void {
	const next = new Set(openOnMobile.value)
	if (next.has(key)) next.delete(key)
	else next.add(key)
	openOnMobile.value = next
}

const root = ref<HTMLElement>()

async function startEditing(key: SectionKey): Promise<void> {
	if (key === 'decisions' || !canEdit.value) return
	editor.start(key)
}

// Return focus to the section's edit control when its form closes.
watch(editor.editing, async (next, previous) => {
	if (next || !previous) return
	await nextTick()
	root.value?.querySelector<HTMLElement>(`[data-spec-section="${previous}"] [data-spec-edit]`)?.focus()
})

/** `E` edits the section that has focus (desktop, single-key shortcuts on). */
function onKeydown(event: KeyboardEvent): void {
	if (event.key.toLowerCase() !== 'e' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
	if (!canEdit.value || editor.editing.value || !shell.singleKeyShortcuts.value) return
	const target = event.target as HTMLElement | null
	if (!target || target.closest('input, textarea, select, [contenteditable="true"]')) return
	const key = target.closest<HTMLElement>('[data-spec-section]')?.dataset.specSection as SectionKey | undefined
	if (!key || key === 'decisions') return
	event.preventDefault()
	void startEditing(key)
}

function decisionColor(status: DecisionRead['status']): 'success' | 'warning' | 'neutral' {
	return status === 'decided' ? 'success' : status === 'pending' ? 'warning' : 'neutral'
}
function decisionIcon(status: DecisionRead['status']): string {
	return status === 'decided' ? 'i-lucide-check' : status === 'pending' ? 'i-lucide-clock' : 'i-lucide-pause'
}
function decisionLabel(status: DecisionRead['status']): string {
	return status === 'decided' ? t('decision.decided') : status === 'pending' ? t('decision.pending') : t('decision.deferred')
}

type ReferenceRow =
	| Readonly<{ kind: 'external'; key: string; uri: string; label: string; relation?: string }>
	| Readonly<{ kind: 'view'; key: string; to?: ReturnType<typeof viewLocation>; label?: string; variantName?: string; relation?: string }>

const referenceRows = computed<readonly ReferenceRow[]>(() => (spec.value?.references ?? []).map((reference, index) => {
	const record = reference as ReferenceRead & { viewId?: string; variantName?: string }
	const relation = record.relation || undefined
	if (record.type === 'view') {
		const summary = views.value.find(view => view.key === record.viewId)
		return {
			kind: 'view',
			key: `${index}`,
			...(summary ? { to: viewLocation(summary.key, { variant: record.variantName }), label: summary.summary.name || t('common.unnamed') } : {}),
			...(record.variantName ? { variantName: record.variantName } : {}),
			...(relation ? { relation } : {}),
		}
	}
	return { kind: 'external', key: `${index}`, uri: record.uri, label: record.label || record.uri, ...(relation ? { relation } : {}) }
}))

const viewItems = computed<SelectItem[]>(() => views.value.map(view => ({ label: view.summary.name || t('common.unnamed'), value: view.key })))

function isHttp(uri: string): boolean {
	return /^https?:\/\//i.test(uri)
}
</script>

<template>
  <article
    ref="root"
    class="flex min-h-0 flex-1 flex-col overflow-y-auto"
    :aria-label="t('spec.label')"
    data-spec-document
    @keydown="onKeydown"
  >
    <template v-if="selectedView && spec">
      <header class="flex items-center justify-between gap-2 border-b border-default px-3 py-2">
        <h2 class="min-w-0 truncate text-sm font-semibold text-highlighted">
          {{ t('spec.title', { name: selectedView.resource.name || t('common.unnamed') }) }}
        </h2>
        <span
          v-if="!isDesktop && !isMobile && !isReadOnly"
          class="shrink-0 text-xs text-dimmed"
          data-spec-edit-on-desktop
        >{{ t('common.editOnDesktop') }}</span>
      </header>

      <section
        v-for="section in sections"
        :key="section.key"
        class="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-1 gap-y-1.5 border-b border-default p-3"
        :aria-labelledby="`spec-heading-${section.key}`"
        :data-spec-section="section.key"
      >
        <span
          aria-hidden="true"
          class="pt-0.5 font-mono text-xs/5 text-dimmed"
          translate="no"
        >§{{ section.marker }}</span>
        <div class="flex min-w-0 items-start justify-between gap-2">
          <h3
            :id="`spec-heading-${section.key}`"
            class="min-w-0 text-title font-semibold text-highlighted"
          >
            <UButton
              v-if="isMobile"
              color="neutral"
              variant="link"
              class="min-h-(--wb-target) gap-2 p-0 text-start text-title font-semibold text-highlighted"
              :trailing-icon="isOpen(section.key) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
              :aria-expanded="isOpen(section.key)"
              :aria-controls="`spec-body-${section.key}`"
              @click="toggle(section.key)"
            >
              {{ section.title }}
              <UBadge
                v-if="section.count"
                color="neutral"
                variant="soft"
              >
                {{ section.count }}
              </UBadge>
            </UButton>
            <span
              v-else
              class="inline-flex items-center gap-2"
            >
              {{ section.title }}
              <UBadge
                v-if="section.count"
                color="neutral"
                variant="soft"
              >
                {{ section.count }}
              </UBadge>
            </span>
          </h3>
          <UTooltip
            v-if="canEdit && section.editable && editor.editing.value !== section.key && !isEmpty(section.key)"
            :text="t('spec.editSection', { section: section.title })"
            :kbds="['e']"
          >
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              icon="i-lucide-pencil"
              :aria-label="t('spec.editSection', { section: section.title })"
              :disabled="!!editor.editing.value"
              data-spec-edit
              @click="startEditing(section.key)"
            />
          </UTooltip>
        </div>

        <div
          v-show="isOpen(section.key)"
          :id="`spec-body-${section.key}`"
          class="col-start-2 min-w-0 max-w-[68ch] text-body text-default"
        >
          <SpecSectionEditor
            v-if="canEdit && editor.editing.value === section.key"
            :editor="editor"
            :title="section.title"
            :view-items="viewItems"
            :lang="authoredLang"
          />

          <!-- Nothing authored yet: a dashed placeholder (DESIGN.md Shapes), Add on desktop. -->
          <div
            v-else-if="isEmpty(section.key)"
            class="flex items-center justify-between gap-2 rounded-md border border-dashed border-accented px-2.5 py-1.5 text-sm text-muted"
            data-spec-empty
          >
            <span>{{ section.empty }}</span>
            <UButton
              v-if="canEdit && section.editable"
              color="neutral"
              variant="ghost"
              size="sm"
              icon="i-lucide-plus"
              :label="t('common.add')"
              :aria-label="t('spec.addSection', { section: section.title })"
              :disabled="!!editor.editing.value"
              data-spec-edit
              @click="startEditing(section.key)"
            />
          </div>

          <p
            v-else-if="section.key === 'intent'"
            :lang="authoredLang"
          >
            <SpecMentionText
              :text="spec.intent"
              :widget-ids="widgetIds"
              @select="workbench.selectWidget"
            />
          </p>

          <ul
            v-else-if="section.key === 'decisions'"
            class="grid gap-3"
          >
            <li
              v-for="decision in spec.decisions"
              :key="decision.id"
              class="grid gap-1"
              data-spec-decision
            >
              <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <UBadge
                  :color="decisionColor(decision.status)"
                  :icon="decisionIcon(decision.status)"
                  variant="subtle"
                  class="self-center"
                >
                  {{ decisionLabel(decision.status) }}
                </UBadge>
                <span
                  class="min-w-0 font-medium text-highlighted"
                  :lang="authoredLang"
                >{{ decision.question }}</span>
              </div>
              <p
                v-if="decision.outcome?.summary"
                :lang="authoredLang"
              >
                <span class="sr-only">{{ `${t('spec.outcome')} ` }}</span>{{ decision.outcome.summary }}
              </p>
              <p
                v-if="decision.outcome?.rationale"
                class="text-sm text-muted"
                :lang="authoredLang"
              >
                <span class="sr-only">{{ `${t('spec.rationale')} ` }}</span>{{ decision.outcome.rationale }}
              </p>
              <p class="flex flex-wrap items-center gap-x-2 text-xs text-dimmed">
                <time
                  v-if="decisionChangedAt(decision)"
                  :datetime="decisionChangedAt(decision)"
                >{{ fmt.date(decisionChangedAt(decision)) }}</time>
                <ULink
                  v-if="decisionSourceThread(decision)"
                  as="button"
                  type="button"
                  class="inline-flex items-center gap-0.5 rounded-sm text-xs text-muted hover:text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  data-spec-decision-source
                  @click="emit('openThread', decisionSourceThread(decision)!)"
                >
                  {{ t('spec.fromReview') }}
                  <UIcon
                    name="i-lucide-chevron-right"
                    class="size-3.5 rtl:rotate-180"
                  />
                </ULink>
              </p>
            </li>
          </ul>

          <ul
            v-else-if="section.key === 'references'"
            class="grid gap-1.5"
          >
            <li
              v-for="reference in referenceRows"
              :key="reference.key"
              class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5"
            >
              <template v-if="reference.kind === 'external'">
                <UIcon
                  name="i-lucide-external-link"
                  class="size-3.5 shrink-0 text-dimmed"
                />
                <ULink
                  v-if="isHttp(reference.uri)"
                  :to="reference.uri"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="min-w-0 truncate text-default underline decoration-(--ui-border-accented) underline-offset-2 hover:decoration-current"
                  :title="reference.uri"
                >
                  <span :lang="authoredLang">{{ reference.label }}</span>
                  <span class="sr-only">{{ ` ${t('spec.opensInNewTab')}` }}</span>
                </ULink>
                <span
                  v-else
                  class="min-w-0 truncate font-mono text-sm"
                  translate="no"
                >{{ reference.label }}</span>
              </template>
              <template v-else>
                <UIcon
                  name="i-lucide-app-window"
                  class="size-3.5 shrink-0 text-dimmed"
                />
                <ULink
                  v-if="reference.to"
                  :to="reference.to"
                  class="min-w-0 truncate text-default underline decoration-(--ui-border-accented) underline-offset-2 hover:decoration-current"
                >
                  {{ reference.label }}
                </ULink>
                <span
                  v-else
                  class="text-sm text-muted"
                >{{ t('spec.ref.viewMissing') }}</span>
                <UBadge
                  v-if="reference.variantName"
                  color="neutral"
                  variant="soft"
                  class="font-mono"
                  translate="no"
                >
                  {{ reference.variantName }}
                </UBadge>
              </template>
              <UBadge
                v-if="reference.relation"
                color="neutral"
                variant="soft"
              >
                {{ reference.relation }}
              </UBadge>
            </li>
          </ul>

          <ul
            v-else
            class="grid list-disc gap-1 ps-4 marker:text-dimmed"
            :lang="authoredLang"
          >
            <li
              v-for="(item, index) in listOf(section.key)"
              :key="index"
            >
              <SpecMentionText
                :text="item"
                :widget-ids="widgetIds"
                @select="workbench.selectWidget"
              />
            </li>
          </ul>
        </div>
      </section>
    </template>

    <UEmpty
      v-else
      size="sm"
      variant="naked"
      icon="i-lucide-file-text"
      :title="t('spec.noView')"
      class="flex-1"
    />
  </article>
</template>
