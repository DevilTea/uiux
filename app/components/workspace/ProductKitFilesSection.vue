<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import { useI18n } from '#imports'
import { useWorkbenchFormat } from '../../composables/useWorkbenchFormat'
import { describeFetchError, type FetchErrorDetails } from '../../utils/fetch-error'
import { kitFileTree, kitPathAncestors, visibleKitTreeRows, type KitFileEntry } from '../../utils/kit-file-tree'
import { PRODUCT_KIT_PATH } from '../../utils/workbench-routes'

/**
 * The Files section of the Product Kit page (Rules 01a11bb1-b918-7cb5-b581-a3fd3f647f09 and
 * 01a11bb1-a184-7e00-a8de-c81056ad5a35): the kit project's files and build output, read-only, over
 * `GET /api/product-kit/files` and `GET /api/product-kit/file?path=`. Both need
 * `product-kit.source.read` (`canBrowse`); the server enforces it, the section only reflects it.
 *
 * A file's text is shown as text only: interpolated into a `<pre>`, never as HTML, never run or
 * previewed. A file whose bytes are not UTF-8 arrives as base64 and is described, not shown. A listing
 * cut at its entry limit says so (`truncated`), a file above the read limit (`kit.file_too_large`) and
 * a path that no longer names a regular file (`not_found`: removed, a link, or not a regular file)
 * each say so in the viewer.
 */
const props = defineProps<{ canBrowse: boolean }>()
const { t } = useI18n()
const format = useWorkbenchFormat()

// Untyped request helper: Nitro's typed-route inference overflows on this many routes.
const api = $fetch as unknown as <T = unknown>(url: string, options?: Readonly<Record<string, unknown>>) => Promise<T>

type Listing = Readonly<{ files: readonly KitFileEntry[]; truncated: boolean }>
const listing = shallowRef<Listing>()
const listingLoading = ref(false)
const listingError = shallowRef<FetchErrorDetails>()

async function loadListing(): Promise<void> {
	if (!props.canBrowse) return
	listingLoading.value = true
	try {
		listing.value = await api<Listing>('/api/product-kit/files')
		listingError.value = undefined
	}
	catch (cause) {
		listingError.value = describeFetchError(cause, t('productKit.files.listFailed'))
	}
	finally {
		listingLoading.value = false
	}
}

const tree = computed(() => kitFileTree(listing.value?.files ?? []))
const expanded = ref(new Set<string>())
const rows = computed(() => visibleKitTreeRows(tree.value, expanded.value))

function toggle(path: string): void {
	const next = new Set(expanded.value)
	if (next.has(path)) next.delete(path)
	else next.add(path)
	expanded.value = next
}

type FileRead =
	| Readonly<{ state: 'text'; path: string; size: number; digest: string; content: string }>
	| Readonly<{ state: 'binary'; path: string; size: number; digest: string }>
	| Readonly<{ state: 'too_large'; path: string; limit: number }>
	| Readonly<{ state: 'not_found'; path: string }>
	| Readonly<{ state: 'failed'; path: string; error: FetchErrorDetails }>

const selected = ref<string>()
const file = shallowRef<FileRead>()
const fileLoading = ref(false)
let request = 0

type FoundFile = Readonly<{ status: 'found'; path: string; size: number; digest: string; content: string; encoding?: 'base64' }>

async function open(path: string): Promise<void> {
	selected.value = path
	const ticket = ++request
	fileLoading.value = true
	let read: FileRead
	try {
		const found = await api<FoundFile>(`/api/product-kit/file?path=${encodeURIComponent(path)}`)
		read = found.encoding === 'base64'
			? { state: 'binary', path, size: found.size, digest: found.digest }
			: { state: 'text', path, size: found.size, digest: found.digest, content: found.content }
	}
	catch (cause) {
		const error = describeFetchError(cause, t('productKit.files.readFailed'))
		const body = (cause as { data?: { limit?: unknown } } | undefined)?.data
		if (error.code === 'kit.file_too_large')
			read = { state: 'too_large', path, limit: typeof body?.limit === 'number' ? body.limit : 8 * 1024 * 1024 }
		else if (error.statusCode === 404 || error.status === 'not_found')
			read = { state: 'not_found', path }
		else
			read = { state: 'failed', path, error }
	}
	if (ticket !== request) return
	file.value = read
	fileLoading.value = false
	const ancestors = kitPathAncestors(path)
	if (ancestors.some(ancestor => !expanded.value.has(ancestor))) expanded.value = new Set([...expanded.value, ...ancestors])
}

const buildLogLocation = { path: PRODUCT_KIT_PATH, query: { section: 'overview' }, hash: '#product-kit-build' }

onMounted(() => { void loadListing() })
</script>

<template>
  <section
    id="product-kit-files"
    aria-labelledby="product-kit-files-title"
    class="flex flex-col gap-4"
    data-product-kit-section="files"
  >
    <header class="flex items-start justify-between gap-4">
      <div class="min-w-0 space-y-1">
        <h2
          id="product-kit-files-title"
          tabindex="-1"
          class="text-title font-semibold text-highlighted focus:outline-none"
        >
          {{ t('productKit.files.title') }}
        </h2>
        <p class="text-sm text-muted">
          {{ t('productKit.files.description') }}
        </p>
      </div>
      <UButton
        v-if="canBrowse"
        color="neutral"
        variant="ghost"
        size="sm"
        icon="i-lucide-refresh-cw"
        class="shrink-0"
        :loading="listingLoading"
        data-kit-files-reload
        @click="loadListing"
      >
        {{ t('productKit.files.reload') }}
      </UButton>
    </header>

    <p
      v-if="!canBrowse"
      class="flex items-center gap-1.5 text-sm text-muted"
      data-access-notice="kit-files"
      data-missing-key="product-kit.source.read"
    >
      <UIcon
        name="i-lucide-user-lock"
        class="size-4 shrink-0"
      />
      {{ t('productKit.files.requiresKey', { key: 'product-kit.source.read' }) }}
    </p>
    <template v-else>
      <p class="text-xs text-muted">
        <i18n-t
          keypath="productKit.files.buildLog"
          tag="span"
          scope="global"
        >
          <template #link>
            <ULink
              :to="buildLogLocation"
              class="underline underline-offset-2"
              data-kit-files-build-log
            >
              {{ t('productKit.build.log') }}
            </ULink>
          </template>
        </i18n-t>
      </p>
      <UAlert
        v-if="listingError"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="t('productKit.files.listFailed')"
        :description="listingError.message"
        :actions="[{ label: t('common.retry'), color: 'neutral', variant: 'outline', onClick: () => { void loadListing() } }]"
        data-kit-files-error
      />
      <UAlert
        v-if="listing?.truncated"
        color="info"
        variant="subtle"
        icon="i-lucide-list-end"
        :title="t('productKit.files.truncated', { n: format.number(listing.files.length) }, listing.files.length)"
        :description="t('productKit.files.truncatedHelp')"
        data-kit-files-truncated
      />

      <div class="grid min-h-0 gap-4 lg:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)]">
        <nav
          class="max-h-[32rem] overflow-auto rounded-md border border-default p-1"
          :aria-label="t('productKit.files.tree')"
          data-kit-files-tree
        >
          <p
            v-if="listing && !listing.files.length"
            class="p-2 text-sm text-muted"
            data-kit-files-empty
          >
            {{ t('productKit.files.empty') }}
          </p>
          <USkeleton
            v-else-if="!listing && listingLoading"
            class="m-2 h-5 w-3/4"
            :aria-label="t('common.loading')"
          />
          <ul
            v-else
            class="flex flex-col"
          >
            <li
              v-for="row in rows"
              :key="row.node.path"
            >
              <button
                type="button"
                class="flex w-full items-center gap-1.5 rounded px-2 py-1 text-start font-mono text-xs hover:bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
                :class="row.node.path === selected ? 'bg-elevated text-highlighted' : 'text-default'"
                :style="{ paddingInlineStart: `${0.5 + (row.level - 1) * 0.875}rem` }"
                :aria-expanded="row.node.kind === 'directory' ? row.expanded : undefined"
                :aria-current="row.node.path === selected ? 'true' : undefined"
                :data-kit-file="row.node.kind === 'file' ? row.node.path : undefined"
                :data-kit-directory="row.node.kind === 'directory' ? row.node.path : undefined"
                translate="no"
                @click="row.node.kind === 'directory' ? toggle(row.node.path) : open(row.node.path)"
              >
                <UIcon
                  :name="row.node.kind === 'directory' ? (row.expanded ? 'i-lucide-folder-open' : 'i-lucide-folder') : 'i-lucide-file'"
                  class="size-3.5 shrink-0 text-muted"
                />
                <span class="min-w-0 truncate">{{ row.node.name }}</span>
              </button>
            </li>
          </ul>
        </nav>

        <div
          class="flex min-w-0 flex-col gap-2"
          data-kit-file-viewer
          aria-live="polite"
        >
          <p
            v-if="!selected"
            class="rounded-md border border-dashed border-default p-4 text-sm text-muted"
          >
            {{ t('productKit.files.pick') }}
          </p>
          <USkeleton
            v-else-if="fileLoading && !file"
            class="h-40 w-full"
            :aria-label="t('common.loading')"
          />
          <template v-else-if="file">
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <code
                class="font-mono text-xs break-all text-highlighted"
                data-kit-file-path
              >kit/{{ file.path }}</code>
              <span
                v-if="file.state === 'text' || file.state === 'binary'"
                class="text-xs text-muted"
              >{{ format.bytes(file.size) }}</span>
            </div>
            <pre
              v-if="file.state === 'text'"
              class="max-h-[32rem] overflow-auto rounded-md border border-default bg-muted p-3 font-mono text-xs whitespace-pre text-default"
              tabindex="0"
              :aria-label="t('productKit.files.content', { path: file.path })"
              translate="no"
              data-kit-file-content
            >{{ file.content }}</pre>
            <p
              v-else-if="file.state === 'binary'"
              class="text-sm text-muted"
              data-kit-file-binary
            >
              {{ t('productKit.files.binary') }}
            </p>
            <UAlert
              v-else-if="file.state === 'too_large'"
              color="info"
              variant="subtle"
              icon="i-lucide-file-warning"
              :title="t('productKit.files.tooLarge', { limit: format.bytes(file.limit) })"
              :description="t('productKit.files.tooLargeHelp')"
              data-kit-file-too-large
            />
            <UAlert
              v-else-if="file.state === 'not_found'"
              color="warning"
              variant="subtle"
              icon="i-lucide-file-x"
              :title="t('productKit.files.notFound')"
              :actions="[{ label: t('productKit.files.reload'), color: 'neutral', variant: 'outline', onClick: () => { void loadListing() } }]"
              data-kit-file-not-found
            />
            <UAlert
              v-else
              color="warning"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :title="t('productKit.files.readFailed')"
              :description="file.error.message"
              :actions="[{ label: t('common.retry'), color: 'neutral', variant: 'outline', onClick: () => { void open(file!.path) } }]"
              data-kit-file-error
            />
          </template>
        </div>
      </div>
    </template>
  </section>
</template>
