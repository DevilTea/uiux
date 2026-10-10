<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { useWorkbenchFeedback } from '../../composables/useWorkbenchFeedback'
import { useWorkbenchFormat } from '../../composables/useWorkbenchFormat'
import { useAuthoringAccess } from '../../composables/useAuthoringAccess'
import { useAccess } from '../../composables/useAccess'
import { describeFetchError, type FetchErrorDetails } from '../../utils/fetch-error'
import { collectAssetReferences, isImageMediaType } from '../../utils/workspace-authoring'
import WorkbenchPage from '../workbench/WorkbenchPage.vue'
import WorkspaceSubnav from './WorkspaceSubnav.vue'
import WbErrorDescription from '../workbench/WbErrorDescription.vue'
import AuthoringAccessNotice from './AuthoringAccessNotice.vue'
import AssetUploadModal from './AssetUploadModal.vue'
import AssetDetailSlideover from './AssetDetailSlideover.vue'
import type { AssetEntry, AssetRead, AssetSummary, AssetUse } from './asset-types'

/**
 * Assets (brief g): the Workspace library as a grid or a list, with upload, filters for type
 * and usage, and a detail slideover for metadata, replacement, usage and diagnostics. Usage is
 * derived from the `$asset` bindings in each View. Unused Assets stay; nothing is collected.
 */
const { t } = useI18n()
const workbench = useWorkbench()
const { views } = workbench
const uiux = useUiuxClient()
const feedback = useWorkbenchFeedback()
const fmt = useWorkbenchFormat()
const { access, canEdit, isMobile } = useAuthoringAccess()
/** Each Asset is its own lockable resource; someone else's edit lease makes its detail read-only. */
const member = useAccess()

const entries = ref<AssetEntry[]>([])
const usage = shallowRef(new Map<string, AssetUse[]>())
const loading = ref(true)
const loadError = ref<FetchErrorDetails>()

function toEntry(summary: AssetSummary | undefined, read: AssetRead | undefined, usedBy: readonly AssetUse[]): AssetEntry | undefined {
	const key = read?.key ?? summary?.key
	if (!key) return undefined
	const metadata = read?.resource.metadata
	return {
		key,
		revision: read?.revision ?? summary?.revision ?? '',
		name: metadata?.name ?? summary?.summary.name ?? '',
		contentFilename: metadata?.contentFilename ?? summary?.summary.contentFilename ?? '',
		mediaType: read?.resource.content?.mediaType ?? metadata?.mediaType ?? summary?.summary.mediaType ?? '',
		size: read?.resource.content?.size,
		digest: read?.resource.content?.digest,
		diagnostics: read?.diagnostics ?? [],
		usedBy,
		read,
	}
}

async function loadUsage(): Promise<void> {
	const map = new Map<string, AssetUse[]>()
	const reads = await Promise.all(views.value.map(view => uiux.readResource<{ key: string; resource: unknown }>('view', view.key).catch(() => undefined)))
	reads.forEach((read, index) => {
		if (!read) return
		const view = views.value[index]!
		for (const id of collectAssetReferences(read.resource)) {
			const list = map.get(id) ?? []
			list.push({ viewId: view.key, name: view.summary.name || t('common.unnamed') })
			map.set(id, list)
		}
	})
	usage.value = map
}

async function load(): Promise<void> {
	loading.value = true
	loadError.value = undefined
	try {
		const [list] = await Promise.all([
			uiux.listResources<AssetSummary>(['asset'], { limit: 100 }),
			loadUsage(),
		])
		const reads = await Promise.all(list.items.map(item => uiux.readResource<AssetRead>('asset', item.key).catch(() => undefined)))
		entries.value = list.items
			.map((summary, index) => toEntry(summary, reads[index], usage.value.get(summary.key) ?? []))
			.filter((entry): entry is AssetEntry => !!entry)
	}
	catch (cause) {
		loadError.value = describeFetchError(cause, t('assets.loadListFailed'))
	}
	finally {
		loading.value = false
	}
}

async function reread(key: string): Promise<AssetEntry | undefined> {
	const read = await uiux.readResource<AssetRead>('asset', key)
	return toEntry(undefined, read, usage.value.get(key) ?? [])
}

onMounted(load)
watch(() => views.value.map(view => view.key).join(), () => { void loadUsage().then(() => {
	entries.value = entries.value.map(entry => ({ ...entry, usedBy: usage.value.get(entry.key) ?? [] }))
}) })

// Filters and layout
type TypeFilter = 'all' | 'image' | 'other'
type UsageFilter = 'all' | 'used' | 'unused'
const query = ref('')
const typeFilter = ref<TypeFilter>('all')
const usageFilter = ref<UsageFilter>('all')
const LAYOUT_KEY = 'uiux.workbench.assetsLayout'
const layout = ref<'grid' | 'list'>('grid')
try { if (globalThis.localStorage?.getItem(LAYOUT_KEY) === 'list') layout.value = 'list' }
catch { /* storage unavailable */ }
watch(layout, (value) => {
	try { globalThis.localStorage?.setItem(LAYOUT_KEY, value) }
	catch { /* storage unavailable */ }
})

const typeItems = computed(() => [
	{ label: t('assets.filter.allTypes'), value: 'all' },
	{ label: t('assets.filter.images'), value: 'image' },
	{ label: t('assets.filter.otherFiles'), value: 'other' },
])
const usageItems = computed(() => [
	{ label: t('assets.filter.anyUsage'), value: 'all' },
	{ label: t('assets.filter.used'), value: 'used' },
	{ label: t('assets.unused'), value: 'unused' },
])

const visible = computed(() => {
	const q = query.value.trim().toLowerCase()
	return entries.value.filter((entry) => {
		if (typeFilter.value === 'image' && !isImageMediaType(entry.mediaType)) return false
		if (typeFilter.value === 'other' && isImageMediaType(entry.mediaType)) return false
		if (usageFilter.value === 'used' && !entry.usedBy.length) return false
		if (usageFilter.value === 'unused' && entry.usedBy.length) return false
		return !q || entry.name.toLowerCase().includes(q) || entry.contentFilename.toLowerCase().includes(q)
	})
})
const filtered = computed(() => !!query.value.trim() || typeFilter.value !== 'all' || usageFilter.value !== 'all')
function clearFilters(): void {
	query.value = ''
	typeFilter.value = 'all'
	usageFilter.value = 'all'
}

/**
 * A published site resolves each Asset's address once (an SVG file becomes a `data:` URL; see
 * `resolveAssetContentUrl`). Until it arrives the Asset shows no image and no Download link.
 */
const publishedUrls = ref<Readonly<Record<string, string>>>({})
watch(entries, async (list) => {
	if (!uiux.isReadOnly.value) return
	const missing = list.filter(entry => !(entry.key in publishedUrls.value))
	if (!missing.length) return
	const urls = await Promise.all(missing.map(entry => uiux.resolveAssetContentUrl(entry.key).catch(() => '')))
	publishedUrls.value = { ...publishedUrls.value, ...Object.fromEntries(missing.map((entry, index) => [entry.key, urls[index]!])) }
})
function contentUrl(entry: AssetEntry): string {
	return uiux.isReadOnly.value ? publishedUrls.value[entry.key] ?? '' : uiux.assetUrl(entry.key)
}

function describe(entry: AssetEntry): string {
	return [entry.mediaType, entry.size !== undefined ? fmt.bytes(entry.size) : ''].filter(Boolean).join(' · ')
}

// Detail
const selectedKey = ref<string>()
const detailOpen = ref(false)
const selected = computed(() => entries.value.find(entry => entry.key === selectedKey.value))
function openDetail(entry: AssetEntry): void {
	selectedKey.value = entry.key
	detailOpen.value = true
}
async function onChanged(key: string): Promise<void> {
	const latest = await reread(key).catch(() => undefined)
	if (latest) entries.value = entries.value.map(entry => entry.key === key ? latest : entry)
	void workbench.refreshAll()
}

// Upload
const uploading = ref(false)
async function onCreated(key: string, name: string): Promise<void> {
	feedback.success(t('assets.created', { name }))
	await load()
	void workbench.refreshAll()
	const created = entries.value.find(entry => entry.key === key)
	if (created) openDetail(created)
}

const columns = computed<TableColumn<AssetEntry>[]>(() => [
	{ id: 'name', header: t('assets.fields.name') },
	{ id: 'filename', header: t('assets.fields.filename') },
	{ id: 'type', header: t('assets.fields.mediaType') },
	{ id: 'size', header: t('assets.fields.size'), meta: { class: { th: 'text-end', td: 'text-end' } } },
	{ id: 'usage', header: t('assets.usage') },
	{ id: 'download', header: () => t('assets.download'), meta: { class: { th: 'sr-only', td: 'w-10 text-end' } } },
])
</script>

<template>
  <WorkbenchPage
    id="workspace-assets"
    :title="t('assets.title')"
  >
    <template #toolbar>
      <WorkspaceSubnav />
    </template>
    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div class="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 pt-6 pb-16 sm:px-6">
        <header class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0 space-y-1">
            <h1 class="text-headline font-semibold text-highlighted">
              {{ t('assets.title') }}
            </h1>
            <p class="text-sm text-muted">
              {{ t('assets.subtitle') }}
            </p>
          </div>
          <UButton
            v-if="canEdit"
            color="primary"
            variant="solid"
            icon="i-lucide-upload"
            @click="uploading = true"
          >
            {{ t('assets.upload') }}
          </UButton>
        </header>
        <AuthoringAccessNotice :access="access" />

        <div
          v-if="entries.length"
          class="flex flex-wrap items-center gap-2"
        >
          <UInput
            v-model="query"
            icon="i-lucide-search"
            :placeholder="t('assets.filter.search')"
            :aria-label="t('assets.filter.search')"
            class="w-full sm:w-64"
          />
          <USelect
            v-model="typeFilter"
            :items="typeItems"
            :aria-label="t('assets.filter.type')"
            class="w-40"
          />
          <USelect
            v-model="usageFilter"
            :items="usageItems"
            :aria-label="t('assets.filter.usage')"
            class="w-40"
          />
          <UFieldGroup
            v-if="!isMobile"
            class="ms-auto"
          >
            <UTooltip :text="t('assets.layout.grid')">
              <UButton
                color="neutral"
                :variant="layout === 'grid' ? 'soft' : 'outline'"
                icon="i-lucide-layout-grid"
                :aria-label="t('assets.layout.grid')"
                :aria-pressed="layout === 'grid'"
                @click="layout = 'grid'"
              />
            </UTooltip>
            <UTooltip :text="t('assets.layout.list')">
              <UButton
                color="neutral"
                :variant="layout === 'list' ? 'soft' : 'outline'"
                icon="i-lucide-list"
                :aria-label="t('assets.layout.list')"
                :aria-pressed="layout === 'list'"
                @click="layout = 'list'"
              />
            </UTooltip>
          </UFieldGroup>
        </div>

        <UAlert
          v-if="loadError"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          role="alert"
          :title="t('assets.loadListFailed')"
          :actions="[{ label: t('common.retry'), color: 'neutral', variant: 'outline', onClick: () => { void load() } }]"
        >
          <template #description>
            <WbErrorDescription
              :headline="t('assets.loadListFailed')"
              :lead="loadError.message"
              :diagnostics="loadError.diagnostics"
              :status-code="loadError.statusCode"
            />
          </template>
        </UAlert>

        <div
          v-if="loading && !entries.length"
          class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
          aria-hidden="true"
        >
          <USkeleton
            v-for="n in 5"
            :key="n"
            class="aspect-4/3 w-full rounded-lg"
            :aria-label="t('common.loading')"
          />
        </div>

        <UEmpty
          v-else-if="!entries.length && !loadError"
          icon="i-lucide-image"
          :title="t('assets.emptyTitle')"
          :description="canEdit ? t('assets.emptyDescription') : t('assets.emptyDescriptionReadOnly')"
          :actions="canEdit ? [{ label: t('assets.upload'), icon: 'i-lucide-upload', color: 'primary', onClick: () => { uploading = true } }] : []"
          class="my-8"
        />

        <UEmpty
          v-else-if="!visible.length && filtered"
          icon="i-lucide-search-x"
          :title="t('assets.filter.noMatch')"
          :actions="[{ label: t('assets.filter.clear'), color: 'neutral', variant: 'outline', onClick: clearFilters }]"
          class="my-8"
        />

        <!-- Grid -->
        <ul
          v-else-if="layout === 'grid' || isMobile"
          class="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5"
          data-asset-grid
        >
          <li
            v-for="entry in visible"
            :key="entry.key"
          >
            <UCard
              variant="outline"
              :ui="{ root: 'overflow-hidden', body: 'p-0 sm:p-0' }"
            >
              <button
                type="button"
                class="block w-full text-start"
                :aria-label="t('assets.openDetail', { name: entry.name || t('assets.unnamedAsset') })"
                data-asset-tile
                @click="openDetail(entry)"
              >
                <span class="flex aspect-4/3 items-center justify-center border-b border-default bg-elevated p-4">
                  <img
                    v-if="isImageMediaType(entry.mediaType) && !entry.diagnostics.length && contentUrl(entry)"
                    :src="contentUrl(entry)"
                    alt=""
                    loading="lazy"
                    class="max-h-full max-w-full object-contain"
                  >
                  <UIcon
                    v-else
                    :name="entry.diagnostics.length ? 'i-lucide-file-x-2' : 'i-lucide-file'"
                    class="size-8 text-muted"
                  />
                </span>
                <span class="flex flex-col gap-1 px-3 pt-2.5">
                  <span class="truncate text-sm font-medium text-highlighted">{{ entry.name || t('assets.unnamedAsset') }}</span>
                  <span class="truncate font-mono text-xs text-muted">{{ describe(entry) }}</span>
                </span>
              </button>
              <div class="flex items-center gap-1.5 px-3 pt-2 pb-2.5">
                <UBadge
                  v-if="entry.diagnostics.length"
                  color="error"
                  variant="subtle"
                  size="sm"
                  icon="i-lucide-circle-alert"
                >
                  {{ t('assets.problems', { n: entry.diagnostics.length }, entry.diagnostics.length) }}
                </UBadge>
                <UBadge
                  v-if="entry.usedBy.length"
                  color="neutral"
                  variant="soft"
                  size="sm"
                >
                  {{ t('assets.usedBy', { n: entry.usedBy.length }, entry.usedBy.length) }}
                </UBadge>
                <UBadge
                  v-else
                  color="neutral"
                  variant="outline"
                  size="sm"
                >
                  {{ t('assets.unused') }}
                </UBadge>
                <UTooltip :text="t('assets.download')">
                  <UButton
                    v-if="contentUrl(entry)"
                    :to="contentUrl(entry)"
                    external
                    :download="entry.contentFilename || 'content.bin'"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    icon="i-lucide-download"
                    class="ms-auto"
                    :aria-label="t('assets.downloadName', { name: entry.name || entry.contentFilename })"
                  />
                </UTooltip>
              </div>
            </UCard>
          </li>
        </ul>

        <!-- List -->
        <UTable
          v-else
          :data="visible"
          :columns="columns"
          :get-row-id="(entry: AssetEntry) => entry.key"
          :ui="{ th: 'text-xs font-medium text-muted', td: 'text-sm' }"
          data-asset-list
        >
          <template #name-cell="{ row }">
            <button
              type="button"
              class="flex items-center gap-2 text-start font-medium text-highlighted hover:underline"
              @click="openDetail(row.original)"
            >
              <UIcon
                :name="row.original.diagnostics.length ? 'i-lucide-file-x-2' : isImageMediaType(row.original.mediaType) ? 'i-lucide-image' : 'i-lucide-file'"
                class="size-4 shrink-0 text-muted"
              />{{ row.original.name || t('assets.unnamedAsset') }}
            </button>
          </template>
          <template #filename-cell="{ row }">
            <span class="font-mono text-xs text-muted">{{ row.original.contentFilename }}</span>
          </template>
          <template #type-cell="{ row }">
            <span class="font-mono text-xs">{{ row.original.mediaType }}</span>
          </template>
          <template #size-cell="{ row }">
            <span class="font-mono text-xs">{{ row.original.size !== undefined ? fmt.bytes(row.original.size) : '' }}</span>
          </template>
          <template #usage-cell="{ row }">
            <span class="flex flex-wrap gap-1.5">
              <UBadge
                v-if="row.original.diagnostics.length"
                color="error"
                variant="subtle"
                size="sm"
                icon="i-lucide-circle-alert"
              >
                {{ t('assets.problems', { n: row.original.diagnostics.length }, row.original.diagnostics.length) }}
              </UBadge>
              <UBadge
                v-if="row.original.usedBy.length"
                color="neutral"
                variant="soft"
                size="sm"
              >
                {{ t('assets.usedBy', { n: row.original.usedBy.length }, row.original.usedBy.length) }}
              </UBadge>
              <UBadge
                v-else
                color="neutral"
                variant="outline"
                size="sm"
              >
                {{ t('assets.unused') }}
              </UBadge>
            </span>
          </template>
          <template #download-cell="{ row }">
            <UButton
              v-if="contentUrl(row.original)"
              :to="contentUrl(row.original)"
              external
              :download="row.original.contentFilename || 'content.bin'"
              color="neutral"
              variant="ghost"
              size="sm"
              icon="i-lucide-download"
              :aria-label="t('assets.downloadName', { name: row.original.name || row.original.contentFilename })"
            />
          </template>
        </UTable>
      </div>
    </div>

    <AssetDetailSlideover
      v-if="selected"
      v-model:open="detailOpen"
      :entry="selected"
      :can-edit="canEdit && !member.lockFor('asset', selected.key)"
      :content-url="contentUrl(selected)"
      :reread="reread"
      @changed="onChanged"
    />
    <AssetUploadModal
      v-if="canEdit"
      v-model:open="uploading"
      @created="onCreated"
    />
  </WorkbenchPage>
</template>
