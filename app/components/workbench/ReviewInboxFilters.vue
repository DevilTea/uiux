<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { useReviewInbox } from '../../composables/useReviewInbox'
import { actorKey, ANCHOR_STATES, VIEW_WIDE_SCOPE, WORKSPACE_VIEW_TOKEN, type AnchorState, type InboxFilter } from '../../utils/review-inbox'

/**
 * The structured filters of the Reviews inbox (brief d, section 6): View, Variant scope, author,
 * anchor and change domain. Options come from the loaded threads; author filtering is
 * client-side (a server-side author filter would extend the Review query contract).
 */
const { t } = useI18n()
const inbox = useReviewInbox()

type Option = Readonly<{ label: string; value: string; icon?: string }>

function byLabel(a: Option, b: Option): number {
	return a.label.localeCompare(b.label)
}

/** Views with threads, after the Workspace option (`view=workspace`) for Workspace-scoped threads. */
const viewOptions = computed<Option[]>(() => {
	const seen = new Map<string, string>()
	for (const item of inbox.threads.value) if (item.viewId) seen.set(item.viewId, item.viewName ?? t('inbox.viewMissing'))
	return [
		{ label: t('inbox.filter.workspace'), value: WORKSPACE_VIEW_TOKEN, icon: 'i-lucide-globe' },
		...[...seen].map(([value, label]) => ({ label, value })).sort(byLabel),
	]
})

const scopeOptions = computed<Option[]>(() => {
	const names = new Set(inbox.threads.value.flatMap(item => item.variantNames))
	return [{ label: t('inbox.filter.viewWide'), value: VIEW_WIDE_SCOPE }, ...[...names].sort().map(name => ({ label: name, value: name, icon: 'i-lucide-layers' }))]
})

const authorOptions = computed<Option[]>(() => {
	const seen = new Map<string, Option>()
	for (const item of inbox.threads.value) {
		if (!item.author) continue
		const key = actorKey(item.author)
		if (seen.has(key)) continue
		const name = item.author.displayName ?? item.author.id ?? t('comments.unknownAuthor')
		seen.set(key, { label: item.author.type === 'agent' ? `${name} (${t('comments.agent')})` : name, value: key, icon: item.author.type === 'agent' ? 'i-lucide-bot' : 'i-lucide-user' })
	}
	return [...seen.values()].sort(byLabel)
})

const anchorOptions = computed<Option[]>(() => ANCHOR_STATES.map((state: AnchorState) => ({
	value: state,
	label: t(state === 'valid' ? 'inbox.filter.anchorValid' : state === 'stale' ? 'inbox.filter.stale' : 'inbox.filter.missing'),
})))

const domainOptions = computed<Option[]>(() => [...new Set(inbox.threads.value.flatMap(item => item.domains))].sort().map(domain => ({ label: domain, value: domain })))

function model<K extends 'views' | 'scopes' | 'authors' | 'anchor' | 'domains'>(key: K) {
	return computed({
		get: () => [...inbox.filter.value[key]] as string[],
		set: (value: string[]) => inbox.setFilter({ [key]: value } as Partial<InboxFilter>),
	})
}
const views = model('views')
const scopes = model('scopes')
const authors = model('authors')
const anchor = model('anchor')
const domains = model('domains')

const fields = computed(() => [
	{ key: 'views', label: t('inbox.filter.view'), items: viewOptions.value, model: views, empty: t('inbox.filter.noOptions') },
	{ key: 'scopes', label: t('inbox.filter.scope'), items: scopeOptions.value, model: scopes, empty: t('inbox.filter.noOptions') },
	{ key: 'authors', label: t('inbox.filter.author'), items: authorOptions.value, model: authors, empty: t('inbox.filter.noOptions') },
	{ key: 'anchor', label: t('inbox.filter.anchor'), items: anchorOptions.value, model: anchor, empty: t('inbox.filter.noOptions') },
	{ key: 'domains', label: t('inbox.filter.domain'), items: domainOptions.value, model: domains, empty: t('inbox.filter.noDomains') },
] as const)
</script>

<template>
  <div
    class="grid gap-3"
    data-review-filters
  >
    <UFormField
      v-for="field in fields"
      :key="field.key"
      :label="field.label"
      :ui="{ label: 'text-xs font-medium text-muted' }"
    >
      <USelectMenu
        v-model="field.model.value"
        :items="[...field.items]"
        value-key="value"
        multiple
        :search-input="field.items.length > 6 ? { placeholder: t('inbox.filter.find') } : false"
        :placeholder="t('inbox.filter.any')"
        class="w-full"
        :ui="{ base: 'pointer-coarse:text-base' }"
        :data-review-filter="field.key"
      >
        <template #empty>
          {{ field.empty }}
        </template>
      </USelectMenu>
    </UFormField>
  </div>
</template>
