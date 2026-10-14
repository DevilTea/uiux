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
import { createSettingsSection } from '../../composables/useSettingsSection'
import { describeFetchError, isLockedError, type FetchErrorLock } from '../../utils/fetch-error'
import { adapterRows, adapterSelections, productKitAdapterWrites, type AdapterRow } from '../../utils/workspace-authoring'
import { ADAPTERS_HASH, parseProductKitSection, PRODUCT_KIT_PATH } from '../../utils/workbench-routes'
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
import { PRODUCT_KIT_FILENAME, PRODUCT_KIT_SCHEMA_VERSION, type ProductKit } from '../../../src/domain/product-kit/schema'
import type { WorkspaceAdapterSelection } from '../../../src/domain/workspace/schema'
import type { ProductKitRead } from '../../../src/application/services/product-kit-authoring'
import type { Diagnostic } from '../../composables/workbench-types'

/**
 * The Product Kit page, `/workspace/product-kit` (Clause 01a11be8-5cab-7e50-89fe-b89c243d773d). Its
 * Overview section (Rule 01a11bb1-b918-7cb5-b581-a3fd3f647f09) shows the Design System packages, the
 * kit build with its log, and the Adapters (Rules 01a116f0-8a46-76bc-a29f-affaa302c44c and
 * 01a115cd-af57-781e-9493-89d037e41b06), which moved here from Workspace settings. The Components,
 * Styles & themes and Files sections are not built yet (issue #141); `?section=` naming one of them,
 * or an unknown value, opens the page at its top.
 *
 * Reading needs `workspace.read`, the build log `product-kit.source.read`. The Adapters save through
 * the Product Kit operations (`PUT /api/product-kit/compose` for the specifiers and their order,
 * then `PUT /api/product-kit/settings` for their `config`) with the Product Kit file's revision,
 * `product-kit.write` and its edit lease, and `product-kit.compose` gates the selection itself
 * (Discussion #139 owner ruling 6, https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18851627).
 * The server enforces every key; the page only reflects them.
 *
 * Below `schemaVersion` 5 the Workspace has no Product Kit file: the page shows the manifest's
 * Adapters read-only until `uiux migrate` runs. From 5 the build reads its own endpoint, so it and
 * its restart stay available when the Product Kit file cannot be read.
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
const { access, writeKey, canEdit } = useAuthoringAccess('product-kit.write', { kind: 'product-kit', key: 'product-kit' })
/** The build restart follows the same access as the page's writes, except the edit lease: it writes no file. */
const { canEdit: canRestart } = useAuthoringAccess('product-kit.write')
/** A save refused by someone else's edit lease; the draft is kept. */
const lockRefusal = shallowRef<Readonly<{ lock?: FetchErrorLock }>>()

const usesProductKit = computed(() => (workspace.value?.resource?.schemaVersion ?? 0) >= PRODUCT_KIT_SCHEMA_VERSION)

// Untyped request helper: Nitro's typed-route inference overflows on this many routes.
const api = $fetch as unknown as <T = unknown>(url: string, options?: Readonly<Record<string, unknown>>) => Promise<T>

const productKit = shallowRef<ProductKitRead>()
const productKitFailed = ref(false)
async function loadProductKit(): Promise<void> {
	if (!usesProductKit.value) {
		productKit.value = undefined
		return
	}
	try {
		productKit.value = await api<ProductKitRead>('/api/product-kit')
		productKitFailed.value = false
	}
	catch {
		productKitFailed.value = true
	}
}

/** From `schemaVersion` 5: the Product Kit file's `adapters`. */
const kitAdapters = createSettingsSection<AdapterRow[], ProductKit>({
	id: 'adapters',
	fromManifest: kit => adapterRows(kit.adapters),
	toPayload: draft => adapterSelections(draft),
})
/** Below `schemaVersion` 5: the manifest's `adapters`, read-only until the Workspace is migrated. */
const manifestAdapters = createSettingsSection({
	id: 'adapters',
	fromManifest: manifest => adapterRows(manifest.adapters),
	toPayload: draft => adapterSelections(draft),
})
const adapters = computed(() => usesProductKit.value ? kitAdapters : manifestAdapters)

watch(workspace, (read) => {
	manifestAdapters.sync(read)
	// A Workspace read (live refresh included) also re-reads the Product Kit file.
	void loadProductKit()
}, { immediate: true })
watch(productKit, read => kitAdapters.sync(read))

const guard = useUnsavedGuard(() => adapters.value.dirty)

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
	if (!usesProductKit.value || !canEdit.value || !kit || !section.base || section.conflict || section.saving || !section.dirty) return
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
	if (usesProductKit.value) {
		if (productKit.value) kitAdapters.adopt(productKit.value)
	}
	else if (workspace.value) {
		manifestAdapters.adopt(workspace.value)
	}
}

async function reloadTheirs(): Promise<void> {
	await workbench.refreshAll()
	await loadProductKit()
	discard()
}

function keepMine(): void {
	if (usesProductKit.value) kitAdapters.keepMine(productKit.value)
	else manifestAdapters.keepMine(workspace.value)
}

const adaptersRef = ref<InstanceType<typeof ProductKitAdaptersSection>>()

/** ⌘S / Ctrl+S saves the Adapters draft. */
function onKeydown(event: KeyboardEvent): void {
	if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's' || event.shiftKey || event.altKey) return
	event.preventDefault()
	if (canEdit.value && usesProductKit.value && kitAdapters.dirty) adaptersRef.value?.save()
}

const scroller = ref<HTMLElement>()

/**
 * Shows what an address asks for: `ADAPTERS_HASH` (the Adapter addresses and ⌘K "Adapters") scrolls
 * only the page's own scroller to the Adapters block, and `?section=overview` alone opens Overview,
 * the page's top.
 */
function reveal(target: Readonly<{ hash: string; section?: string }>, moveFocus: boolean): void {
	const container = scroller.value
	if (!container) return
	if (target.hash === ADAPTERS_HASH) {
		const block = document.getElementById(ADAPTERS_HASH.slice(1))
		if (!block) return
		const top = block.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 24
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
		container.scrollTo({ top: Math.max(0, top), behavior: moveFocus && !reduced ? 'smooth' : 'auto' })
		if (moveFocus) block.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
	}
	else if (target.section === 'overview') {
		container.scrollTo({ top: 0 })
	}
}

/** The blocks above the Adapters are laid out once the Product Kit file was read, or failed to be. */
const laidOut = computed(() => !!workspace.value?.resource && (!usesProductKit.value || !!productKit.value || productKitFailed.value))
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
      <div class="mx-auto flex w-full max-w-180 flex-col gap-8 self-start px-4 pt-6 pb-16 sm:px-6">
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
            v-if="usesProductKit"
            kind="product-kit"
            resource-key="product-kit"
          />
          <LockedSaveAlert
            v-if="lockRefusal"
            :lock="lockRefusal.lock"
            @dismiss="lockRefusal = undefined"
          />
        </header>

        <section
          id="product-kit-overview"
          :aria-label="t('productKit.overview')"
          class="flex flex-col gap-8"
          data-product-kit-section="overview"
        >
          <template v-if="workspace?.resource">
            <UAlert
              v-if="!usesProductKit"
              color="info"
              variant="subtle"
              icon="i-lucide-info"
              :title="t('productKit.legacy')"
              data-product-kit-legacy
            />
            <UAlert
              v-else-if="productKitFailed"
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

            <template v-if="usesProductKit">
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
            </template>

            <ProductKitAdaptersSection
              ref="adaptersRef"
              :section="adapters"
              :can-edit="usesProductKit && canEdit"
              :product-kit="usesProductKit"
              :can-compose="member.can('product-kit.compose')"
              :partly-saved="usesProductKit && kitPartlySaved"
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
      </div>
    </div>

    <UnsavedLeaveModal
      v-model:open="guard.open.value"
      :count="adapters.changeCount"
      @leave="guard.leave"
      @stay="guard.stay"
    />
  </WorkbenchPage>
</template>
