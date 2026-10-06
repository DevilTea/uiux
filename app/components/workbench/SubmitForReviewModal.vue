<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from '#imports'
import { useReadiness, type EvidenceEntry } from '../../composables/useReadiness'
import { useWorkbench } from '../../composables/useWorkbench'
import type { FetchErrorDetails } from '../../utils/fetch-error'
import { isSubmittable, SUGGESTED_CHANGE_DOMAINS, type ReviewSubmissionDraft } from '../../utils/review-submission'
import { viewLocation } from '../../utils/workbench-routes'
import WbErrorDetails from './WbErrorDetails.vue'

/**
 * "Submit for review…" (brief c, section 12; roadmap R12): a human moves an open thread to
 * `ready-for-review` with structured change domains and formal Evidence of the anchored View at
 * its current revision (Part 1 / Part 7). Secondary and desktop-first. Evidence comes from the
 * same per-View list and freshness rules as the Readiness tab (brief f); only fresh, complete
 * captures can be referenced, because the server rejects anything else.
 */
const props = defineProps<{
	viewId: string
	/** Sends the submission; resolves true when the thread moved to ready-for-review. */
	submit: (draft: ReviewSubmissionDraft) => Promise<boolean>
	busy?: boolean
	error?: FetchErrorDetails
	conflict?: boolean
}>()
const open = defineModel<boolean>('open', { default: false })

const { t } = useI18n()
const workbench = useWorkbench()
const readiness = useReadiness()

const domains = ref<string[]>([])
const evidence = ref<string[]>([])
const reason = ref('')
const searchTerm = ref('')
const domainInput = ref<{ inputRef?: HTMLInputElement }>()
const evidenceList = ref<HTMLElement>()
const errorAlert = ref<HTMLElement>()

const viewName = computed(() => workbench.views.value.find(view => view.key === props.viewId)?.summary.name ?? '')

/** Domains used by earlier submissions in this Workspace come after the suggestions. */
const domainItems = computed(() => {
	const known = new Set<string>(SUGGESTED_CHANGE_DOMAINS)
	return [...known, ...domains.value.filter(domain => !known.has(domain))]
})

function onCreateDomain(item: string): void {
	const value = item.trim()
	if (value && !domains.value.includes(value)) domains.value = [...domains.value, value]
	searchTerm.value = ''
}

const entries = computed<readonly EvidenceEntry[]>(() => readiness.evidenceForView(props.viewId))
const usable = computed(() => entries.value.filter(entry => entry.freshness.state === 'fresh'))

function contextLabel(entry: EvidenceEntry): string {
	const context = entry.context
	if (!context) return t('evidence.context.unknown')
	return [context.variantName ?? t('ctx.base'), context.viewportId, context.locale, context.themeId].join(' · ')
}

function freshnessNote(entry: EvidenceEntry): string {
	if (entry.freshness.state === 'fresh') return t('submit.evidenceCurrent')
	return entry.freshness.reason ? t(`evidence.reason.${entry.freshness.reason}`, { subject: entry.freshness.subject ?? '' }) : t(`evidence.state.${entry.freshness.state}`)
}

function toggle(digest: string, on: boolean): void {
	evidence.value = on ? [...new Set([...evidence.value, digest])] : evidence.value.filter(item => item !== digest)
}

const draft = computed<ReviewSubmissionDraft>(() => ({ changeDomains: domains.value, evidence: evidence.value, reason: reason.value }))
const ready = computed(() => isSubmittable(draft.value))

watch(open, (value) => {
	if (!value) return
	domains.value = []
	reason.value = ''
	// Nothing is preselected: a submission claims exactly the Evidence the person chose.
	evidence.value = []
	void readiness.loadEvidence(true)
})

const allUsableSelected = computed(() => usable.value.length > 0 && usable.value.every(entry => evidence.value.includes(entry.digest)))
function toggleAllUsable(): void {
	evidence.value = allUsableSelected.value ? [] : usable.value.map(entry => entry.digest)
}

/** On a rejected submission, focus moves to the first field the server named, else the alert. */
watch(() => props.error, async (error) => {
	if (!error || !open.value) return
	await nextTick()
	const paths = error.diagnostics.map(item => item.path ?? '')
	if (paths.some(path => path.startsWith('/changeDomains'))) domainInput.value?.inputRef?.focus()
	else if (paths.some(path => path.startsWith('/evidenceRefs'))) evidenceList.value?.querySelector<HTMLElement>('button[role="checkbox"]')?.focus()
	else errorAlert.value?.focus()
})

async function send(): Promise<void> {
	if (!ready.value || props.busy) return
	if (await props.submit(draft.value)) open.value = false
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('submit.title')"
    :description="t('submit.description')"
    :ui="{ content: 'max-w-xl' }"
  >
    <template #body>
      <form
        class="grid gap-4"
        data-submit-review
        @submit.prevent="send"
      >
        <div
          v-if="error || conflict"
          ref="errorAlert"
          tabindex="-1"
          class="outline-none"
        >
          <UAlert
            :color="conflict ? 'warning' : 'error'"
            variant="subtle"
            :icon="conflict ? 'i-lucide-refresh-cw' : 'i-lucide-circle-alert'"
            role="alert"
            :title="conflict ? t('comments.conflict') : t('submit.failed')"
            :description="conflict ? t('submit.conflictHint') : error?.message"
            data-submit-error
          >
            <template
              v-if="!conflict && error?.diagnostics.length"
              #footer
            >
              <WbErrorDetails :diagnostics="error.diagnostics" />
            </template>
          </UAlert>
        </div>

        <UFormField
          :label="t('submit.domains')"
          :help="t('submit.domainsHelp')"
          required
          name="changeDomains"
        >
          <UInputMenu
            ref="domainInput"
            v-model="domains"
            v-model:search-term="searchTerm"
            :items="domainItems"
            multiple
            create-item
            :placeholder="domains.length ? '' : t('submit.domainsPlaceholder')"
            class="w-full"
            :ui="{ tagsItem: 'font-mono' }"
            data-submit-domains
            @create="onCreateDomain"
          />
        </UFormField>

        <fieldset class="grid gap-2">
          <legend class="mb-1 text-sm font-medium text-default">
            {{ t('submit.evidence') }} <span class="text-error">*</span>
          </legend>
          <div
            v-if="usable.length > 1"
            class="-mt-1 flex justify-end"
          >
            <UButton
              variant="link"
              color="neutral"
              size="xs"
              class="px-0"
              :label="allUsableSelected ? t('submit.clearEvidence') : t('submit.selectCurrent', usable.length)"
              data-submit-select-current
              @click="toggleAllUsable"
            />
          </div>
          <p class="text-xs text-muted">
            {{ t('submit.evidenceHelp', { view: viewName }) }}
          </p>
          <div
            v-if="readiness.evidenceLoading.value && !entries.length"
            class="grid gap-2"
          >
            <USkeleton
              v-for="index in 3"
              :key="index"
              class="h-9 w-full"
            />
          </div>
          <div
            v-else-if="!usable.length"
            class="rounded-md border border-dashed border-default p-3 text-sm text-muted"
            data-submit-no-evidence
          >
            <p>{{ entries.length ? t('submit.noCurrentEvidence') : t('submit.noEvidence') }}</p>
            <UButton
              variant="link"
              color="primary"
              size="sm"
              class="mt-1 px-0"
              icon="i-lucide-camera"
              :to="viewLocation(viewId, { panel: 'readiness' })"
              :label="t('submit.captureFirst')"
              @click="open = false"
            />
          </div>
          <ul
            v-if="entries.length"
            ref="evidenceList"
            class="max-h-56 divide-y divide-default overflow-y-auto rounded-md border border-default"
            data-submit-evidence
          >
            <li
              v-for="entry in entries"
              :key="entry.digest"
              class="flex min-h-(--wb-target) items-center gap-3 px-3 py-2"
              :class="entry.freshness.state === 'fresh' ? '' : 'opacity-70'"
            >
              <UCheckbox
                :model-value="evidence.includes(entry.digest)"
                :disabled="entry.freshness.state !== 'fresh'"
                :aria-label="contextLabel(entry)"
                @update:model-value="(value: boolean | 'indeterminate') => toggle(entry.digest, value === true)"
              />
              <span class="min-w-0 flex-1">
                <span class="block truncate font-mono text-xs text-highlighted">{{ contextLabel(entry) }}</span>
                <span
                  class="block text-xs"
                  :class="entry.freshness.state === 'fresh' ? 'text-muted' : 'text-warning'"
                >{{ freshnessNote(entry) }}</span>
              </span>
              <span
                class="shrink-0 font-mono text-xs text-dimmed"
                translate="no"
              >{{ entry.digest.slice(7, 15) }}</span>
            </li>
          </ul>
        </fieldset>

        <UFormField
          :label="t('submit.note')"
          name="reason"
        >
          <UTextarea
            v-model="reason"
            :rows="2"
            autoresize
            :maxrows="5"
            class="w-full"
            :placeholder="t('submit.notePlaceholder')"
          />
        </UFormField>

        <div class="flex flex-wrap items-center justify-end gap-2">
          <p
            v-if="!ready"
            class="me-auto text-xs text-muted"
          >
            {{ t('submit.needs') }}
          </p>
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('common.cancel')"
            @click="open = false"
          />
          <UButton
            type="submit"
            color="primary"
            variant="solid"
            icon="i-lucide-eye"
            :loading="busy"
            :disabled="!ready"
            :label="t('submit.action')"
            data-submit-send
          />
        </div>
      </form>
    </template>
  </UModal>
</template>
