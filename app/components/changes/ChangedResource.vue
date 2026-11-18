<script setup lang="ts">
import { computed, shallowRef, useId, watch } from 'vue'
import { useI18n } from '#imports'
import type { ChangeBase, ChangeDiffOutcome, ChangedResource as ChangedResourceRow } from '../../../src/application/services/git-changes'
import { CHANGE_ICONS, useChangeLabels } from '../../composables/useChangeLabels'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { describeFetchError, type FetchErrorDetails } from '../../utils/fetch-error'
import ResourceDiff from './ResourceDiff.vue'
import KitIcon from '~/components/kit/ui/Icon.vue'
import KitSkeleton from '~/components/kit/ui/Skeleton.vue'
import WbErrorDescription from '../workbench/WbErrorDescription.vue'

/**
 * The semantic differences of one selected changed resource (Rule 01a1ece7-8f2f-7565-a11f-6d5ac9b5bab3):
 * its heading and, read for this resource alone (`GET /api/changes/diff`), what changed in it between
 * the base and the working tree. It offers no action that writes, restores or reverts the resource
 * (Rule 01a1ece7-91a3-709c-830d-42ff0393217a).
 */
const props = defineProps<{
	row: ChangedResourceRow
	base: ChangeBase
	/** Changes when the base or the Workspace changes, so the shown diff is read again. */
	refreshKey?: string
}>()

const { t, te } = useI18n()
const labels = useChangeLabels()
const uiux = useUiuxClient()
const panelId = useId()

const name = computed(() => labels.resourceName(props.row))
const outcome = shallowRef<ChangeDiffOutcome>()
const error = shallowRef<FetchErrorDetails>()
let generation = 0

async function load(): Promise<void> {
	const current = ++generation
	try {
		const read = await $fetch<ChangeDiffOutcome>('/api/changes/diff', { query: { base: props.base, kind: props.row.kind, key: props.row.key }, cache: 'no-store', ignoreResponseError: true })
		if (current !== generation) return
		outcome.value = read
		error.value = undefined
	}
	catch (cause) {
		if (current === generation) error.value = describeFetchError(cause, t('history.changes.diffFailed'))
	}
}
watch(() => [props.base, props.row.kind, props.row.key, props.row.status, props.refreshKey], () => { void load() }, { immediate: true })

const compared = computed(() => outcome.value?.status === 'compared' ? outcome.value : undefined)
/** The Asset's current content digest: an image of either side with this digest is its current content. */
const assetRead = shallowRef(false)
const assetDigest = shallowRef<string>()
const currentAsset = computed(() => props.row.kind === 'asset' && assetRead.value ? { url: uiux.assetUrl(props.row.key), ...(assetDigest.value ? { digest: assetDigest.value } : {}) } : undefined)
watch(() => props.row.kind === 'asset' ? props.row.key : undefined, async (key) => {
	assetDigest.value = undefined
	assetRead.value = false
	if (!key) return
	const read = await uiux.readResource<{ resource: { content?: { digest?: string } } }>('asset', key).catch(() => undefined)
	assetDigest.value = read?.resource.content?.digest
	assetRead.value = true
}, { immediate: true })
</script>

<template>
  <article
    class="space-y-2 border-t border-default pt-3"
    :data-resource-diff="`${row.kind}:${row.key}`"
    data-open
  >
    <h4 class="flex min-w-0 items-center gap-x-1.5 text-sm">
      <KitIcon
        :name="CHANGE_ICONS[row.status]!"
        class="shrink-0 text-muted"
        :size="16"
      />
      <span class="shrink-0 text-xs text-muted">{{ t(`history.compare.status.${row.status}`) }}</span>
      <span class="shrink-0 text-xs text-muted">{{ labels.kindLabel(row.kind) }}</span>
      <span class="min-w-0 truncate font-medium text-highlighted">{{ name }}</span>
    </h4>
    <div
      :id="panelId"
      class="space-y-2"
    >
      <UAlert
        v-if="error || (outcome && outcome.status !== 'compared')"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="error?.message ?? t('history.changes.diffFailed')"
        :actions="[{ label: t('common.retry'), size: 'xs', color: 'error', variant: 'outline', onClick: () => { void load() } }]"
      >
        <template #description>
          <WbErrorDescription
            v-if="error"
            :headline="error.message"
            :diagnostics="error.diagnostics"
            :status-code="error.statusCode"
          />
          <span v-else-if="outcome && outcome.status !== 'compared'">{{ te(`diagnostics.${outcome.code}`) ? t(`diagnostics.${outcome.code}`) : outcome.message }}</span>
        </template>
      </UAlert>
      <KitSkeleton
        v-else-if="!compared || (row.kind === 'asset' && !currentAsset)"
        class="wb-skeleton animate-pulse"
        :height="48"
        :radius="6"
        :label="t('common.loading')"
      />
      <ResourceDiff
        v-else
        :diff="compared.diff"
        :name="name"
        :asset-key="row.key"
        :base="base"
        :current-image="currentAsset"
      />
    </div>
  </article>
</template>
