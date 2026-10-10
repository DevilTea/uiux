<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from '#imports'
import { versionBlobUrl } from '../../composables/useUiuxClient'
import { blobToDataUrl } from '../../utils/workspace-authoring'

/**
 * One side of an Asset image change, fetched by its content digest (Rule
 * 01a11a5e-10df-795e-8fbc-a99de09694a5: fetching by digest is the reader's concern). When the digest
 * is the Asset's current content, the Asset's content address serves it; otherwise the version blob
 * route does, which reads the host history store (an autosave's blobs) and then the artifact store
 * (member Checkpoints' blobs). A blob neither store keeps any more is shown as its digest with a note
 * instead of a broken image. The bytes are shown with the recorded media type, since the blob route
 * answers them untyped.
 *
 * The image is a `data:` URL, not an object URL: an object URL shares the Workbench origin, so
 * opening it on its own would show the stored markup (an SVG, say) as a Workbench document, while a
 * `data:` document has an opaque origin (and Chromium and Firefox refuse a page's own top-level
 * navigation to one).
 */
const props = defineProps<{ digest: string; mediaType: string; alt: string; current?: Readonly<{ digest?: string; url: string }> }>()
const { t } = useI18n()

const url = ref<string>()
const missing = ref(false)
/** Only the latest load may show its result; an earlier one still in flight is dropped. */
let generation = 0

async function fetchBlob(path: string): Promise<Blob | undefined> {
	const response = await fetch(path, { credentials: 'same-origin' })
	return response.ok ? await response.blob() : undefined
}

async function load(): Promise<void> {
	const current = ++generation
	url.value = undefined
	missing.value = false
	try {
		const blob = props.current?.digest === props.digest
			? await fetchBlob(props.current.url)
			: await fetchBlob(versionBlobUrl(props.digest))
		const dataUrl = blob ? await blobToDataUrl(new Blob([blob], { type: props.mediaType })) : undefined
		if (current !== generation) return
		if (dataUrl) url.value = dataUrl
		else missing.value = true
	}
	catch {
		if (current === generation) missing.value = true
	}
}

watch(() => [props.digest, props.current?.digest, props.current?.url], () => { void load() }, { immediate: true })
</script>

<template>
  <div
    class="flex min-h-24 items-center justify-center rounded-md border border-default bg-canvas p-2"
    :data-history-image="digest"
  >
    <img
      v-if="url"
      :src="url"
      :alt="alt"
      class="max-h-48 max-w-full object-contain"
    >
    <p
      v-else-if="missing"
      class="flex flex-col items-center gap-1 text-center text-xs text-muted"
    >
      <UIcon
        name="i-lucide-image-off"
        class="size-5"
      />
      {{ t('history.diff.imageUnavailable') }}
      <code
        class="font-mono break-all"
        translate="no"
      >{{ digest.slice(0, 19) }}…</code>
    </p>
    <USkeleton
      v-else
      class="h-24 w-full"
      :aria-label="t('common.loading')"
    />
  </div>
</template>
