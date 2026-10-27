<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from '#imports'
import { CHANGE_DOMAINS, changeAffectsFormalCapture, changeScopeOfSubmission, type ChangeDomain } from '../../../src/domain/reviews/change-domains'
import { useReadiness, type EvidenceEntry } from '../../composables/useReadiness'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchFormat } from '../../composables/useWorkbenchFormat'
import type { FetchErrorDetails } from '../../utils/fetch-error'
import type { CitableEvidenceEntry, EvidenceFreshness } from '../../utils/readiness'
import { isSubmittable, preselectedCitations, withUsableSelection, type ReviewSubmissionDraft } from '../../utils/review-submission'
import { viewLocation } from '../../utils/workbench-routes'
import WbErrorDescription from './WbErrorDescription.vue'

/**
 * "Submit for review…" (brief c, section 12; roadmap R12): a human moves an open thread to
 * `ready-for-review` with structured change domains and formal Evidence of the anchored View at
 * its current revision (Part 1 / Part 7). Secondary and desktop-first. Any Evidence kind can be
 * cited (Rule 01a11544-55b0-…): formal captures come from the same per-View list and freshness rules
 * as the Readiness tab (brief f), and only fresh, complete ones can be referenced, because the server
 * rejects anything else; Run Checks records, Flow traces and interaction replays are never refused as
 * stale (Rule 01a11544-558b-…), so they are shown with when they ran or whether they are current
 * (a replay as current or stale like a trace, Clause 01a14e30-2e43-…).
 * A change domain preselects the kind that proves it (owner ruling 6 of Discussion #241).
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
const fmt = useWorkbenchFormat()

const domains = ref<ChangeDomain[]>([])
const evidence = ref<string[]>([])
const reason = ref('')
const domainInput = ref<{ triggerRef?: HTMLElement }>()
const evidenceList = ref<HTMLElement>()
const errorAlert = ref<HTMLElement>()

const viewName = computed(() => workbench.views.value.find(view => view.key === props.viewId)?.summary.name ?? '')

/** Clause 01a14e30-2dce-…: only the known change domains can be chosen; the server refuses any other. */
const domainItems = computed(() => CHANGE_DOMAINS.map(domain => ({ label: t(`changeDomain.${domain}`), value: domain })))

const entries = computed<readonly EvidenceEntry[]>(() => readiness.evidenceForView(props.viewId))
const usable = computed(() => entries.value.filter(entry => entry.freshness.state === 'fresh'))
const citable = computed<readonly CitableEvidenceEntry[]>(() => readiness.citableEvidenceForView(props.viewId))
/** The kind each citable record has, to declare it as the record's own kind (Rule 01a11544-55b0-…). */
const kindOf = computed(() => new Map<string, string>([
	...entries.value.map(entry => [entry.digest, 'formal_capture'] as const),
	...citable.value.map(entry => [entry.digest, entry.kind] as const),
]))

/**
 * Rules 01a115cd-c715-… and 01a115cd-c749-… (Discussion #1 c159: the Workbench uses the change
 * domains to tell which captures must be regenerated): whether the chosen domains affect this
 * View's formal captures (Clause 01a14e30-2e43-…). The submission names only this View, so an
 * `asset`, `i18n` or `settings` change is read as touching any of its captures.
 */
const domainEffect = computed<'affects' | 'keeps' | undefined>(() => {
	if (domains.value.length === 0) return undefined
	const scope = changeScopeOfSubmission({ changeDomains: domains.value, resources: [] }, props.viewId)
	const captures = entries.value.length ? entries.value.map(entry => ({ viewId: props.viewId, ...entry.context })) : [{ viewId: props.viewId }]
	return captures.some(capture => changeAffectsFormalCapture(scope, capture)) ? 'affects' : 'keeps'
})

function contextLabel(entry: EvidenceEntry): string {
	const context = entry.context
	if (!context) return t('evidence.context.unknown')
	return [context.variantName ?? t('ctx.base'), context.viewportId, context.locale, context.themeId].join(' · ')
}

function freshnessNote(entry: EvidenceEntry): string {
	if (entry.freshness.state === 'fresh') return t('submit.evidenceCurrent')
	return entry.freshness.reason ? t(`evidence.reason.${entry.freshness.reason}`, { subject: entry.freshness.subject ?? '' }) : t(`evidence.state.${entry.freshness.state}`)
}

function executionOf(record: CitableEvidenceEntry['record']): Record<string, unknown> {
	return (record.executionContext ?? {}) as Record<string, unknown>
}

function citableLabel(entry: CitableEvidenceEntry): string {
	const execution = executionOf(entry.record)
	if (entry.kind === 'checks_run') return t('submit.checksLabel', { time: fmt.dateTime(typeof execution.ranAt === 'string' ? execution.ranAt : undefined) })
	if (entry.kind === 'flow_trace') {
		const flowName = workbench.flows.value.find(flow => flow.key === execution.flowId)?.summary.name
		return [flowName || t('submit.flowGone'), execution.locale, execution.viewportId, execution.themeId].join(' · ')
	}
	return [execution.variantName ?? t('ctx.base'), execution.viewportId, execution.locale, execution.themeId].join(' · ')
}

/** The freshness a trace or replay is shown with: current, or why not. Never a reason to refuse citing it. */
function citableFreshnessNote(freshness: EvidenceFreshness | undefined): string {
	if (!freshness || freshness.state === 'fresh') return t('submit.evidenceCurrent')
	return freshness.reason ? t(`evidence.reason.${freshness.reason}`, { subject: freshness.subject ?? '' }) : t(`evidence.state.${freshness.state}`)
}

/** What the record says of itself; a trace or a replay also says whether it is current, which never stops it being cited. */
function citableNote(entry: CitableEvidenceEntry): string {
	const data = (entry.record.data ?? {}) as Record<string, unknown>
	if (entry.kind === 'checks_run') {
		const findings = Array.isArray(data.findings) ? data.findings as readonly { severity?: string }[] : []
		const counts = { errors: findings.filter(finding => finding.severity === 'error').length, warnings: findings.filter(finding => finding.severity === 'warning').length }
		return entry.record.coverage.complete ? t('submit.checksNote', counts) : t('submit.checksIncomplete', counts)
	}
	if (entry.kind === 'flow_trace') return citableFreshnessNote(entry.freshness)
	const assertions = Array.isArray(data.assertions) ? data.assertions as readonly { result?: string }[] : []
	return `${t('submit.replayNote', { passed: assertions.filter(assertion => assertion.result === 'pass').length, total: assertions.length })} · ${citableFreshnessNote(entry.freshness)}`
}

function citableWarns(entry: CitableEvidenceEntry): boolean {
	if (entry.kind === 'checks_run') return !entry.record.coverage.complete
	if (entry.kind === 'flow_trace') return entry.freshness?.state !== 'fresh'
	return entry.freshness?.state !== 'fresh' || ((entry.record.data as { assertions?: readonly { result?: string }[] } | undefined)?.assertions ?? []).some(assertion => assertion.result !== 'pass')
}

const citableGroups = computed(() => (['checks_run', 'flow_trace', 'interaction_replay'] as const)
	.map(kind => ({ kind, entries: citable.value.filter(entry => entry.kind === kind) }))
	.filter(group => group.entries.length > 0))

function toggle(digest: string, on: boolean): void {
	evidence.value = on ? [...new Set([...evidence.value, digest])] : evidence.value.filter(item => item !== digest)
}

const draft = computed<ReviewSubmissionDraft>(() => ({
	changeDomains: domains.value,
	evidence: evidence.value.map(digest => ({ kind: kindOf.value.get(digest) ?? 'formal_capture', evidence: digest })),
	reason: reason.value,
}))
const ready = computed(() => isSubmittable(draft.value))

// Owner ruling 6 of Discussion #241: a change domain preselects the kind that proves it, once the
// records are read; a domain that was already applied is not applied again, so unticking sticks.
const preselectedFor = new Set<string>()
function preselect(): void {
	for (const domain of [...preselectedFor]) if (!domains.value.includes(domain as ChangeDomain)) preselectedFor.delete(domain)
	if (readiness.citableLoading.value || readiness.evidenceLoading.value) return
	for (const domain of domains.value) {
		if (preselectedFor.has(domain)) continue
		preselectedFor.add(domain)
		const picked = preselectedCitations(domain, citable.value).map(citation => citation.evidence)
		if (picked.length) evidence.value = [...new Set([...evidence.value, ...picked])]
	}
}
watch([domains, citable, () => readiness.citableLoading.value, () => readiness.evidenceLoading.value], preselect, { deep: true })

watch(open, (value) => {
	if (!value) return
	domains.value = []
	reason.value = ''
	preselectedFor.clear()
	// No domain is chosen yet, so nothing is preselected: a submission claims exactly the Evidence the person chose.
	evidence.value = []
	void readiness.loadEvidence(true)
	void readiness.loadCitableEvidence()
})

const allUsableSelected = computed(() => usable.value.length > 0 && usable.value.every(entry => evidence.value.includes(entry.digest)))
function toggleAllUsable(): void {
	evidence.value = withUsableSelection(evidence.value, usable.value.map(entry => entry.digest), !allUsableSelected.value)
}

/** On a rejected submission, focus moves to the first field the server named, else the alert. */
watch(() => props.error, async (error) => {
	if (!error || !open.value) return
	await nextTick()
	const paths = error.diagnostics.map(item => item.path ?? '')
	if (paths.some(path => path.startsWith('/changeDomains'))) domainInput.value?.triggerRef?.focus()
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
            :description="conflict ? t('submit.conflictHint') : undefined"
            data-submit-error
          >
            <template
              v-if="!conflict && error"
              #description
            >
              <WbErrorDescription
                :headline="t('submit.failed')"
                :lead="error.message"
                :diagnostics="error.diagnostics"
                :status-code="error.statusCode"
              />
            </template>
          </UAlert>
        </div>

        <UFormField
          :label="t('submit.domains')"
          :help="t('submit.domainsHelp')"
          required
          name="changeDomains"
        >
          <USelectMenu
            ref="domainInput"
            v-model="domains"
            :items="domainItems"
            value-key="value"
            multiple
            :search-input="false"
            :placeholder="t('submit.domainsPlaceholder')"
            class="w-full"
            data-submit-domains
          />
          <p
            v-if="domainEffect"
            class="mt-1.5 text-xs"
            :class="domainEffect === 'affects' ? 'text-warning' : 'text-muted'"
            :data-submit-domain-effect="domainEffect"
          >
            {{ domainEffect === 'affects' ? t('submit.domainsAffect', { view: viewName }) : t('submit.domainsKeep', { view: viewName }) }}
          </p>
        </UFormField>

        <fieldset
          ref="evidenceList"
          class="grid gap-2"
        >
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
            v-if="(readiness.evidenceLoading.value || readiness.citableLoading.value) && !entries.length && !citable.length"
            class="grid gap-2"
          >
            <USkeleton
              v-for="index in 3"
              :key="index"
              class="h-9 w-full"
              :aria-label="t('common.loading')"
            />
          </div>
          <p
            v-if="readiness.citableError.value"
            class="text-xs text-error"
            role="alert"
            data-submit-citable-error
          >
            {{ readiness.citableError.value.message }}
          </p>
          <div
            v-else-if="!usable.length && !citable.length"
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
          <p
            v-if="entries.length && citableGroups.length"
            class="text-xs font-medium text-muted"
          >
            {{ t('submit.kind.formal_capture') }}
          </p>
          <ul
            v-if="entries.length"
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
          <template
            v-for="group in citableGroups"
            :key="group.kind"
          >
            <p class="mt-1 text-xs font-medium text-muted">
              {{ t(`submit.kind.${group.kind}`) }}
            </p>
            <ul
              class="max-h-40 divide-y divide-default overflow-y-auto rounded-md border border-default"
              :data-submit-evidence-kind="group.kind"
            >
              <li
                v-for="entry in group.entries"
                :key="entry.digest"
                class="flex min-h-(--wb-target) items-center gap-3 px-3 py-2"
                :data-submit-evidence-digest="entry.digest"
              >
                <UCheckbox
                  :model-value="evidence.includes(entry.digest)"
                  :aria-label="citableLabel(entry)"
                  @update:model-value="(value: boolean | 'indeterminate') => toggle(entry.digest, value === true)"
                />
                <span class="min-w-0 flex-1">
                  <span class="block truncate font-mono text-xs text-highlighted">{{ citableLabel(entry) }}</span>
                  <span
                    class="block text-xs"
                    :class="citableWarns(entry) ? 'text-warning' : 'text-muted'"
                    :data-submit-evidence-note="entry.kind"
                  >{{ citableNote(entry) }}</span>
                </span>
                <span
                  class="shrink-0 font-mono text-xs text-dimmed"
                  translate="no"
                >{{ entry.digest.slice(7, 15) }}</span>
              </li>
            </ul>
          </template>
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
