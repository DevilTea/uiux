<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

interface AssetSummary {
	kind: 'asset'
	key: string
	revision: string
	diagnosticCount: number
	summary: { name?: string; mediaType?: string; contentFilename?: string }
}

interface AssetDiscoveryPage {
	items: readonly AssetSummary[]
}

interface AssetRead {
	kind: 'asset'
	key: string
	revision: string
	diagnostics: ReadonlyArray<{ code: string; path: string; message: string }>
	resource: {
		metadata?: { name?: string; contentFilename?: string; mediaType?: string }
		content: { mediaType: string; size: number; digest: string; contentUrl: string }
	}
}

const assets = ref<readonly AssetSummary[]>([])
const selectedAssetId = ref<string>('')
const selectedAssetData = ref<AssetRead>()
const loadingList = ref(false)
const loadingDetail = ref(false)
const assetLoadSequence = ref(0)
const error = ref<string>()

// Creation state
const isCreatingAsset = ref(false)
const newName = ref('')
const newFilename = ref('')
const newMediaType = ref('')
const newFileBase64 = ref('')
const createError = ref<string>()
const creating = ref(false)

// Replacement state
const isReplacing = ref(false)
const replaceName = ref('')
const replaceFilename = ref('')
const replaceMediaType = ref('')
const replaceFileBase64 = ref('')
const replaceError = ref<string>()
const replacing = ref(false)
const replaceConflict = ref(false)

const isRenderableMedia = computed(() => {
	const mt = selectedAssetData.value?.resource.content.mediaType || selectedAssetData.value?.resource.metadata?.mediaType || ''
	return mt.startsWith('image/')
})

function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B'
	const k = 1024
	const sizes = ['B', 'KB', 'MB', 'GB']
	const i = Math.floor(Math.log(bytes) / Math.log(k))
	return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

async function fileToBase64(file: File): Promise<string> {
	const buffer = await file.arrayBuffer()
	const bytes = new Uint8Array(buffer)
	let binary = ''
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]!)
	}
	return btoa(binary)
}

async function onNewFileSelected(e: Event) {
	const input = e.target as HTMLInputElement
	const file = input.files?.[0]
	if (!file) return
	newFilename.value = file.name
	newMediaType.value = file.type || 'application/octet-stream'
	if (!newName.value) {
		newName.value = file.name.replace(/\.[^/.]+$/, '')
	}
	newFileBase64.value = await fileToBase64(file)
}

async function onReplaceFileSelected(e: Event) {
	const input = e.target as HTMLInputElement
	const file = input.files?.[0]
	if (!file) return
	replaceFilename.value = file.name
	replaceMediaType.value = file.type || 'application/octet-stream'
	replaceFileBase64.value = await fileToBase64(file)
}

async function fetchAssets() {
	loadingList.value = true
	error.value = undefined
	try {
		const res = await $fetch<AssetDiscoveryPage>('/api/resources/list', {
			method: 'POST',
			body: { kinds: ['asset'], limit: 100 },
		})
		assets.value = res.items
		if (!selectedAssetId.value && res.items.length > 0) {
			await selectAsset(res.items[0]!.key)
		}
		else if (selectedAssetId.value) {
			await loadSelectedAssetDetail()
		}
	}
	catch (err: unknown) {
		error.value = err instanceof Error ? err.message : 'Failed to fetch assets'
	}
	finally {
		loadingList.value = false
	}
}

async function selectAsset(id: string) {
	selectedAssetId.value = id
	isReplacing.value = false
	replaceConflict.value = false
	await loadSelectedAssetDetail()
}

async function loadSelectedAssetDetail() {
	const currentSeq = ++assetLoadSequence.value
	const id = selectedAssetId.value
	if (!id) {
		selectedAssetData.value = undefined
		return
	}

	loadingDetail.value = true
	try {
		const data = await $fetch<AssetRead>(`/api/resources/asset/${encodeURIComponent(id)}`)
		if (assetLoadSequence.value !== currentSeq) return
		selectedAssetData.value = data
		replaceName.value = data.resource.metadata?.name || ''
		replaceFilename.value = data.resource.metadata?.contentFilename || ''
		replaceMediaType.value = data.resource.content?.mediaType || data.resource.metadata?.mediaType || 'application/octet-stream'
	}
	catch (err: unknown) {
		if (assetLoadSequence.value !== currentSeq) return
		error.value = err instanceof Error ? err.message : 'Failed to load asset detail'
		selectedAssetData.value = undefined
	}
	finally {
		if (assetLoadSequence.value === currentSeq)
			loadingDetail.value = false
	}
}

async function handleCreateAsset() {
	if (!newName.value.trim() || !newFilename.value.trim() || !newFileBase64.value) {
		createError.value = 'Name, filename, and file data are required.'
		return
	}
	creating.value = true
	createError.value = undefined

	try {
		const res = await $fetch<{ status: string; key: string }>('/api/assets', {
			method: 'POST',
			body: {
				name: newName.value.trim(),
				contentFilename: newFilename.value.trim(),
				mediaType: newMediaType.value.trim() || 'application/octet-stream',
				contentBase64: newFileBase64.value,
			},
		})
		isCreatingAsset.value = false
		newName.value = ''
		newFilename.value = ''
		newMediaType.value = ''
		newFileBase64.value = ''
		await fetchAssets()
		if (res.key) await selectAsset(res.key)
	}
	catch (err: unknown) {
		const errorObj = err as { data?: { message?: string } }
		createError.value = errorObj?.data?.message || (err instanceof Error ? err.message : 'Failed to create asset')
	}
	finally {
		creating.value = false
	}
}

async function handleReplaceAsset() {
	if (!selectedAssetData.value) return
	if (!replaceFileBase64.value) {
		replaceError.value = 'Please select a new file to replace content.'
		return
	}

	replacing.value = true
	replaceError.value = undefined
	replaceConflict.value = false

	try {
		await $fetch(`/api/assets/${encodeURIComponent(selectedAssetData.value.key)}`, {
			method: 'PUT',
			body: {
				expectedRevision: selectedAssetData.value.revision,
				name: replaceName.value.trim() || selectedAssetData.value.resource.metadata?.name || 'Asset',
				contentFilename: replaceFilename.value.trim(),
				mediaType: replaceMediaType.value.trim() || 'application/octet-stream',
				contentBase64: replaceFileBase64.value,
			},
		})
		isReplacing.value = false
		replaceFileBase64.value = ''
		await fetchAssets()
	}
	catch (err: unknown) {
		const errorObj = err as { status?: number; statusCode?: number; data?: { message?: string } }
		if (errorObj?.status === 409 || errorObj?.statusCode === 409) {
			replaceConflict.value = true
		}
		else {
			replaceError.value = errorObj?.data?.message || (err instanceof Error ? err.message : 'Failed to replace asset')
		}
	}
	finally {
		replacing.value = false
	}
}

onMounted(() => {
	fetchAssets()
})
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden text-xs text-neutral-200">
    <!-- Header -->
    <div class="flex items-center justify-between border-b border-neutral-800 p-3">
      <div>
        <h2 class="text-sm font-semibold text-white">
          Assets
        </h2>
        <p class="text-[11px] text-neutral-400">
          Authored media & binary resources
        </p>
      </div>
      <UButton
        color="primary"
        variant="solid"
        size="xs"
        @click="isCreatingAsset = !isCreatingAsset"
      >
        + New Asset
      </UButton>
    </div>

    <!-- Create Asset Form -->
    <div
      v-if="isCreatingAsset"
      class="border-b border-neutral-800 bg-neutral-900/90 p-3 space-y-2.5"
    >
      <div class="flex items-center justify-between">
        <span class="font-semibold text-white">Upload New Asset</span>
        <button
          type="button"
          class="text-neutral-500 hover:text-neutral-300"
          @click="isCreatingAsset = false"
        >
          ✕
        </button>
      </div>

      <div class="space-y-1.5">
        <div>
          <span class="text-[10px] text-neutral-400">Select File:</span>
          <input
            type="file"
            class="block w-full text-xs text-neutral-400 file:mr-2 file:rounded file:border-0 file:bg-neutral-800 file:px-2 file:py-1 file:text-xs file:text-neutral-200 hover:file:bg-neutral-700"
            @change="onNewFileSelected"
          >
        </div>
        <div>
          <span class="text-[10px] text-neutral-400">Asset Name:</span>
          <UInput
            v-model="newName"
            size="xs"
            placeholder="e.g. Logo Header"
          />
        </div>
        <div class="flex gap-2">
          <div class="flex-1">
            <span class="text-[10px] text-neutral-400">Filename:</span>
            <UInput
              v-model="newFilename"
              size="xs"
              placeholder="logo.svg"
              class="font-mono"
            />
          </div>
          <div class="flex-1">
            <span class="text-[10px] text-neutral-400">Media Type:</span>
            <UInput
              v-model="newMediaType"
              size="xs"
              placeholder="image/svg+xml"
              class="font-mono"
            />
          </div>
        </div>
      </div>

      <p
        v-if="createError"
        class="text-[11px] text-red-400"
      >
        {{ createError }}
      </p>

      <div class="flex justify-end gap-2 pt-1">
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          @click="isCreatingAsset = false"
        >
          Cancel
        </UButton>
        <UButton
          color="primary"
          variant="solid"
          size="xs"
          :loading="creating"
          :disabled="!newFileBase64"
          @click="handleCreateAsset"
        >
          Save Asset
        </UButton>
      </div>
    </div>

    <!-- Assets List -->
    <div class="max-h-44 overflow-y-auto border-b border-neutral-800 p-2">
      <div
        v-if="assets.length"
        class="space-y-1"
      >
        <button
          v-for="asset in assets"
          :key="asset.key"
          type="button"
          class="flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-xs transition"
          :class="selectedAssetId === asset.key ? 'bg-primary/20 text-white font-medium' : 'text-neutral-300 hover:bg-neutral-800/60'"
          @click="selectAsset(asset.key)"
        >
          <div class="truncate">
            <span class="font-medium">{{ asset.summary.name || 'Unnamed Asset' }}</span>
            <span class="ml-1.5 font-mono text-[10px] text-neutral-500">{{ asset.summary.contentFilename }}</span>
          </div>
          <UBadge
            v-if="asset.diagnosticCount"
            color="warning"
            variant="soft"
            size="xs"
          >
            {{ asset.diagnosticCount }}
          </UBadge>
        </button>
      </div>
      <div
        v-else-if="!loadingList"
        class="py-4 text-center text-xs text-neutral-500"
      >
        No authored assets yet.
      </div>
    </div>

    <!-- Active Asset Details -->
    <div
      v-if="selectedAssetData"
      class="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 space-y-4"
    >
      <!-- Meta overview -->
      <div class="rounded border border-neutral-800 bg-neutral-900/60 p-3 space-y-2">
        <div class="flex items-center justify-between">
          <span class="font-semibold text-white">{{ selectedAssetData.resource.metadata?.name || 'Asset' }}</span>
          <span class="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
            Rev: {{ selectedAssetData.revision.slice(0, 12) }}…
          </span>
        </div>

        <div class="grid grid-cols-2 gap-2 text-[11px]">
          <div>
            <span class="text-neutral-500">Filename:</span>
            <p class="font-mono text-neutral-300 truncate">
              {{ selectedAssetData.resource.metadata?.contentFilename || '—' }}
            </p>
          </div>
          <div>
            <span class="text-neutral-500">Media Type:</span>
            <p class="font-mono text-neutral-300 truncate">
              {{ selectedAssetData.resource.content?.mediaType || '—' }}
            </p>
          </div>
          <div>
            <span class="text-neutral-500">Size:</span>
            <p class="font-mono text-neutral-300">
              {{ formatBytes(selectedAssetData.resource.content?.size ?? 0) }}
            </p>
          </div>
          <div>
            <span class="text-neutral-500">Digest:</span>
            <p
              class="font-mono text-[10px] text-neutral-400 truncate"
              :title="selectedAssetData.resource.content?.digest"
            >
              {{ selectedAssetData.resource.content?.digest ? selectedAssetData.resource.content.digest.slice(0, 18) + '…' : '—' }}
            </p>
          </div>
        </div>
      </div>

      <!-- Content Diagnostics Alert (Missing/Ambiguous content) -->
      <div
        v-if="selectedAssetData.diagnostics?.length"
        class="space-y-1.5"
      >
        <div
          v-for="diag in selectedAssetData.diagnostics"
          :key="diag.code + diag.path"
          class="rounded border border-amber-500/30 bg-amber-500/10 p-2.5 text-amber-300"
        >
          <div class="flex items-center gap-1.5 font-mono font-semibold text-amber-400">
            <span>⚠ [{{ diag.code }}]</span>
            <span class="text-neutral-400 font-normal">{{ diag.path }}</span>
          </div>
          <p class="mt-1 text-[11px] text-neutral-200 leading-relaxed">
            {{ diag.message }}
          </p>
        </div>
      </div>

      <!-- Preview Image when renderable -->
      <div
        v-if="isRenderableMedia"
        class="rounded border border-neutral-800 bg-neutral-950 p-3 space-y-2"
      >
        <span class="font-medium text-neutral-400">Content Preview</span>
        <div class="flex max-h-48 items-center justify-center overflow-hidden rounded bg-[radial-gradient(#333_1px,transparent_1px)] [background-size:12px_12px] p-2">
          <img
            :src="`/api/assets/${encodeURIComponent(selectedAssetData.key)}/content`"
            :alt="selectedAssetData.resource.metadata?.name || 'Asset Preview'"
            class="max-h-44 max-w-full rounded object-contain shadow"
          >
        </div>
      </div>

      <!-- Non-renderable binary notice -->
      <div
        v-else
        class="rounded border border-dashed border-neutral-800 p-4 text-center text-neutral-500"
      >
        Binary content ({{ selectedAssetData.resource.content?.mediaType }}). Preview unavailable for non-image media types.
      </div>

      <!-- Replace Asset form toggle & actions -->
      <div class="space-y-2 border-t border-neutral-800 pt-3">
        <div class="flex items-center justify-between">
          <a
            :href="`/api/assets/${encodeURIComponent(selectedAssetData.key)}/content`"
            :download="selectedAssetData.resource.metadata?.contentFilename || 'content.bin'"
            class="inline-flex items-center gap-1 rounded border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-700 hover:text-white"
          >
            ↓ Download
          </a>
          <UButton
            color="neutral"
            variant="outline"
            size="xs"
            @click="isReplacing = !isReplacing"
          >
            {{ isReplacing ? 'Cancel Replace' : 'Replace Asset Content' }}
          </UButton>
        </div>

        <!-- Replace Asset Form inline -->
        <div
          v-if="isReplacing"
          class="rounded border border-neutral-800 bg-neutral-900 p-3 space-y-2.5"
        >
          <span class="font-semibold text-white">Replace Content with Revision CAS</span>

          <div
            v-if="replaceConflict"
            class="rounded bg-amber-500/10 p-2 text-[11px] text-amber-300"
          >
            ⚠ Conflict: Asset was updated by another process. Please reload to review current state.
          </div>

          <div>
            <span class="text-[10px] text-neutral-400">Choose New File:</span>
            <input
              type="file"
              class="block w-full text-xs text-neutral-400 file:mr-2 file:rounded file:border-0 file:bg-neutral-800 file:px-2 file:py-1 file:text-xs file:text-neutral-200 hover:file:bg-neutral-700"
              @change="onReplaceFileSelected"
            >
          </div>

          <div class="flex gap-2">
            <div class="flex-1">
              <span class="text-[10px] text-neutral-400">Filename:</span>
              <UInput
                v-model="replaceFilename"
                size="xs"
                class="font-mono"
              />
            </div>
            <div class="flex-1">
              <span class="text-[10px] text-neutral-400">Media Type:</span>
              <UInput
                v-model="replaceMediaType"
                size="xs"
                class="font-mono"
              />
            </div>
          </div>

          <p
            v-if="replaceError"
            class="text-[11px] text-red-400"
          >
            {{ replaceError }}
          </p>

          <div class="flex justify-end gap-2 pt-1">
            <UButton
              color="primary"
              variant="solid"
              size="xs"
              :loading="replacing"
              :disabled="!replaceFileBase64"
              @click="handleReplaceAsset"
            >
              Commit Replacement
            </UButton>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty Detail State -->
    <div
      v-else-if="!loadingList"
      class="flex flex-1 items-center justify-center p-6 text-center text-xs text-neutral-500"
    >
      Select an asset to view metadata and media preview.
    </div>
  </div>
</template>
