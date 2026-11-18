<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '#imports'
import { CHANGE_ICONS, useChangeLabels } from '../../composables/useChangeLabels'
import { useGitChanges, type ChangesResource } from '../../composables/useGitChanges'
import { useWorkbench } from '../../composables/useWorkbench'
import { sameResource } from '../../utils/changes'
import ChangedResource from './ChangedResource.vue'
import KitButton from '~/components/kit/ui/Button.vue'
import KitIcon from '~/components/kit/ui/Icon.vue'
import KitSkeleton from '~/components/kit/ui/Skeleton.vue'

/**
 * The read-only view of the changes since a Git base (Feature 01a1ece7-8d4e-763c-8897-2c35ef129a4d):
 * each canonical resource added, changed or removed since the base, a toggle between `HEAD` and the
 * merge base with the default branch, and, for the selected resource, its semantic differences. It
 * offers no action that writes, restores or reverts a resource. It is shown in Overview's Activity tab
 * for the whole Workspace and in a View's history panel for that View (Rules
 * 01a11a5e-1946-7217-aff5-db13df3a2977 and 01a11a5e-1aa5-7d13-939a-8d99245f7906).
 *
 * The base and the selection are view state: they are not in the address and nothing is stored.
 */
const props = withDefaults(defineProps<{
	/** Only this resource's change is listed (the View page's panel lists its View). */
	resource?: ChangesResource
	enabled?: boolean
	/** The heading level of the title: the page's own heading is one above it. */
	headingTag?: 'h2' | 'h3'
}>(), { resource: undefined, enabled: true, headingTag: 'h3' })

const { t, te } = useI18n()
const labels = useChangeLabels()
const { views, flows, workspace, localeRevisions } = useWorkbench()
const changes = useGitChanges({ resource: () => props.resource, enabled: () => props.enabled })

const listing = changes.listing
const listed = computed(() => listing.value?.status === 'listed' ? listing.value : undefined)
const unavailable = computed(() => listing.value?.status === 'unavailable' ? listing.value : undefined)
/** The sentence of the code in the Workbench language; the server's own message when this build has none. */
const unavailableText = computed(() => unavailable.value ? (te(`diagnostics.${unavailable.value.code}`) ? t(`diagnostics.${unavailable.value.code}`) : unavailable.value.message) : '')
const defaultBranch = computed(() => changes.mergeBase.value?.defaultBranch)
const mergeBaseAvailable = computed(() => changes.mergeBase.value?.available === true)

/** Every revision the Workbench has read, so a shown diff is read again when the working tree changes. */
const refreshKey = computed(() => [
	changes.effectiveBase.value,
	workspace.value?.revision ?? '',
	...views.value.map(view => view.revision),
	...flows.value.map(flow => flow.revision),
	...Object.values(localeRevisions.value),
].join(','))

const selected = ref<ChangesResource>()
watch(() => changes.changes.value, (rows) => {
	if (!rows.some(row => sameResource(row, selected.value))) selected.value = rows[0] ? { kind: rows[0].kind, key: rows[0].key } : undefined
}, { immediate: true })
const selectedRow = computed(() => changes.changes.value.find(row => sameResource(row, selected.value)))

function choose(base: 'head' | 'merge-base'): void {
	changes.requested.value = base
}

const empty = computed(() => !!listed.value && changes.changes.value.length === 0)
</script>

<template>
  <section
    class="space-y-4"
    :aria-label="t('history.changes.title')"
    data-changes-since
    :aria-busy="changes.loading.value && !listing || undefined"
  >
    <component
      :is="headingTag"
      class="text-sm font-semibold text-highlighted"
    >
      {{ t('history.changes.title') }}
    </component>

    <div class="space-y-2">
      <div class="flex flex-wrap items-center gap-2">
        <span
          :id="`changes-base-${headingTag}`"
          class="text-xs font-medium text-muted"
        >{{ t('history.compare.against') }}</span>
        <div
          role="group"
          :aria-label="t('history.changes.baseLabel')"
          class="flex flex-wrap items-center gap-1.5"
          data-changes-base
        >
          <KitButton
            size="xs"
            variant="outline"
            :pressed="changes.effectiveBase.value === 'head'"
            :label="t('history.changes.baseHead')"
            data-changes-base-option="head"
            @click="choose('head')"
          />
          <KitButton
            size="xs"
            variant="outline"
            :pressed="changes.effectiveBase.value === 'merge-base'"
            :disabled="!mergeBaseAvailable"
            data-changes-base-option="merge-base"
            @click="choose('merge-base')"
          >
            <!-- The branch name is Workspace content: it stays as written. -->
            <i18n-t
              keypath="history.changes.baseMergeBase"
              tag="span"
              scope="global"
            >
              <template #branch>
                <code
                  class="font-mono"
                  translate="no"
                >{{ defaultBranch ?? '…' }}</code>
              </template>
            </i18n-t>
          </KitButton>
        </div>
      </div>
      <p
        v-if="listing && !mergeBaseAvailable"
        class="flex items-start gap-1.5 text-xs text-muted"
        data-changes-no-default-branch
      >
        <KitIcon
          name="info"
          class="mt-0.5 shrink-0"
          :size="14"
        />{{ t('history.changes.noDefaultBranch') }}
      </p>
      <p
        v-else-if="listed"
        class="text-xs text-muted"
        data-changes-base-note
      >
        <i18n-t
          v-if="listed.base.base === 'merge-base'"
          keypath="history.changes.mergeBaseNote"
          tag="span"
          scope="global"
        >
          <template #branch>
            <code
              class="font-mono"
              translate="no"
            >{{ defaultBranch ?? '' }}</code>
          </template>
        </i18n-t>
        <template v-else>
          {{ t('history.changes.headNote') }}
        </template>
        <code
          class="font-mono"
          translate="no"
        >{{ t('history.changes.baseCommit', { commit: listed.base.commit }) }}</code>
      </p>
      <p class="flex items-start gap-1.5 text-xs text-muted">
        <KitIcon
          name="lock"
          class="mt-0.5 shrink-0"
          :size="14"
        />{{ t('history.changes.readOnly') }}
      </p>
    </div>

    <UAlert
      v-if="changes.error.value && !listing"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="changes.error.value.message"
      :actions="[{ label: t('common.retry'), size: 'xs', color: 'error', variant: 'outline', onClick: () => { void changes.load() } }]"
      data-changes-failed
    />
    <UAlert
      v-else-if="unavailable"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('history.changes.unavailableTitle')"
      :description="unavailableText"
      :actions="[{ label: t('common.retry'), size: 'xs', color: 'warning', variant: 'outline', onClick: () => { void changes.load() } }]"
      role="alert"
      data-changes-unavailable
    />
    <div
      v-else-if="!listing"
      class="space-y-2"
    >
      <KitSkeleton
        v-for="index in 3"
        :key="index"
        class="wb-skeleton animate-pulse"
        :height="32"
        :radius="6"
        :label="t('common.loading')"
      />
    </div>
    <p
      v-else-if="empty"
      class="text-sm text-muted"
      data-changes-empty
    >
      {{ resource ? t('history.changes.viewEmpty') : t('history.changes.empty') }}
    </p>

    <template v-if="listed && !empty">
      <section
        class="space-y-2"
        :aria-label="t('history.compare.summary')"
        data-changes-summary
      >
        <h4 class="flex flex-wrap items-baseline gap-x-2 text-xs font-medium text-muted">
          {{ t('history.compare.summary') }}
          <span class="font-normal">{{ t('history.compare.changedCount', changes.changes.value.length) }}</span>
        </h4>
        <ul class="divide-y divide-(--ui-border) rounded-lg border border-default">
          <li
            v-for="row in changes.changes.value"
            :key="`${row.kind}:${row.key}`"
            :data-summary-row="`${row.kind}:${row.key}`"
            :data-status="row.status"
          >
            <button
              type="button"
              class="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-start text-sm hover:bg-muted pointer-coarse:min-h-11"
              :class="sameResource(row, selected) ? 'bg-elevated' : ''"
              :aria-pressed="sameResource(row, selected)"
              :aria-label="t('history.changes.select', { name: labels.resourceName(row) })"
              @click="selected = { kind: row.kind, key: row.key }"
            >
              <KitIcon
                :name="CHANGE_ICONS[row.status]!"
                class="shrink-0 text-muted"
                :size="16"
              />
              <span class="w-20 shrink-0 text-xs text-muted">{{ t(`history.compare.status.${row.status}`) }}</span>
              <span class="shrink-0 text-xs text-muted">{{ labels.kindLabel(row.kind) }}</span>
              <span class="min-w-0 flex-1 truncate text-default">{{ labels.resourceName(row) }}</span>
            </button>
          </li>
        </ul>
      </section>

      <ChangedResource
        v-if="selectedRow"
        :key="`${listed.base.base}:${selectedRow.kind}:${selectedRow.key}`"
        :row="selectedRow"
        :base="listed.base.base"
        :refresh-key="refreshKey"
      />
    </template>
  </section>
</template>
