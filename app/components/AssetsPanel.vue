<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import { useI18n } from '#imports'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useUiuxClient } from '../composables/useUiuxClient'
import { useWorkbenchFeedback } from '../composables/useWorkbenchFeedback'
import { useWorkbenchFormat } from '../composables/useWorkbenchFormat'
import { describeFetchError, type FetchErrorDetails } from '../utils/fetch-error'

interface AssetSummary {
	kind: 'asset'
	key: string
	revision: string
	diagnosticCount: number
	summary: { name?: string; mediaType?: string; contentFilename?: string }
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

const { readOnly = false } = defineProps<{ readOnly?: boolean }>()
const emit = defineEmits<{ changed: [] }>()

const { t } = useI18n()
const uiux = useUiuxClient()
const feedback = useWorkbenchFeedback()
const fmt = useWorkbenchFormat()

const assets = ref<readonly AssetSummary[]>([])
const selectedAssetId = ref<string>('')
const selectedAssetData = ref<AssetRead>()
const loadingList = ref(false)
const loadingDetail = ref(false)
const assetLoadSequence = ref(0)
const listError = ref<FetchErrorDetails>()
const detailError = ref<FetchErrorDetails>()

// Creation state
const isCreatingAsset = ref(false)
const createState = reactive({
	file: null as File | null,
	name: '',
	filename: '',
	mediaType: '',
})
const newFileBase64 = ref('')
const createError = ref<FetchErrorDetails>()
const creating = ref(false)

// Replacement state
const isReplacing = ref(false)
const replaceState = reactive({
	file: null as File | null,
	filename: '',
	mediaType: '',
})
const replaceName = ref('')
const replaceFileBase64 = ref('')
const replaceError = ref<FetchErrorDetails>()
const replacing = ref(false)
const replaceConflict = ref(false)

const assetItems = computed(() => assets.value.map(asset => ({
	label: asset.summary.name || t('assets.unnamedAsset'),
	description: asset.summary.contentFilename || '',
	value: asset.key,
	diagnosticCount: asset.diagnosticCount,
})))

const selectedMediaType = computed(() => selectedAssetData.value?.resource.content?.mediaType || selectedAssetData.value?.resource.metadata?.mediaType || '')
const isRenderableMedia = computed(() => selectedMediaType.value.startsWith('image/'))

const selectedAssetContentUrl = computed(() => selectedAssetId.value ? uiux.assetUrl(selectedAssetId.value) : '')

async function fileToBase64(file: File): Promise<string> {
	const buffer = await file.arrayBuffer()
	const bytes = new Uint8Array(buffer)
	let binary = ''
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]!)
	}
	return btoa(binary)
}

watch(() => createState.file, async (file) => {
	if (!file) {
		newFileBase64.value = ''
		return
	}
	createState.filename = file.name
	createState.mediaType = file.type || 'application/octet-stream'
	if (!createState.name) {
		createState.name = file.name.replace(/\.[^/.]+$/, '')
	}
	const encoded = await fileToBase64(file)
	if (createState.file === file) newFileBase64.value = encoded
})

watch(() => replaceState.file, async (file) => {
	if (!file) {
		replaceFileBase64.value = ''
		return
	}
	replaceState.filename = file.name
	replaceState.mediaType = file.type || 'application/octet-stream'
	const encoded = await fileToBase64(file)
	if (replaceState.file === file) replaceFileBase64.value = encoded
})

function validateCreate(state: Partial<typeof createState>): FormError[] {
	const errors: FormError[] = []
	if (!state.file) errors.push({ name: 'file', message: t('assets.validation.fileRequired') })
	if (!state.name?.trim()) errors.push({ name: 'name', message: t('assets.validation.nameRequired') })
	if (!state.filename?.trim()) errors.push({ name: 'filename', message: t('assets.validation.filenameRequired') })
	return errors
}

function validateReplace(state: Partial<typeof replaceState>): FormError[] {
	return state.file ? [] : [{ name: 'file', message: t('assets.validation.replacementFileRequired') }]
}

function openCreate() {
	createError.value = undefined
	isCreatingAsset.value = true
}

function openReplace() {
	replaceError.value = undefined
	replaceConflict.value = false
	isReplacing.value = true
}

async function fetchAssets() {
	loadingList.value = true
	listError.value = undefined
	try {
		const res = await uiux.listResources<AssetSummary>(['asset'], { limit: 100 })
		assets.value = res.items
		if (!selectedAssetId.value && res.items.length > 0) {
			await selectAsset(res.items[0]!.key)
		}
		else if (selectedAssetId.value) {
			await loadSelectedAssetDetail()
		}
	}
	catch (err: unknown) {
		listError.value = describeFetchError(err, t('assets.loadListFailed'))
	}
	finally {
		loadingList.value = false
	}
}

function onSelectAsset(value: unknown) {
	if (typeof value === 'string' && value && value !== selectedAssetId.value) void selectAsset(value)
}

async function selectAsset(id: string) {
	selectedAssetId.value = id
	isReplacing.value = false
	replaceConflict.value = false
	replaceState.file = null
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
	detailError.value = undefined
	try {
		const data = await uiux.readResource<AssetRead>('asset', id)
		if (!data) throw new Error(t('assets.unavailable'))
		if (assetLoadSequence.value !== currentSeq) return
		selectedAssetData.value = data
		replaceName.value = data.resource.metadata?.name || ''
		// Keep a file the user already picked (e.g. while reloading after a conflict).
		if (!replaceState.file) {
			replaceState.filename = data.resource.metadata?.contentFilename || ''
			replaceState.mediaType = data.resource.content?.mediaType || data.resource.metadata?.mediaType || 'application/octet-stream'
		}
	}
	catch (err: unknown) {
		if (assetLoadSequence.value !== currentSeq) return
		detailError.value = describeFetchError(err, t('assets.loadDetailFailed'))
		selectedAssetData.value = undefined
	}
	finally {
		if (assetLoadSequence.value === currentSeq)
			loadingDetail.value = false
	}
}

async function reloadAfterConflict() {
	replaceConflict.value = false
	await loadSelectedAssetDetail()
}

async function handleCreateAsset() {
	if (readOnly) return
	if (!newFileBase64.value) {
		createError.value = describeFetchError(undefined, t('assets.validation.fileNotReady'))
		return
	}
	creating.value = true
	createError.value = undefined

	try {
		const res = await $fetch<{ status: string; key: string }>('/api/assets', {
			method: 'POST',
			body: {
				name: createState.name.trim(),
				contentFilename: createState.filename.trim(),
				mediaType: createState.mediaType.trim() || 'application/octet-stream',
				contentBase64: newFileBase64.value,
			},
		})
		const createdName = createState.name.trim()
		isCreatingAsset.value = false
		createState.file = null
		createState.name = ''
		createState.filename = ''
		createState.mediaType = ''
		newFileBase64.value = ''
		feedback.success(t('assets.created', { name: createdName }))
		emit('changed')
		await fetchAssets()
		if (res.key) await selectAsset(res.key)
	}
	catch (err: unknown) {
		createError.value = feedback.error(err, t('assets.createFailed'))
	}
	finally {
		creating.value = false
	}
}

async function handleReplaceAsset() {
	if (readOnly) return
	if (!selectedAssetData.value) return
	if (!replaceFileBase64.value) {
		replaceError.value = describeFetchError(undefined, t('assets.validation.fileNotReady'))
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
				contentFilename: replaceState.filename.trim(),
				mediaType: replaceState.mediaType.trim() || 'application/octet-stream',
				contentBase64: replaceFileBase64.value,
			},
		})
		isReplacing.value = false
		replaceState.file = null
		replaceFileBase64.value = ''
		feedback.success(t('assets.replaced'))
		emit('changed')
		await fetchAssets()
	}
	catch (err: unknown) {
		const details = describeFetchError(err, t('assets.replaceFailed'))
		if (details.statusCode === 409 || details.status === 'conflict') {
			replaceConflict.value = true
		}
		else {
			replaceError.value = feedback.error(err, t('assets.replaceFailed'))
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
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden text-xs text-default">
    <!-- Header -->
    <div class="flex items-center justify-between gap-2 border-b border-default p-3">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold text-highlighted">
          {{ t('assets.title') }}
        </h2>
        <p class="text-xs text-muted">
          {{ t('assets.subtitle') }}
        </p>
      </div>
      <UButton
        v-if="!readOnly"
        color="primary"
        variant="solid"
        size="xs"
        icon="i-lucide-plus"
        @click="openCreate"
      >
        {{ t('assets.newAsset') }}
      </UButton>
    </div>

    <!-- List load failure -->
    <div
      v-if="listError"
      class="border-b border-default p-2"
    >
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('assets.loadListFailed')"
        :description="listError.message"
        :actions="[{ label: t('common.retry'), color: 'error', variant: 'outline', size: 'xs', icon: 'i-lucide-refresh-cw', onClick: () => fetchAssets() }]"
      />
    </div>

    <!-- Assets List -->
    <div class="border-b border-default p-2">
      <UListbox
        v-if="assetItems.length"
        :model-value="selectedAssetId || undefined"
        :items="assetItems"
        value-key="value"
        size="sm"
        :aria-label="t('assets.listLabel')"
        :ui="{
          content: 'max-h-44',
          item: 'data-[state=checked]:text-selection data-[state=checked]:before:bg-selection-subtle',
          itemLabel: 'font-medium',
          itemDescription: 'font-mono text-xs',
        }"
        @update:model-value="onSelectAsset"
      >
        <template #item-trailing="{ item }">
          <UBadge
            v-if="item.diagnosticCount"
            color="warning"
            variant="subtle"
            size="xs"
            icon="i-lucide-triangle-alert"
            :aria-label="t('assets.diagnosticCount', item.diagnosticCount)"
          >
            {{ fmt.number(item.diagnosticCount) }}
          </UBadge>
        </template>
      </UListbox>
      <UEmpty
        v-else-if="!loadingList && !listError"
        size="sm"
        variant="naked"
        icon="i-lucide-image"
        :title="t('assets.emptyTitle')"
        :description="readOnly ? t('assets.emptyDescriptionReadOnly') : t('assets.emptyDescription')"
      />
      <UEmpty
        v-else-if="loadingList"
        size="sm"
        variant="naked"
        loading
        :title="t('common.loading')"
      />
    </div>

    <!-- Detail load failure -->
    <div
      v-if="detailError"
      class="p-3"
    >
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('assets.loadDetailFailed')"
        :description="detailError.message"
        :actions="[{ label: t('common.retry'), color: 'error', variant: 'outline', size: 'xs', icon: 'i-lucide-refresh-cw', onClick: () => loadSelectedAssetDetail() }]"
      />
    </div>

    <!-- Active Asset Details -->
    <div
      v-if="selectedAssetData"
      class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
    >
      <!-- Meta overview -->
      <UCard
        variant="subtle"
        :ui="{ header: 'p-3 sm:px-3', body: 'p-3 sm:p-3' }"
      >
        <template #header>
          <div class="flex items-center justify-between gap-2">
            <span class="truncate font-semibold text-highlighted">{{ selectedAssetData.resource.metadata?.name || t('assets.unnamedAsset') }}</span>
            <UTooltip :text="selectedAssetData.revision">
              <UBadge
                color="neutral"
                variant="subtle"
                size="xs"
                class="shrink-0 font-mono"
              >
                {{ t('common.revision') }} {{ selectedAssetData.revision.slice(0, 12) }}…
              </UBadge>
            </UTooltip>
          </div>
        </template>

        <!-- Definition list of metadata: no Nuxt UI component renders key/value pairs. -->
        <dl class="grid grid-cols-2 gap-2 text-xs">
          <div class="min-w-0">
            <dt class="text-muted">
              {{ t('assets.fields.filename') }}
            </dt>
            <dd class="truncate font-mono text-default">
              {{ selectedAssetData.resource.metadata?.contentFilename || t('assets.notSet') }}
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-muted">
              {{ t('assets.fields.mediaType') }}
            </dt>
            <dd class="truncate font-mono text-default">
              {{ selectedAssetData.resource.content?.mediaType || t('assets.notSet') }}
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-muted">
              {{ t('assets.fields.size') }}
            </dt>
            <dd class="font-mono text-default">
              {{ fmt.bytes(selectedAssetData.resource.content?.size ?? 0) }}
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-muted">
              {{ t('assets.fields.digest') }}
            </dt>
            <dd
              class="truncate font-mono text-xs text-muted"
              :title="selectedAssetData.resource.content?.digest"
            >
              {{ selectedAssetData.resource.content?.digest ? selectedAssetData.resource.content.digest.slice(0, 18) + '…' : t('assets.notSet') }}
            </dd>
          </div>
        </dl>
      </UCard>

      <!-- Content diagnostics (missing / ambiguous content) -->
      <div
        v-if="selectedAssetData.diagnostics?.length"
        class="flex flex-col gap-1.5"
      >
        <UAlert
          v-for="diag in selectedAssetData.diagnostics"
          :key="diag.code + diag.path"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="diag.code"
          :ui="{ title: 'font-mono text-xs', description: 'text-xs' }"
        >
          <template #description>
            <span class="block font-mono text-xs text-muted">{{ diag.path }}</span>
            <span class="mt-1 block text-xs leading-relaxed text-default">{{ diag.message }}</span>
          </template>
        </UAlert>
      </div>

      <!-- Preview image when renderable: a thumbnail <img> has no Nuxt UI equivalent. -->
      <UCard
        v-if="isRenderableMedia"
        variant="outline"
        :ui="{ header: 'p-2 sm:px-3', body: 'p-2 sm:p-2' }"
      >
        <template #header>
          <span class="font-medium text-muted">{{ t('assets.preview') }}</span>
        </template>
        <div class="flex max-h-48 items-center justify-center overflow-hidden rounded bg-muted bg-[radial-gradient(var(--ui-border-accented)_1px,transparent_1px)] [background-size:12px_12px] p-2">
          <img
            :src="selectedAssetContentUrl"
            :alt="selectedAssetData.resource.metadata?.name || t('assets.previewAlt')"
            class="max-h-44 max-w-full rounded object-contain shadow"
          >
        </div>
      </UCard>

      <!-- Non-renderable binary notice -->
      <UEmpty
        v-else
        size="sm"
        variant="outline"
        icon="i-lucide-file"
        :title="t('assets.noPreviewTitle')"
        :description="t('assets.noPreviewDescription', { mediaType: selectedMediaType || t('assets.notSet') })"
      />

      <!-- Actions -->
      <USeparator />
      <div class="flex flex-wrap items-center justify-between gap-2">
        <UButton
          :to="selectedAssetContentUrl"
          external
          :download="selectedAssetData.resource.metadata?.contentFilename || 'content.bin'"
          color="neutral"
          variant="outline"
          size="xs"
          icon="i-lucide-download"
        >
          {{ t('assets.download') }}
        </UButton>
        <UButton
          v-if="!readOnly"
          color="neutral"
          variant="outline"
          size="xs"
          icon="i-lucide-replace"
          @click="openReplace"
        >
          {{ t('assets.replaceContent') }}
        </UButton>
      </div>
    </div>

    <!-- Empty detail state -->
    <div
      v-else-if="!loadingList && !detailError && assetItems.length"
      class="flex flex-1 items-center justify-center p-6"
    >
      <UEmpty
        size="sm"
        variant="naked"
        icon="i-lucide-mouse-pointer-click"
        :title="t('assets.selectPrompt')"
        :loading="loadingDetail"
      />
    </div>

    <!-- Create asset modal -->
    <UModal
      v-if="!readOnly"
      v-model:open="isCreatingAsset"
      :title="t('assets.createTitle')"
      :description="t('assets.createDescription')"
    >
      <template #body>
        <UForm
          :state="createState"
          :validate="validateCreate"
          class="flex flex-col gap-3"
          @submit="handleCreateAsset"
        >
          <UFormField
            name="file"
            :label="t('assets.fields.file')"
            required
          >
            <UFileUpload
              v-model="createState.file"
              size="sm"
              icon="i-lucide-upload"
              :label="t('assets.fileUploadLabel')"
              :description="t('assets.fileUploadDescription')"
              class="w-full"
            />
          </UFormField>
          <UFormField
            name="name"
            :label="t('assets.fields.name')"
            required
          >
            <UInput
              v-model="createState.name"
              size="sm"
              :placeholder="t('assets.placeholders.name')"
              class="w-full"
            />
          </UFormField>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <UFormField
              name="filename"
              :label="t('assets.fields.filename')"
              required
            >
              <UInput
                v-model="createState.filename"
                size="sm"
                placeholder="logo.svg"
                class="w-full font-mono"
              />
            </UFormField>
            <UFormField
              name="mediaType"
              :label="t('assets.fields.mediaType')"
              :help="t('assets.mediaTypeHelp')"
            >
              <UInput
                v-model="createState.mediaType"
                size="sm"
                placeholder="image/svg+xml"
                class="w-full font-mono"
              />
            </UFormField>
          </div>

          <UAlert
            v-if="createError"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            :title="t('assets.createFailed')"
            :description="createError.message"
          >
            <template
              v-if="createError.diagnostics.length"
              #description
            >
              <p>{{ createError.message }}</p>
              <ul class="mt-1 list-disc ps-4">
                <li
                  v-for="(diag, index) in createError.diagnostics"
                  :key="index"
                >
                  <span
                    v-if="diag.path"
                    class="font-mono"
                  >{{ diag.path }}: </span>{{ diag.message }}
                </li>
              </ul>
            </template>
          </UAlert>

          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              @click="isCreatingAsset = false"
            >
              {{ t('common.cancel') }}
            </UButton>
            <UButton
              type="submit"
              color="primary"
              variant="solid"
              size="sm"
              :loading="creating"
            >
              {{ t('assets.saveAsset') }}
            </UButton>
          </div>
        </UForm>
      </template>
    </UModal>

    <!-- Replace content modal -->
    <UModal
      v-if="!readOnly && selectedAssetData"
      v-model:open="isReplacing"
      :title="t('assets.replaceTitle')"
      :description="t('assets.replaceDescription', { name: selectedAssetData.resource.metadata?.name || t('assets.unnamedAsset') })"
    >
      <template #body>
        <UForm
          :state="replaceState"
          :validate="validateReplace"
          class="flex flex-col gap-3"
          @submit="handleReplaceAsset"
        >
          <UAlert
            v-if="replaceConflict"
            color="error"
            variant="subtle"
            icon="i-lucide-git-compare"
            :title="t('assets.conflictTitle')"
            :description="t('assets.conflictDescription')"
            :actions="[{ label: t('common.reload'), color: 'error', variant: 'outline', size: 'xs', icon: 'i-lucide-refresh-cw', onClick: () => reloadAfterConflict() }]"
          />

          <UFormField
            name="file"
            :label="t('assets.fields.replacementFile')"
            required
          >
            <UFileUpload
              v-model="replaceState.file"
              size="sm"
              icon="i-lucide-upload"
              :label="t('assets.fileUploadLabel')"
              :description="t('assets.fileUploadDescription')"
              class="w-full"
            />
          </UFormField>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <UFormField
              name="filename"
              :label="t('assets.fields.filename')"
            >
              <UInput
                v-model="replaceState.filename"
                size="sm"
                class="w-full font-mono"
              />
            </UFormField>
            <UFormField
              name="mediaType"
              :label="t('assets.fields.mediaType')"
              :help="t('assets.mediaTypeHelp')"
            >
              <UInput
                v-model="replaceState.mediaType"
                size="sm"
                class="w-full font-mono"
              />
            </UFormField>
          </div>

          <UAlert
            v-if="replaceError"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            :title="t('assets.replaceFailed')"
            :description="replaceError.message"
          >
            <template
              v-if="replaceError.diagnostics.length"
              #description
            >
              <p>{{ replaceError.message }}</p>
              <ul class="mt-1 list-disc ps-4">
                <li
                  v-for="(diag, index) in replaceError.diagnostics"
                  :key="index"
                >
                  <span
                    v-if="diag.path"
                    class="font-mono"
                  >{{ diag.path }}: </span>{{ diag.message }}
                </li>
              </ul>
            </template>
          </UAlert>

          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              @click="isReplacing = false"
            >
              {{ t('common.cancel') }}
            </UButton>
            <UButton
              type="submit"
              color="primary"
              variant="solid"
              size="sm"
              :loading="replacing"
              :disabled="replaceConflict"
            >
              {{ t('assets.commitReplacement') }}
            </UButton>
          </div>
        </UForm>
      </template>
    </UModal>
  </div>
</template>
