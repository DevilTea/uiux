<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { NavigationMenuItem } from '@nuxt/ui'
import { useI18n, useRoute, useRouter } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { useWorkbenchFeedback } from '../../composables/useWorkbenchFeedback'
import { useAuthoringAccess } from '../../composables/useAuthoringAccess'
import { useUnsavedGuard } from '../../composables/useUnsavedGuard'
import { createSettingsSection } from '../../composables/useSettingsSection'
import { describeFetchError, isLockedError, type FetchErrorLock } from '../../utils/fetch-error'
import {
	adapterRows,
	adapterSelections,
	buildSettingsPayload,
	cloneJson,
	registryRecord,
	registryRows,
	SETTINGS_SECTIONS,
	type SettingsSectionId,
} from '../../utils/workspace-authoring'
import WorkbenchPage from '../workbench/WorkbenchPage.vue'
import WorkspaceSubnav from './WorkspaceSubnav.vue'
import AuthoringAccessNotice from './AuthoringAccessNotice.vue'
import LockBadge from '../workbench/LockBadge.vue'
import LockedSaveAlert from '../workbench/LockedSaveAlert.vue'
import UnsavedLeaveModal from './UnsavedLeaveModal.vue'
import SettingsGeneralSection from './SettingsGeneralSection.vue'
import SettingsRegistrySection from './SettingsRegistrySection.vue'
import SettingsAdaptersSection, { type AdapterResolution } from './SettingsAdaptersSection.vue'
import { focusFirstProblem } from '../../utils/focus-problem'

/**
 * Workspace settings as a full page (brief g): a section index, then one form column with
 * General, Viewports, Themes and Adapters separated by hairlines. Each section saves on its
 * own through `update_workspace_settings` (`PUT /api/workspace/settings`, a full replace)
 * with its own `expectedRevision`, so a concurrent write surfaces as a conflict, never as
 * a silent overwrite.
 *
 * `?section=<id>` opens the page at that section; `/workspace/adapters` redirects here with
 * `section=adapters`.
 */
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
/** The section named by `?section=`, if it is one. */
const requestedSection = computed<SettingsSectionId | undefined>(() => {
	const value = route.query.section
	return typeof value === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(value) ? value as SettingsSectionId : undefined
})
const workbench = useWorkbench()
const { workspace, discoveredLocales } = workbench
const uiux = useUiuxClient()
const feedback = useWorkbenchFeedback()
// The Workspace settings document is one lockable resource (accepted identity decision 11).
const { access, canEdit } = useAuthoringAccess({ kind: 'workspace', key: 'workspace' })
/** A save refused by someone else's edit lease; every section's draft is kept. */
const lockRefusal = shallowRef<Readonly<{ lock?: FetchErrorLock }>>()

const general = createSettingsSection({
	id: 'general',
	fromManifest: manifest => cloneJson(manifest.i18n ?? { defaultLocale: 'en-US' }),
	toPayload: draft => draft,
})
const viewports = createSettingsSection({
	id: 'viewports',
	fromManifest: manifest => registryRows(manifest.viewports, 'viewports'),
	toPayload: draft => registryRecord(draft, 'viewports'),
})
const themes = createSettingsSection({
	id: 'themes',
	fromManifest: manifest => registryRows(manifest.themes, 'themes'),
	toPayload: draft => registryRecord(draft, 'themes'),
})
const adapters = createSettingsSection({
	id: 'adapters',
	fromManifest: manifest => adapterRows(manifest.adapters),
	toPayload: draft => adapterSelections(draft),
})
const sections = { general, viewports, themes, adapters } as const

watch(workspace, (read) => {
	for (const section of Object.values(sections)) section.sync(read)
}, { immediate: true })

const dirtyCount = computed(() => Object.values(sections).reduce((sum, section) => sum + section.changeCount, 0))
const guard = useUnsavedGuard(() => dirtyCount.value > 0)

// Adapter package state, read-only (Part 8 10b).
const resolution = shallowRef<AdapterResolution>()
const resolutionFailed = ref(false)
async function loadResolution(): Promise<void> {
	resolutionFailed.value = false
	try { resolution.value = await uiux.previewAdapters() as AdapterResolution }
	catch { resolutionFailed.value = true }
}

// Reference impact for registry key changes: Evidence captured with a key.
let evidence: Promise<readonly { record?: { executionContext?: Record<string, unknown> } }[]> | undefined
function countEvidence(field: 'viewportId' | 'themeId') {
	return async (key: string): Promise<number> => {
		evidence ??= uiux.listEvidence<{ record?: { executionContext?: Record<string, unknown> } }>().catch((cause) => {
			evidence = undefined
			throw cause
		})
		const items = await evidence
		return items.filter(item => item.record?.executionContext?.[field] === key).length
	}
}

async function save(id: SettingsSectionId): Promise<void> {
	const section = sections[id]
	const read = workspace.value
	if (!canEdit.value || !read?.resource || !section.base || section.conflict || section.saving || !section.dirty) return
	section.saving = true
	section.clearError()
	lockRefusal.value = undefined
	try {
		await $fetch('/api/workspace/settings', {
			method: 'PUT',
			body: {
				expectedRevision: section.base.revision,
				settings: buildSettingsPayload(read.resource, id, section.draftPayload),
			},
		})
		feedback.success(t('settings.saved'))
		evidence = undefined
		await workbench.refreshAll()
		if (id === 'adapters') void loadResolution()
	}
	catch (cause) {
		const details = describeFetchError(cause, t('settings.saveFailed'))
		if (details.statusCode === 409 || details.status === 'conflict') {
			section.conflict = true
			await workbench.refreshAll()
			void focusFirstProblem(`#settings-${id}`)
		}
		else if (isLockedError(details)) {
			lockRefusal.value = { lock: details.lock }
			void focusFirstProblem('main')
		}
		else {
			section.error = details
			void focusFirstProblem(`#settings-${id}`)
		}
	}
	finally {
		section.saving = false
	}
}

function discard(id: SettingsSectionId): void {
	if (workspace.value) sections[id].adopt(workspace.value)
}

async function reloadTheirs(id: SettingsSectionId): Promise<void> {
	await workbench.refreshAll()
	if (workspace.value) sections[id].adopt(workspace.value)
}

function keepMine(id: SettingsSectionId): void {
	sections[id].keepMine(workspace.value)
}

// Section index with scroll-spy.
const active = ref<SettingsSectionId>(requestedSection.value ?? 'general')
const scroller = ref<HTMLElement>()
const sectionRefs = {
	general: ref<InstanceType<typeof SettingsGeneralSection>>(),
	viewports: ref<InstanceType<typeof SettingsRegistrySection>>(),
	themes: ref<InstanceType<typeof SettingsRegistrySection>>(),
	adapters: ref<InstanceType<typeof SettingsAdaptersSection>>(),
}

/** Scrolls only the page's own scroller; `scrollIntoView` would also move the shell around it. */
function reveal(id: SettingsSectionId, smooth: boolean): void {
	const target = document.getElementById(`settings-${id}`)
	const container = scroller.value
	if (!target || !container) return
	const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 24
	const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
	container.scrollTo({ top: Math.max(0, top), behavior: smooth && !reduced ? 'smooth' : 'auto' })
}

function scrollTo(id: SettingsSectionId): void {
	active.value = id
	reveal(id, true)
	document.getElementById(`settings-${id}`)?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
}

const invalidAdapters = computed(() => resolution.value?.state === 'invalid')
const index = computed<NavigationMenuItem[]>(() => (['general', 'viewports', 'themes', 'adapters'] as const).map(id => ({
	label: t(`settings.${id}`),
	active: active.value === id,
	onSelect: (event: Event) => { event.preventDefault(); scrollTo(id) },
	...(id === 'adapters' && invalidAdapters.value
		? { trailingIcon: 'i-lucide-triangle-alert', ui: { linkTrailingIcon: 'text-error' } }
		: sections[id].dirty
			? { badge: { label: t('authoring.unsavedShort'), color: 'neutral' as const, variant: 'soft' as const, size: 'sm' as const } }
			: {}),
})))

const ORDER: readonly SettingsSectionId[] = ['general', 'viewports', 'themes', 'adapters']
let spyFrame = 0
/** Scroll-spy: the last section whose heading passed the top third, or the last one at the end. */
function updateActive(): void {
	spyFrame = 0
	const container = scroller.value
	if (!container) return
	if (container.scrollTop > 0 && container.scrollTop + container.clientHeight >= container.scrollHeight - 4) {
		active.value = ORDER[ORDER.length - 1]!
		return
	}
	const threshold = container.getBoundingClientRect().top + container.clientHeight / 3
	let current: SettingsSectionId = ORDER[0]!
	for (const id of ORDER) {
		const element = document.getElementById(`settings-${id}`)
		if (element && element.getBoundingClientRect().top <= threshold) current = id
	}
	active.value = current
}
function onScroll(): void {
	if (!spyFrame) spyFrame = requestAnimationFrame(updateActive)
}

let stopAfterEach: (() => void) | undefined
/** Once the sections exist, jump to the requested section. */
async function onSectionsRendered(): Promise<void> {
	await nextTick()
	const section = requestedSection.value
	if (section && section !== 'general')
		reveal(section, false)
}
onMounted(() => {
	void loadResolution()
	window.addEventListener('keydown', onKeydown)
	scroller.value?.addEventListener('scroll', onScroll, { passive: true })
	let started = false
	watch(() => !!workspace.value?.resource, (ready) => {
		if (!ready || started) return
		started = true
		void onSectionsRendered()
	}, { immediate: true })
	// Asked for another section while already here (⌘K "Adapters", a canvas link).
	watch(requestedSection, (section) => {
		if (section && started) scrollTo(section)
	})
	// Asked for the section the URL already names (`?section=adapters`, then scrolled back to
	// General, then ⌘K "Adapters"): the router refuses a duplicate navigation, so the query does
	// not change and the watcher above never fires. Every failed navigation still reaches
	// `afterEach`; one that stays on this page re-reveals the requested section.
	stopAfterEach = router.afterEach((to, _from, failure) => {
		const section = requestedSection.value
		if (failure && started && section && to.path === route.path && to.query.section === section) scrollTo(section)
	})
})
onBeforeUnmount(() => {
	stopAfterEach?.()
	if (spyFrame) cancelAnimationFrame(spyFrame)
	scroller.value?.removeEventListener('scroll', onScroll)
	window.removeEventListener('keydown', onKeydown)
})

/** ⌘S / Ctrl+S saves the section holding focus, or the only section with a draft. */
function onKeydown(event: KeyboardEvent): void {
	if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's' || event.shiftKey || event.altKey) return
	event.preventDefault()
	if (!canEdit.value) return
	const focused = (document.activeElement?.closest('[data-settings-section]')?.id ?? '').replace('settings-', '') as SettingsSectionId
	const dirty = Object.values(sections).filter(section => section.dirty)
	const id = focused && sections[focused]?.dirty ? focused : dirty.length === 1 ? dirty[0]!.id : undefined
	if (id) sectionRefs[id].value?.save()
}

const viewportDiagnostics = computed(() => workspace.value?.diagnostics ?? [])
</script>

<template>
  <WorkbenchPage
    id="workspace-settings"
    :title="t('settings.title')"
  >
    <template #toolbar>
      <WorkspaceSubnav />
    </template>
    <div
      ref="scroller"
      class="flex min-h-0 flex-1 overflow-y-auto focus-visible:outline-offset-[-2px]"
      tabindex="0"
      role="region"
      :aria-label="t('settings.title')"
    >
      <!-- self-start: as a stretched flex item this row would be only one screen tall, and the sticky
           section index would scroll away with it. -->
      <div class="mx-auto flex w-full max-w-5xl self-start gap-10 px-4 pt-6 pb-16 sm:px-6">
        <nav
          class="hidden w-44 shrink-0 lg:block"
          :aria-label="t('settings.sectionIndex')"
        >
          <div class="sticky top-0">
            <UNavigationMenu
              :items="index"
              orientation="vertical"
              color="neutral"
            />
          </div>
        </nav>

        <div class="flex max-w-180 min-w-0 flex-1 flex-col gap-8">
          <header class="flex flex-col gap-2">
            <h1 class="text-headline font-semibold text-highlighted">
              {{ t('settings.title') }}
            </h1>
            <i18n-t
              keypath="settings.subtitle"
              tag="p"
              scope="global"
              class="text-sm text-muted"
            >
              <template #file>
                <code class="font-mono text-xs">.uiux/workspace.json</code>
              </template>
            </i18n-t>
            <AuthoringAccessNotice :access="access" />
            <LockBadge
              kind="workspace"
              resource-key="workspace"
            />
            <LockedSaveAlert
              v-if="lockRefusal"
              :lock="lockRefusal.lock"
              @dismiss="lockRefusal = undefined"
            />
          </header>

          <template v-if="workspace?.resource">
            <SettingsGeneralSection
              :ref="(el) => { sectionRefs.general.value = el as InstanceType<typeof SettingsGeneralSection> }"
              :section="general"
              :can-edit="canEdit"
              :locales="discoveredLocales"
              :diagnostics="viewportDiagnostics"
              @save="save('general')"
              @discard="discard('general')"
              @reload="reloadTheirs('general')"
              @keep-mine="keepMine('general')"
            />
            <USeparator />
            <SettingsRegistrySection
              :ref="(el) => { sectionRefs.viewports.value = el as InstanceType<typeof SettingsRegistrySection> }"
              kind="viewports"
              :section="viewports"
              :can-edit="canEdit"
              :diagnostics="viewportDiagnostics"
              :count-evidence="countEvidence('viewportId')"
              @save="save('viewports')"
              @discard="discard('viewports')"
              @reload="reloadTheirs('viewports')"
              @keep-mine="keepMine('viewports')"
            />
            <USeparator />
            <SettingsRegistrySection
              :ref="(el) => { sectionRefs.themes.value = el as InstanceType<typeof SettingsRegistrySection> }"
              kind="themes"
              :section="themes"
              :can-edit="canEdit"
              :diagnostics="viewportDiagnostics"
              :count-evidence="countEvidence('themeId')"
              @save="save('themes')"
              @discard="discard('themes')"
              @reload="reloadTheirs('themes')"
              @keep-mine="keepMine('themes')"
            />
            <USeparator />
            <!-- The last section is at least a screen tall, so ?section=adapters can scroll it to the top. -->
            <div class="min-h-[calc(100dvh-var(--ui-header-height)-8rem)]">
              <SettingsAdaptersSection
                :ref="(el) => { sectionRefs.adapters.value = el as InstanceType<typeof SettingsAdaptersSection> }"
                :section="adapters"
                :can-edit="canEdit"
                :resolution="resolution"
                :resolution-failed="resolutionFailed"
                @save="save('adapters')"
                @discard="discard('adapters')"
                @reload="reloadTheirs('adapters')"
                @keep-mine="keepMine('adapters')"
                @retry-resolution="loadResolution"
              />
            </div>
          </template>
          <div
            v-else
            class="flex flex-col gap-3"
            aria-hidden="true"
          >
            <USkeleton
              class="h-5 w-40"
              :aria-label="t('common.loading')"
            />
            <USkeleton
              class="h-8 w-full"
              :aria-label="t('common.loading')"
            />
            <USkeleton
              class="h-8 w-full"
              :aria-label="t('common.loading')"
            />
            <USkeleton
              class="h-8 w-2/3"
              :aria-label="t('common.loading')"
            />
          </div>
        </div>
      </div>
    </div>

    <UnsavedLeaveModal
      v-model:open="guard.open.value"
      :count="dirtyCount"
      @leave="guard.leave"
      @stay="guard.stay"
    />
  </WorkbenchPage>
</template>
