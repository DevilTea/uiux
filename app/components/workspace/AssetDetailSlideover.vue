<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n, useToast } from '#imports'
import { useWorkbenchFeedback } from '../../composables/useWorkbenchFeedback'
import { useWorkbenchFormat } from '../../composables/useWorkbenchFormat'
import { describeFetchError, isLockedError, type FetchErrorDetails, type FetchErrorLock } from '../../utils/fetch-error'
import { viewPath } from '../../utils/workbench-routes'
import { blobToBase64, isImageMediaType } from '../../utils/workspace-authoring'
import type { AssetEntry } from './asset-types'
import AuthoringConflictAlert from './AuthoringConflictAlert.vue'
import LockBadge from '../workbench/LockBadge.vue'
import LockedSaveAlert from '../workbench/LockedSaveAlert.vue'
import AuthoringErrorAlert from './AuthoringErrorAlert.vue'
import AuthoringSaveBar from './AuthoringSaveBar.vue'
import { focusFirstProblem } from '../../utils/focus-problem'
import { diagnosticText } from '../../utils/diagnostic-copy'

/**
 * One Asset (brief g): preview, metadata, "Replace content…", the Views that bind it, and its
 * diagnostics. Both metadata edits and content replacement go through the Asset replace
 * operation (`PUT /api/assets/:id`) with the Asset's `expectedRevision`; a metadata-only edit
 * resends the current bytes unchanged. Unused Assets are listed, never removed (Part 9 #6).
 */
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{
	entry: AssetEntry
	canEdit: boolean
	/** Where the Asset's bytes are read and its image is shown from. */
	contentUrl: string
	/** Where the Asset downloads from; a publication may offer a different address than `contentUrl`. */
	downloadUrl: string
	/** Re-reads this Asset from the server: the newer version after a conflict. */
	reread: (key: string) => Promise<AssetEntry | undefined>
}>()
const emit = defineEmits<{ changed: [key: string] }>()
const { t } = useI18n()
const toast = useToast()
const feedback = useWorkbenchFeedback()
const fmt = useWorkbenchFormat()

const form = reactive({ name: '', contentFilename: '', mediaType: '' })
const base = ref({ revision: '', name: '', contentFilename: '', mediaType: '' })
const replacement = ref<File | null>(null)
const saving = ref(false)
const conflict = ref(false)
const theirs = ref<{ name: string; contentFilename: string; mediaType: string }>()
const error = ref<FetchErrorDetails>()
/** A save refused by someone else's edit lease (`423 resource.locked`); the form keeps the draft. */
const locked = ref<Readonly<{ lock?: FetchErrorLock }>>()

function adopt(entry: AssetEntry): void {
	base.value = { revision: entry.revision, name: entry.name, contentFilename: entry.contentFilename, mediaType: entry.mediaType }
	form.name = entry.name
	form.contentFilename = entry.contentFilename
	form.mediaType = entry.mediaType
	replacement.value = null
	conflict.value = false
	theirs.value = undefined
	error.value = undefined
	locked.value = undefined
}

watch(() => props.entry.key, () => adopt(props.entry), { immediate: true })
watch(() => props.entry.revision, (revision) => {
	if (!dirty.value && !conflict.value && revision !== base.value.revision) adopt(props.entry)
})

watch(replacement, (file) => {
	if (!file) return
	form.contentFilename = file.name
	form.mediaType = file.type || 'application/octet-stream'
})

const metadataChanges = computed(() => (['name', 'contentFilename', 'mediaType'] as const).filter(field => form[field].trim() !== base.value[field]).length)
const dirty = computed(() => metadataChanges.value > 0 || !!replacement.value)
const changeCount = computed(() => metadataChanges.value + (replacement.value ? 1 : 0))
const filenameInvalid = computed(() => !form.contentFilename.trim() || /[/\\]/u.test(form.contentFilename))
const invalid = computed(() => !form.name.trim() || filenameInvalid.value)

const isImage = computed(() => isImageMediaType(props.entry.mediaType))

async function save(): Promise<void> {
	if (!props.canEdit || saving.value || conflict.value || !dirty.value || invalid.value) return
	saving.value = true
	error.value = undefined
	locked.value = undefined
	try {
		const bytes: Blob = replacement.value ? replacement.value : await fetch(props.contentUrl, { credentials: 'same-origin' }).then((response) => {
			if (!response.ok) throw new Error(t('assets.contentUnreadable'))
			return response.blob()
		})
		await $fetch(`/api/assets/${encodeURIComponent(props.entry.key)}`, {
			method: 'PUT',
			body: {
				expectedRevision: base.value.revision,
				name: form.name.trim(),
				contentFilename: form.contentFilename.trim(),
				mediaType: form.mediaType.trim() || 'application/octet-stream',
				contentBase64: await blobToBase64(bytes),
			},
		})
		feedback.success(replacement.value ? t('assets.replaced') : t('assets.metadataSaved'))
		const latest = await props.reread(props.entry.key).catch(() => undefined)
		if (latest) adopt(latest)
		else replacement.value = null
		emit('changed', props.entry.key)
	}
	catch (cause) {
		const details = describeFetchError(cause, t('assets.saveFailed'))
		if (details.statusCode === 409 || details.status === 'conflict') {
			conflict.value = true
			const latest = await props.reread(props.entry.key).catch(() => undefined)
			if (latest) theirs.value = { name: latest.name, contentFilename: latest.contentFilename, mediaType: latest.mediaType }
		}
		else if (isLockedError(details)) {
			locked.value = { lock: details.lock }
		}
		else {
			error.value = details
		}
		void focusFirstProblem('[role="dialog"]')
	}
	finally {
		saving.value = false
	}
}

async function reloadTheirs(): Promise<void> {
	const latest = await props.reread(props.entry.key).catch(() => undefined)
	if (latest) adopt(latest)
	emit('changed', props.entry.key)
}

async function keepMine(): Promise<void> {
	const latest = await props.reread(props.entry.key).catch(() => undefined)
	if (!latest) return
	base.value = { revision: latest.revision, name: latest.name, contentFilename: latest.contentFilename, mediaType: latest.mediaType }
	conflict.value = false
	theirs.value = undefined
}

function discard(): void {
	adopt(props.entry)
}

async function copy(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text)
		toast.add({ title: t('adapters.copied'), color: 'success', icon: 'i-lucide-check' })
	}
	catch {
		toast.add({ title: t('adapters.copyFailed'), color: 'error', icon: 'i-lucide-circle-alert', duration: 0 })
	}
}

function onKeydown(event: KeyboardEvent): void {
	if (!open.value || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
	event.preventDefault()
	void save()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

const details = computed(() => [
	{ label: t('assets.fields.id'), value: props.entry.key },
	{ label: t('common.revision'), value: props.entry.revision },
	...(props.entry.digest ? [{ label: t('assets.fields.digest'), value: props.entry.digest }] : []),
])
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="entry.name || t('assets.unnamedAsset')"
    :description="t('assets.detailDescription')"
    :ui="{ content: 'max-w-lg', body: 'flex flex-col gap-6' }"
  >
    <template #body>
      <LockBadge
        kind="asset"
        :resource-key="entry.key"
      />
      <LockedSaveAlert
        v-if="locked"
        :lock="locked.lock"
        @dismiss="locked = undefined"
      />
      <AuthoringConflictAlert
        v-if="conflict"
        :title="t('assets.conflictTitle')"
        :theirs="theirs ?? { name: base.name, contentFilename: base.contentFilename, mediaType: base.mediaType }"
        :yours="{ name: form.name.trim(), contentFilename: form.contentFilename.trim(), mediaType: form.mediaType.trim() }"
        @reload="reloadTheirs"
        @keep-mine="keepMine"
      />
      <AuthoringErrorAlert
        v-else-if="error"
        :title="t('assets.saveFailed')"
        :error="error"
        @close="error = undefined"
      />

      <div class="flex aspect-video items-center justify-center overflow-hidden rounded-lg border border-default bg-elevated p-4">
        <img
          v-if="isImage && contentUrl && !entry.diagnostics.length"
          :src="contentUrl"
          :alt="t('assets.previewAlt', { name: entry.name })"
          class="max-h-full max-w-full object-contain"
        >
        <div
          v-else
          class="flex flex-col items-center gap-2 text-center text-sm text-muted"
        >
          <UIcon
            :name="entry.diagnostics.length ? 'i-lucide-file-x-2' : 'i-lucide-file'"
            class="size-8"
          />
          <span>{{ entry.diagnostics.length ? t('assets.previewUnavailable') : t('assets.noPreviewDescription', { mediaType: entry.mediaType || t('assets.notSet') }) }}</span>
        </div>
      </div>

      <section
        v-if="entry.diagnostics.length"
        class="flex flex-col gap-2"
        :aria-label="t('assets.diagnosticsTitle')"
      >
        <UAlert
          v-for="diagnostic in entry.diagnostics"
          :key="diagnostic.code + diagnostic.path"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="diagnosticText(diagnostic)"
          :description="`${diagnostic.code} · ${diagnostic.path}`"
          :ui="{ description: 'font-mono text-xs' }"
        />
      </section>

      <section
        class="flex flex-col gap-3"
        aria-labelledby="asset-metadata-title"
      >
        <h3
          id="asset-metadata-title"
          class="text-title font-semibold text-highlighted"
        >
          {{ t('assets.metadata') }}
        </h3>
        <template v-if="canEdit">
          <UFormField
            :label="t('assets.fields.name')"
            :error="!form.name.trim() ? t('assets.validation.nameRequired') : undefined"
            required
          >
            <UInput
              v-model="form.name"
              class="w-full"
            />
          </UFormField>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <UFormField
              :label="t('assets.fields.filename')"
              :error="filenameInvalid ? t('assets.validation.filenameRequired') : undefined"
              required
            >
              <UInput
                v-model="form.contentFilename"
                class="w-full"
                :ui="{ base: 'font-mono' }"
              />
            </UFormField>
            <UFormField
              :label="t('assets.fields.mediaType')"
              :help="t('assets.mediaTypeHelp')"
            >
              <UInput
                v-model="form.mediaType"
                class="w-full"
                :ui="{ base: 'font-mono' }"
              />
            </UFormField>
          </div>
          <UFormField
            :label="t('assets.replace')"
            :help="t('assets.replaceHelp')"
          >
            <UFileUpload
              v-model="replacement"
              icon="i-lucide-replace"
              :label="t('assets.fileUploadLabel')"
              :description="t('assets.fileUploadDescription')"
              class="w-full"
            />
          </UFormField>
        </template>
        <dl
          v-else
          class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm"
        >
          <dt class="text-muted">
            {{ t('assets.fields.filename') }}
          </dt>
          <dd class="min-w-0 truncate font-mono text-xs leading-5">
            {{ entry.contentFilename || t('assets.notSet') }}
          </dd>
          <dt class="text-muted">
            {{ t('assets.fields.mediaType') }}
          </dt>
          <dd class="min-w-0 truncate font-mono text-xs leading-5">
            {{ entry.mediaType || t('assets.notSet') }}
          </dd>
          <dt class="text-muted">
            {{ t('assets.fields.size') }}
          </dt>
          <dd class="font-mono text-xs leading-5">
            {{ entry.size !== undefined ? fmt.bytes(entry.size) : t('assets.notSet') }}
          </dd>
        </dl>
      </section>

      <section
        class="flex flex-col gap-2"
        aria-labelledby="asset-usage-title"
      >
        <h3
          id="asset-usage-title"
          class="text-title font-semibold text-highlighted"
        >
          {{ t('assets.usage') }}
        </h3>
        <ul
          v-if="entry.usedBy.length"
          class="flex flex-col gap-1"
        >
          <li
            v-for="use in entry.usedBy"
            :key="use.viewId"
          >
            <ULink
              :to="viewPath(use.viewId)"
              class="inline-flex items-center gap-1.5 text-sm text-default hover:underline"
            >
              <UIcon
                name="i-lucide-app-window"
                class="size-4 text-muted"
              />{{ use.name }}
            </ULink>
          </li>
        </ul>
        <p
          v-else
          class="text-sm text-muted"
        >
          {{ t('assets.unusedDescription') }}
        </p>
      </section>

      <UCollapsible>
        <UButton
          color="neutral"
          variant="link"
          trailing-icon="i-lucide-chevron-down"
          class="px-0"
          :ui="{ trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform' }"
        >
          {{ t('assets.details') }}
        </UButton>
        <template #content>
          <dl class="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 pt-2 text-sm">
            <template
              v-for="item in details"
              :key="item.label"
            >
              <dt class="text-muted">
                {{ item.label }}
              </dt>
              <dd class="min-w-0 truncate font-mono text-xs">
                {{ item.value }}
              </dd>
              <UButton
                color="neutral"
                variant="ghost"
                size="sm"
                icon="i-lucide-copy"
                :aria-label="t('assets.copyValue', { label: item.label })"
                @click="copy(item.value)"
              />
            </template>
          </dl>
        </template>
      </UCollapsible>
    </template>

    <template #footer>
      <div class="flex w-full flex-col gap-3">
        <AuthoringSaveBar
          v-if="canEdit && dirty"
          :count="changeCount"
          :saving="saving"
          :disabled="conflict || invalid"
          :save-label="replacement ? t('assets.commitReplacement') : t('authoring.saveChanges')"
          @discard="discard"
          @save="save"
        />
        <div
          v-else
          class="flex justify-end"
        >
          <UButton
            v-if="downloadUrl"
            :to="downloadUrl"
            external
            :download="entry.contentFilename || 'content.bin'"
            icon="i-lucide-download"
          >
            {{ t('assets.download') }}
          </UButton>
        </div>
      </div>
    </template>
  </USlideover>
</template>
