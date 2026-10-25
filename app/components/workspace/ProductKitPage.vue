<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n, useRoute, useRouter } from '#imports'
import { useAccess } from '../../composables/useAccess'
import { useWorkbench } from '../../composables/useWorkbench'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { useWorkbenchFeedback } from '../../composables/useWorkbenchFeedback'
import { useAuthoringAccess } from '../../composables/useAuthoringAccess'
import { useUnsavedGuard } from '../../composables/useUnsavedGuard'
import { useKitBuild } from '../../composables/useKitBuild'
import { touchesKinds, useLiveEvents } from '../../composables/useLiveEvents'
import { createSettingsSection } from '../../composables/useSettingsSection'
import { describeFetchError, isLockedError, type FetchErrorLock } from '../../utils/fetch-error'
import { adapterRows, adapterSelections, productKitAdapterWrites, type AdapterRow } from '../../utils/workspace-authoring'
import { parseProductKitSection, PRODUCT_KIT_PATH, PRODUCT_KIT_SECTIONS, productKitSectionLocation, type ProductKitSectionId } from '../../utils/workbench-routes'
import { stylesThemesDraft, stylesThemesPayload, type StylesThemesDraft, type StylesThemesPayload } from '../../utils/product-kit-styles'
import { diagnosticText } from '../../utils/diagnostic-copy'
import { focusFirstProblem } from '../../utils/focus-problem'
import WorkbenchPage from '../workbench/WorkbenchPage.vue'
import LockBadge from '../workbench/LockBadge.vue'
import LockedSaveAlert from '../workbench/LockedSaveAlert.vue'
import WorkspaceSubnav from './WorkspaceSubnav.vue'
import AuthoringAccessNotice from './AuthoringAccessNotice.vue'
import UnsavedLeaveModal from './UnsavedLeaveModal.vue'
import ProductKitPackagesSection from './ProductKitPackagesSection.vue'
import ProductKitBuildSection from './ProductKitBuildSection.vue'
import ProductKitAdaptersSection, { type AdapterResolution } from './ProductKitAdaptersSection.vue'
import ProductKitComponentsSection from './ProductKitComponentsSection.vue'
import ProductKitStylesSection from './ProductKitStylesSection.vue'
import ProductKitFilesSection from './ProductKitFilesSection.vue'
import { PRODUCT_KIT_FILENAME, type ProductKit } from '../../../src/domain/product-kit/schema'
import type { WorkspaceAdapterSelection } from '../../../src/domain/workspace/schema'
import type { ProductKitRead } from '../../../src/application/services/product-kit-authoring'
import type { Diagnostic } from '../../composables/workbench-types'

/**
 * The Product Kit page, `/workspace/product-kit` (Clause 01a11be8-5cab-7e50-89fe-b89c243d773d), with
 * its sections (Rule 01a11bb1-b918-7cb5-b581-a3fd3f647f09) one at a time, chosen by `?section=` from
 * the section navigation; no value or an unknown one shows Overview, the page's top:
 * - Overview: the Design System packages, the kit build with its log, and the Adapters (Rules
 *   01a116f0-8a46-76bc-a29f-affaa302c44c and 01a115cd-af57-781e-9493-89d037e41b06), which moved here
 *   from Workspace settings;
 * - Components: the component registry, the component table, browsing a component and its copy commands;
 * - Styles & themes: `styles` and `themes`, saved through `update_product_kit`;
 * - Files: the kit project's files and build output, read-only (Rule 01a11bb1-a184-7e00-a8de-c81056ad5a35).
 * Drafts live on the page, so switching sections keeps them.
 *
 * Reading needs `workspace.read`; the build log, a component's source and the Files section need
 * `product-kit.source.read`. Styles & themes save with `PUT /api/product-kit/settings`, the Product
 * Kit file's revision, `product-kit.write` and its edit lease. The Adapters save through
 * the Product Kit operations (`PUT /api/product-kit/compose` for the specifiers and their order,
 * then `PUT /api/product-kit/settings` for their `config`) with the Product Kit file's revision,
 * `product-kit.write` and its edit lease, and `product-kit.compose` gates the selection itself
 * (Discussion #139 owner ruling 6, https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18851627).
 * The server enforces every key; the page only reflects them.
 *
 * The build reads its own endpoint, so it and its restart stay available when the Product Kit file
 * cannot be read.
 */
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const workbench = useWorkbench()
const { workspace } = workbench
const uiux = useUiuxClient()
const feedback = useWorkbenchFeedback()
const member = useAccess()
const kitBuild = useKitBuild()

const requestedSection = computed(() => parseProductKitSection(route.query))
/** The section shown: the requested one, else Overview. */
const currentSection = computed<ProductKitSectionId>(() => requestedSection.value ?? 'overview')
const SECTION_LABEL: Record<ProductKitSectionId, string> = {
	overview: 'productKit.overview',
	components: 'productKit.components.title',
	styles: 'productKit.styles.sectionTitle',
	files: 'productKit.files.title',
}
const sectionLinks = computed(() => PRODUCT_KIT_SECTIONS.map((id) => {
	const location = productKitSectionLocation(id)
	return { id, label: t(SECTION_LABEL[id]), location, href: router.resolve(location).href }
}))
function openSection(event: MouseEvent, location: ReturnType<typeof productKitSectionLocation>): void {
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
	event.preventDefault()
	void router.push(location)
}
const { access, writeKey, canEdit } = useAuthoringAccess('product-kit.write', { kind: 'product-kit', key: 'product-kit' })
/** The build restart follows the same access as the page's writes, except the edit lease: it writes no file. */
const { canEdit: canRestart } = useAuthoringAccess('product-kit.write')
/** A save refused by someone else's edit lease; the draft is kept. */
const lockRefusal = shallowRef<Readonly<{ lock?: FetchErrorLock }>>()

// Untyped request helper: Nitro's typed-route inference overflows on this many routes.
const api = $fetch as unknown as <T = unknown>(url: string, options?: Readonly<Record<string, unknown>>) => Promise<T>

const productKit = shallowRef<ProductKitRead>()
const productKitFailed = ref(false)
async function loadProductKit(): Promise<void> {
	try {
		productKit.value = await api<ProductKitRead>('/api/product-kit')
		productKitFailed.value = false
	}
	catch {
		productKitFailed.value = true
	}
}

/** The Product Kit file's `adapters`. */
const kitAdapters = createSettingsSection<AdapterRow[], ProductKit>({
	id: 'adapters',
	fromManifest: kit => adapterRows(kit.adapters),
	toPayload: draft => adapterSelections(draft),
})
/** The Product Kit file's `styles` and `themes` (the Styles & themes section). */
const stylesThemes = createSettingsSection<StylesThemesDraft, ProductKit>({
	id: 'styles',
	fromManifest: kit => stylesThemesDraft(kit),
	toPayload: draft => stylesThemesPayload(draft),
})

// A Workspace read (live refresh included) also re-reads the Product Kit file.
watch(workspace, () => {
	void loadProductKit()
}, { immediate: true })
// Live refresh: the Product Kit file changed elsewhere (its `product-kit` event, Clause
// 01a114ec-e839-7b11-957c-41c88b692e12). The sections keep a draft and raise a conflict when the
// change touched it (`createSettingsSection`). A resync re-reads the Workspace, which reads it too.
useLiveEvents().onResources((batch) => {
	if (!batch.resync && touchesKinds(batch, ['product-kit'])) void loadProductKit()
})
watch(productKit, (read) => {
	kitAdapters.sync(read)
	stylesThemes.sync(read)
})

const guard = useUnsavedGuard(() => kitAdapters.dirty || stylesThemes.dirty)
const unsavedCount = computed(() => kitAdapters.changeCount + stylesThemes.changeCount)

/** The Workspace theme registry, whose IDs the Product Kit `themes` map. */
const workspaceThemes = computed(() => Object.entries(workspace.value?.resource?.themes ?? {})
	.map(([id, entry]) => ({ id, label: typeof entry?.label === 'string' ? entry.label : '' })))

// Adapter package state, read-only (Part 8 10b).
const resolution = shallowRef<AdapterResolution>()
const resolutionFailed = ref(false)
async function loadResolution(): Promise<void> {
	resolutionFailed.value = false
	try { resolution.value = await uiux.previewAdapters() as AdapterResolution }
	catch { resolutionFailed.value = true }
}

/**
 * The build state: the value the Workbench shell polls (it also drives the failed-build banner), else,
 * before the first poll answers, the one the Product Kit read carried.
 */
const build = computed(() => kitBuild.build.value.state !== 'none' || !productKit.value ? kitBuild.build.value : productKit.value.build)
async function onRestarted(): Promise<void> {
	await kitBuild.refresh()
	await loadProductKit()
}

/** Problems of the Product Kit file and its kit project, for the whole page. */
const problems = computed<readonly Diagnostic[]>(() => [...productKit.value?.diagnostics ?? [], ...productKit.value?.findings ?? []])

/** The last Adapters save wrote the specifiers (`compose`) but not their `config` (`settings`). */
const kitPartlySaved = ref(false)

/**
 * Saves the Adapters through the Product Kit operations: `compose` when the specifiers or their order
 * change, then `update` with the new revision when a `config` differs (`productKitAdapterWrites`).
 * Each write is a compare-and-swap on the Product Kit file.
 *
 * When `compose` landed and the `config` write then failed for any reason but a conflict, the
 * Product Kit file is reloaded. When it is still the revision `compose` wrote, the draft is carried
 * onto it (`keepMine`): the specifiers are saved, the draft keeps the unsaved `config`, and the
 * section says so instead of raising a conflict over its own write. When someone else wrote it
 * since, the section raises the conflict as for any concurrent change.
 */
async function saveAdapters(): Promise<void> {
	const section = kitAdapters
	const kit = productKit.value
	if (!canEdit.value || !kit || !section.base || section.conflict || section.saving || !section.dirty) return
	section.saving = true
	section.clearError()
	kitPartlySaved.value = false
	lockRefusal.value = undefined
	let composedRevision: string | undefined
	/** Reloads the Product Kit file and, after a landed `compose`, carries the draft onto it if no one wrote since. */
	const reloadBase = async (): Promise<void> => {
		await loadProductKit()
		if (composedRevision === undefined || !productKit.value) return
		if (productKit.value.revision !== composedRevision) {
			section.conflict = true
			return
		}
		section.keepMine(productKit.value)
		kitPartlySaved.value = true
	}
	try {
		const writes = productKitAdapterWrites(kit.resource, section.draftPayload as WorkspaceAdapterSelection[])
		let revision = section.base.revision
		if (writes.compose) {
			const composed = await api<{ revision: string }>('/api/product-kit/compose', { method: 'PUT', body: { expectedRevision: revision, ...writes.compose } })
			revision = composed.revision
			composedRevision = composed.revision
		}
		if (writes.update)
			await api('/api/product-kit/settings', { method: 'PUT', body: { expectedRevision: revision, ...writes.update } })
		feedback.success(t('productKit.saved'))
		await loadProductKit()
		await workbench.refreshAll()
		void loadResolution()
	}
	catch (cause) {
		const details = describeFetchError(cause, t('productKit.saveFailed'))
		if (details.statusCode === 409 || details.status === 'conflict') {
			section.conflict = true
			await loadProductKit()
			void focusFirstProblem('#product-kit-adapters')
		}
		else if (isLockedError(details)) {
			// The base moves to the Product Kit file as it is now, a landed compose included.
			await reloadBase()
			if (kitPartlySaved.value) section.error = details
			lockRefusal.value = { lock: details.lock }
			void focusFirstProblem('main')
		}
		else {
			await reloadBase()
			section.error = details
			void focusFirstProblem('#product-kit-adapters')
		}
	}
	finally {
		section.saving = false
	}
}

function discard(): void {
	kitPartlySaved.value = false
	if (productKit.value) kitAdapters.adopt(productKit.value)
}

async function reloadTheirs(): Promise<void> {
	await workbench.refreshAll()
	await loadProductKit()
	discard()
}

function keepMine(): void {
	kitAdapters.keepMine(productKit.value)
}

/**
 * Saves Styles & themes with `update_product_kit` (`PUT /api/product-kit/settings`), a
 * compare-and-swap on the Product Kit file that also carries its saved Adapters unchanged. A
 * conflict (409) or someone else's edit lease keeps the draft.
 */
async function saveStylesThemes(): Promise<void> {
	const section = stylesThemes
	const kit = productKit.value
	if (!canEdit.value || !kit || !section.base || section.conflict || section.saving || !section.dirty) return
	section.saving = true
	section.clearError()
	lockRefusal.value = undefined
	try {
		const payload = section.draftPayload as StylesThemesPayload
		const savedAdapters = kit.resource.adapters.map(entry => ({ moduleSpecifier: entry.moduleSpecifier, ...(entry.config === undefined ? {} : { config: entry.config }) }))
		await api('/api/product-kit/settings', { method: 'PUT', body: { expectedRevision: section.base.revision, adapters: savedAdapters, styles: payload.styles, themes: payload.themes } })
		feedback.success(t('productKit.saved'))
		await loadProductKit()
		await workbench.refreshAll()
	}
	catch (cause) {
		const details = describeFetchError(cause, t('productKit.saveFailed'))
		if (details.statusCode === 409 || details.status === 'conflict') {
			section.conflict = true
			await loadProductKit()
			void focusFirstProblem('#product-kit-styles')
		}
		else if (isLockedError(details)) {
			lockRefusal.value = { lock: details.lock }
			await loadProductKit()
			void focusFirstProblem('main')
		}
		else {
			section.error = details
			void focusFirstProblem('#product-kit-styles')
		}
	}
	finally {
		section.saving = false
	}
}

function discardStylesThemes(): void {
	if (productKit.value) stylesThemes.adopt(productKit.value)
}

async function reloadStylesThemes(): Promise<void> {
	await workbench.refreshAll()
	await loadProductKit()
	discardStylesThemes()
}

const adaptersRef = ref<InstanceType<typeof ProductKitAdaptersSection>>()
const stylesRef = ref<InstanceType<typeof ProductKitStylesSection>>()

/**
 * ⌘S / Ctrl+S saves the draft of the section shown, else the only section with a draft, as Workspace
 * settings saves the focused section or the only one with a draft. That section opens first, so the
 * save and any problem it finds show there; with drafts in both, the shortcut says to open one.
 */
function onKeydown(event: KeyboardEvent): void {
	if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's' || event.shiftKey || event.altKey) return
	event.preventDefault()
	if (!canEdit.value) return
	const drafts: ProductKitSectionId[] = [...kitAdapters.dirty ? ['overview' as const] : [], ...stylesThemes.dirty ? ['styles' as const] : []]
	const target = drafts.includes(currentSection.value) ? currentSection.value : drafts.length === 1 ? drafts[0] : undefined
	if (target) void saveSection(target)
	else if (drafts.length) feedback.notice(t('productKit.saveWhich'))
}
async function saveSection(target: ProductKitSectionId): Promise<void> {
	if (target !== currentSection.value) {
		await router.push(productKitSectionLocation(target))
		await nextTick()
	}
	if (target === 'overview') adaptersRef.value?.save()
	else stylesRef.value?.save()
}

const scroller = ref<HTMLElement>()

/**
 * Shows what an address asks for: a fragment naming a block of the page (`ADAPTERS_HASH`, the
 * Adapter addresses and ⌘K "Adapters", or `#product-kit-build`) scrolls only the page's own scroller
 * to it, and a `section` alone opens that section at its top.
 */
function reveal(target: Readonly<{ hash: string; section?: string }>, moveFocus: boolean): void {
	const container = scroller.value
	if (!container) return
	const block = target.hash.startsWith('#product-kit-') ? document.getElementById(target.hash.slice(1)) : undefined
	if (block && container.contains(block)) {
		const top = block.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 24
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
		container.scrollTo({ top: Math.max(0, top), behavior: moveFocus && !reduced ? 'smooth' : 'auto' })
		if (moveFocus) block.querySelector<HTMLElement>('h2, h3')?.focus({ preventScroll: true })
	}
	else if (target.section) {
		container.scrollTo({ top: 0 })
	}
}

/** The blocks above the Adapters are laid out once the Product Kit file was read, or failed to be. */
const laidOut = computed(() => !!workspace.value?.resource && (!!productKit.value || productKitFailed.value))
let stopAfterEach: (() => void) | undefined
onMounted(() => {
	void loadResolution()
	window.addEventListener('keydown', onKeydown)
	let started = false
	watch(laidOut, (ready) => {
		if (!ready || started) return
		started = true
		void nextTick(() => reveal({ hash: route.hash, section: requestedSection.value }, false))
	}, { immediate: true })
	// Asked again while already here, the same address included: the router refuses a duplicate
	// navigation, but every navigation, failed or not, still reaches `afterEach`.
	stopAfterEach = router.afterEach((to) => {
		if (started && to.path === PRODUCT_KIT_PATH)
			void nextTick(() => reveal({ hash: to.hash, section: parseProductKitSection(to.query) }, true))
	})
})
onBeforeUnmount(() => {
	stopAfterEach?.()
	window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <WorkbenchPage
    id="workspace-product-kit"
    :title="t('productKit.title')"
  >
    <template #toolbar>
      <WorkspaceSubnav />
    </template>
    <div
      ref="scroller"
      class="flex min-h-0 flex-1 overflow-y-auto focus-visible:outline-offset-[-2px]"
      tabindex="0"
      role="region"
      :aria-label="t('productKit.title')"
    >
      <div
        class="mx-auto flex w-full flex-col gap-8 self-start px-4 pt-6 pb-16 sm:px-6"
        :class="currentSection === 'components' || currentSection === 'files' ? 'max-w-5xl' : 'max-w-180'"
      >
        <header class="flex flex-col gap-2">
          <h1 class="text-headline font-semibold text-highlighted">
            {{ t('productKit.title') }}
          </h1>
          <i18n-t
            keypath="productKit.subtitle"
            tag="p"
            scope="global"
            class="text-sm text-muted"
          >
            <template #file>
              <code class="font-mono text-xs">{{ PRODUCT_KIT_FILENAME }}</code>
            </template>
          </i18n-t>
          <AuthoringAccessNotice
            :access="access"
            :write-key="writeKey"
          />
          <LockBadge
            kind="product-kit"
            resource-key="product-kit"
          />
          <LockedSaveAlert
            v-if="lockRefusal"
            :lock="lockRefusal.lock"
            @dismiss="lockRefusal = undefined"
          />
          <nav
            class="-mx-1 mt-2 overflow-x-auto"
            :aria-label="t('productKit.sections')"
            data-product-kit-sections
          >
            <ul class="flex gap-1 px-1 pb-1">
              <li
                v-for="link in sectionLinks"
                :key="link.id"
              >
                <a
                  :href="link.href"
                  class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-primary"
                  :class="currentSection === link.id ? 'bg-elevated text-highlighted' : 'text-muted hover:bg-elevated/50 hover:text-default'"
                  :aria-current="currentSection === link.id ? 'page' : undefined"
                  :data-product-kit-section-link="link.id"
                  @click="openSection($event, link.location)"
                >
                  {{ link.label }}
                  <UBadge
                    v-if="(link.id === 'overview' && kitAdapters.dirty) || (link.id === 'styles' && stylesThemes.dirty)"
                    color="neutral"
                    variant="soft"
                    size="sm"
                  >
                    {{ t('authoring.unsavedShort') }}
                  </UBadge>
                </a>
              </li>
            </ul>
          </nav>
        </header>

        <section
          v-if="currentSection === 'overview'"
          id="product-kit-overview"
          :aria-label="t('productKit.overview')"
          class="flex flex-col gap-8"
          data-product-kit-section="overview"
        >
          <template v-if="workspace?.resource">
            <UAlert
              v-if="productKitFailed"
              color="warning"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :title="t('productKit.unavailable')"
              :actions="[{ label: t('common.retry'), color: 'neutral', variant: 'outline', onClick: () => { void loadProductKit() } }]"
              data-product-kit-unavailable
            >
              <template #description>
                <i18n-t
                  keypath="productKit.unavailableHelp"
                  tag="span"
                  scope="global"
                >
                  <template #file>
                    <code class="font-mono text-xs">{{ PRODUCT_KIT_FILENAME }}</code>
                  </template>
                </i18n-t>
              </template>
            </UAlert>
            <UAlert
              v-else-if="problems.length"
              color="warning"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :title="t('productKit.problems', { n: problems.length }, problems.length)"
              data-product-kit-problems
            >
              <template #description>
                <ul class="space-y-1">
                  <li
                    v-for="item in problems"
                    :key="item.code + item.path + item.message"
                    class="break-words"
                  >
                    <code class="me-1 font-mono text-xs">{{ item.code }}</code>{{ diagnosticText(item) }}
                  </li>
                </ul>
              </template>
            </UAlert>

            <template v-if="productKit">
              <ProductKitPackagesSection :packages="productKit.packages" />
              <USeparator />
            </template>
            <ProductKitBuildSection
              :build="build"
              :can-restart="canRestart"
              :can-read-log="member.can('product-kit.source.read')"
              @restarted="onRestarted"
            />
            <USeparator />

            <ProductKitAdaptersSection
              ref="adaptersRef"
              :section="kitAdapters"
              :can-edit="canEdit"
              :can-compose="member.can('product-kit.compose')"
              :partly-saved="kitPartlySaved"
              :resolution="resolution"
              :resolution-failed="resolutionFailed"
              @save="saveAdapters"
              @discard="discard"
              @reload="reloadTheirs"
              @keep-mine="keepMine"
              @retry-resolution="loadResolution"
            />
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
              class="h-8 w-2/3"
              :aria-label="t('common.loading')"
            />
          </div>
        </section>

        <template v-else>
          <template v-if="currentSection === 'files'">
            <ProductKitFilesSection
              v-if="workspace?.resource"
              :can-browse="member.can('product-kit.source.read')"
            />
          </template>
          <UAlert
            v-else-if="productKitFailed"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="t('productKit.unavailable')"
            :actions="[{ label: t('common.retry'), color: 'neutral', variant: 'outline', onClick: () => { void loadProductKit() } }]"
            data-product-kit-unavailable
          />
          <template v-else-if="productKit">
            <ProductKitComponentsSection
              v-if="currentSection === 'components'"
              :components="productKit.resource.components"
              :widgets="productKit.resource.widgets"
              :can-browse="member.can('product-kit.source.read')"
            />
            <ProductKitStylesSection
              v-else
              ref="stylesRef"
              :section="stylesThemes"
              :can-edit="canEdit"
              :workspace-themes="workspaceThemes"
              @save="saveStylesThemes"
              @discard="discardStylesThemes"
              @reload="reloadStylesThemes"
              @keep-mine="stylesThemes.keepMine(productKit)"
            />
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
          </div>
        </template>
      </div>
    </div>

    <UnsavedLeaveModal
      v-model:open="guard.open.value"
      :count="unsavedCount"
      @leave="guard.leave"
      @stay="guard.stay"
    />
  </WorkbenchPage>
</template>
