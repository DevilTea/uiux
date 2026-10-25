<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from '#imports'
import { useWidgetCatalog } from '../../composables/useWidgetCatalog'
import { configProperties, filterCatalogRows, type CatalogRow } from '../../utils/catalog-view'
import { diagnosticText } from '../../utils/diagnostic-copy'
import { viewLocation } from '../../utils/workbench-routes'

/**
 * The Catalog block of the Product Kit page's Components section (Rules
 * 01a17443-6b37-797e-963c-282f2ec400a7, 01a17443-7bab-7b39-9c40-97216f67b582 and
 * 01a116f0-8b11-7eba-96eb-786ba7098589; owner rulings of Discussion #241, 2026-10-26): one row per
 * Widget type of the active Adapters, each opening its detail in place, so the same markup serves
 * desktop, tablet and phone. Read-only everywhere: nothing here edits a Catalog entry. The detail
 * lists the Views that use the entry and its Catalog problems; the problems of an entry no View uses
 * appear here and never in Checks (Rule 01a115cd-be51-740b-8472-c08dc7138e3e).
 */
const { t } = useI18n()
const { load, loading, loaded, failure, catalog, usageReading, usageComplete, view } = useWidgetCatalog()
onMounted(() => { void load() })

const filter = ref('')
const rows = computed(() => filterCatalogRows(view.value?.rows ?? [], filter.value))
const open = ref<ReadonlySet<string>>(new Set())

function toggle(key: string): void {
	const next = new Set(open.value)
	if (next.has(key)) next.delete(key)
	else next.add(key)
	open.value = next
}

function usageLabel(row: CatalogRow): string {
	if (row.usage === 'used') return t('productKit.catalog.usedBy', { n: row.views.length }, row.views.length)
	if (row.usage === 'unused') return t('productKit.catalog.unused')
	return usageReading.value ? t('productKit.catalog.readingViews') : t('productKit.catalog.usageUnknown')
}

const dash = '—'
const prettySchema = (schema: unknown) => JSON.stringify(schema, null, 2)
</script>

<template>
  <section
    id="product-kit-catalog"
    aria-labelledby="product-kit-catalog-title"
    class="flex flex-col gap-3"
    data-product-kit-catalog
  >
    <header class="space-y-1">
      <h3
        id="product-kit-catalog-title"
        tabindex="-1"
        class="text-sm font-semibold text-highlighted focus:outline-none"
      >
        {{ t('productKit.catalog.title') }}
      </h3>
      <p class="text-sm text-muted">
        {{ t('productKit.catalog.description') }}
      </p>
    </header>

    <div
      v-if="loading && !loaded"
      class="flex flex-col gap-2"
      role="status"
      data-catalog-loading
    >
      <span class="sr-only">{{ t('common.loading') }}</span>
      <USkeleton class="h-8 w-full" />
      <USkeleton class="h-8 w-full" />
    </div>

    <UAlert
      v-else-if="failure"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('productKit.catalog.failed')"
      :description="failure.message"
      :actions="[{ label: t('common.retry'), color: 'neutral', variant: 'outline', onClick: () => { void load() } }]"
      data-catalog-failed
    />

    <p
      v-else-if="catalog?.state === 'unavailable'"
      class="rounded-md border border-dashed border-default p-4 text-sm text-muted"
      data-catalog-unavailable
    >
      {{ t('productKit.catalog.unavailable') }}
    </p>

    <template v-else-if="view">
      <UAlert
        v-if="view.setProblems.length"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('productKit.catalog.setProblems')"
        data-catalog-set-problems
      >
        <template #description>
          <ul class="mt-1 list-disc space-y-0.5 ps-4">
            <li
              v-for="(problem, index) in view.setProblems"
              :key="`${problem.code}:${problem.path}:${index}`"
            >
              {{ diagnosticText(problem) }}
              <code
                class="font-mono text-xs break-all"
                translate="no"
              >{{ problem.path }}</code>
            </li>
          </ul>
        </template>
      </UAlert>

      <p
        v-if="!view.rows.length"
        class="rounded-md border border-dashed border-default p-4 text-sm text-muted"
        data-catalog-empty
      >
        {{ t('productKit.catalog.empty') }}
      </p>
      <template v-else>
        <UInput
          v-model="filter"
          type="search"
          icon="i-lucide-search"
          class="max-w-80"
          :placeholder="t('productKit.catalog.filterPlaceholder')"
          :aria-label="t('productKit.catalog.filter')"
          autocomplete="off"
          data-catalog-filter
        />
        <p
          class="sr-only"
          role="status"
          aria-live="polite"
        >
          {{ t('productKit.catalog.count', { n: rows.length }, rows.length) }}
        </p>
        <p
          v-if="!rows.length"
          class="rounded-md border border-dashed border-default p-4 text-sm text-muted"
          data-catalog-no-match
        >
          {{ t('productKit.catalog.noMatch') }}
        </p>
        <ul
          v-else
          class="divide-y divide-default rounded-md border border-default"
          data-catalog-list
        >
          <li
            v-for="row in rows"
            :key="row.key"
            :data-catalog-row="row.entry.type"
          >
            <h4 class="m-0 text-sm font-normal">
              <button
                type="button"
                class="flex min-h-(--wb-target,2.25rem) w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-start hover:bg-elevated/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
                :aria-expanded="open.has(row.key)"
                :aria-controls="`catalog-detail-${row.key.replace(/[^A-Za-z0-9_-]/g, '_')}`"
                :data-catalog-toggle="row.entry.type"
                @click="toggle(row.key)"
              >
                <UIcon
                  :name="open.has(row.key) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                  class="size-4 shrink-0 text-muted rtl:rotate-180"
                  aria-hidden="true"
                />
                <span
                  class="font-mono text-xs font-medium text-highlighted break-all"
                  translate="no"
                >{{ row.entry.type }}</span>
                <span
                  class="font-mono text-xs text-muted break-all"
                  translate="no"
                >{{ row.entry.adapterId }}</span>
                <span class="min-w-0 flex-1 basis-48 text-xs text-muted">{{ row.entry.description }}</span>
                <span class="flex flex-wrap items-center gap-1">
                  <UBadge
                    color="neutral"
                    variant="subtle"
                    size="sm"
                    data-catalog-usage
                  >{{ usageLabel(row) }}</UBadge>
                  <UBadge
                    v-if="row.problems.length"
                    color="error"
                    variant="subtle"
                    size="sm"
                    data-catalog-problem-count
                  >{{ t('productKit.catalog.problemCount', { n: row.problems.length }, row.problems.length) }}</UBadge>
                </span>
              </button>
            </h4>

            <div
              v-if="open.has(row.key)"
              :id="`catalog-detail-${row.key.replace(/[^A-Za-z0-9_-]/g, '_')}`"
              role="region"
              :aria-label="t('productKit.catalog.detailLabel', { type: row.entry.type })"
              class="flex flex-col gap-4 border-t border-default bg-elevated/30 px-3 py-3"
              :data-catalog-detail="row.entry.type"
            >
              <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                <dt class="text-muted">
                  {{ t('productKit.catalog.adapter') }}
                </dt>
                <dd
                  class="font-mono break-all"
                  translate="no"
                >
                  {{ row.entry.adapterId }}
                </dd>
                <dt class="text-muted">
                  {{ t('productKit.catalog.type') }}
                </dt>
                <dd
                  class="font-mono break-all"
                  translate="no"
                >
                  {{ row.entry.type }}
                </dd>
                <dt class="text-muted">
                  {{ t('productKit.catalog.descriptionLabel') }}
                </dt>
                <dd>{{ row.entry.description || dash }}</dd>
              </dl>

              <section
                class="flex flex-col gap-1"
                data-catalog-config
              >
                <h5 class="text-xs font-semibold text-highlighted">
                  {{ t('productKit.catalog.config') }}
                </h5>
                <p
                  v-if="!row.entry.config"
                  class="text-xs text-muted"
                >
                  {{ t('productKit.catalog.noConfig') }}
                </p>
                <template v-else>
                  <p
                    v-if="row.entry.config.description"
                    class="text-xs text-muted"
                  >
                    {{ row.entry.config.description }}
                  </p>
                  <div
                    v-if="configProperties(row.entry.config.schema).length"
                    class="overflow-x-auto rounded-md border border-default"
                  >
                    <table class="w-full text-start text-xs">
                      <caption class="sr-only">
                        {{ t('productKit.catalog.config') }}
                      </caption>
                      <thead class="bg-elevated/50 text-muted">
                        <tr>
                          <th
                            scope="col"
                            class="px-3 py-1.5 text-start font-medium"
                          >
                            {{ t('productKit.catalog.field') }}
                          </th>
                          <th
                            scope="col"
                            class="px-3 py-1.5 text-start font-medium"
                          >
                            {{ t('productKit.catalog.schemaType') }}
                          </th>
                          <th
                            scope="col"
                            class="px-3 py-1.5 text-start font-medium"
                          >
                            {{ t('productKit.catalog.required') }}
                          </th>
                          <th
                            scope="col"
                            class="px-3 py-1.5 text-start font-medium"
                          >
                            {{ t('productKit.catalog.descriptionLabel') }}
                          </th>
                        </tr>
                      </thead>
                      <tbody class="divide-y divide-default">
                        <tr
                          v-for="property in configProperties(row.entry.config.schema)"
                          :key="property.name"
                          class="align-top"
                        >
                          <th
                            scope="row"
                            class="px-3 py-1.5 text-start font-mono font-medium text-highlighted break-all"
                            translate="no"
                          >
                            {{ property.name }}
                          </th>
                          <td
                            class="px-3 py-1.5 font-mono break-all"
                            translate="no"
                          >
                            {{ property.type || dash }}
                          </td>
                          <td class="px-3 py-1.5">
                            {{ property.required ? t('productKit.catalog.yes') : dash }}
                          </td>
                          <td class="px-3 py-1.5">
                            {{ property.description || dash }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p
                    v-if="row.entry.config.schema === null"
                    class="text-xs text-muted"
                  >
                    {{ t('productKit.catalog.noSchema') }}
                  </p>
                  <details
                    v-else
                    class="text-xs"
                  >
                    <summary class="min-h-(--wb-target,1.5rem) cursor-pointer text-muted">
                      {{ t('productKit.catalog.rawSchema') }}
                    </summary>
                    <pre
                      class="mt-1 max-h-64 overflow-auto rounded-md border border-default bg-default p-2 font-mono text-xs"
                      tabindex="0"
                      translate="no"
                    >{{ prettySchema(row.entry.config.schema) }}</pre>
                  </details>
                </template>
              </section>

              <section
                class="flex flex-col gap-1"
                data-catalog-members
              >
                <h5 class="text-xs font-semibold text-highlighted">
                  {{ t('productKit.catalog.members') }}
                </h5>
                <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                  <dt class="text-muted">
                    {{ t('productKit.catalog.properties') }}
                  </dt>
                  <dd
                    class="font-mono break-all"
                    translate="no"
                  >
                    {{ row.entry.properties.length ? row.entry.properties.map(item => item.name).join(', ') : dash }}
                  </dd>
                  <dt class="text-muted">
                    {{ t('productKit.catalog.state') }}
                  </dt>
                  <dd
                    class="font-mono break-all"
                    translate="no"
                  >
                    {{ row.entry.state.length ? row.entry.state.map(item => item.name).join(', ') : dash }}
                  </dd>
                </dl>
              </section>

              <section
                class="flex flex-col gap-1"
                data-catalog-events
              >
                <h5 class="text-xs font-semibold text-highlighted">
                  {{ t('productKit.catalog.events') }}
                </h5>
                <p
                  v-if="!row.entry.events.length"
                  class="text-xs text-muted"
                >
                  {{ t('productKit.catalog.noEvents') }}
                </p>
                <ul
                  v-else
                  class="space-y-0.5 text-xs"
                >
                  <li
                    v-for="event in row.entry.events"
                    :key="event.name"
                  >
                    <code
                      class="font-mono font-medium text-highlighted"
                      translate="no"
                    >{{ event.name }}</code>
                    <span
                      v-if="event.description"
                      class="text-muted"
                    > — {{ event.description }}</span>
                  </li>
                </ul>
              </section>

              <section
                class="flex flex-col gap-1"
                data-catalog-i18n
              >
                <h5 class="text-xs font-semibold text-highlighted">
                  {{ t('productKit.catalog.i18n') }}
                </h5>
                <p
                  v-if="!row.entry.i18n.length"
                  class="text-xs text-muted"
                >
                  {{ t('productKit.catalog.noI18n') }}
                </p>
                <div
                  v-else
                  class="overflow-x-auto rounded-md border border-default"
                >
                  <table class="w-full text-start text-xs">
                    <caption class="sr-only">
                      {{ t('productKit.catalog.i18n') }}
                    </caption>
                    <thead class="bg-elevated/50 text-muted">
                      <tr>
                        <th
                          scope="col"
                          class="px-3 py-1.5 text-start font-medium"
                        >
                          {{ t('productKit.catalog.authorField') }}
                        </th>
                        <th
                          scope="col"
                          class="px-3 py-1.5 text-start font-medium"
                        >
                          {{ t('productKit.catalog.configField') }}
                        </th>
                        <th
                          scope="col"
                          class="px-3 py-1.5 text-start font-medium"
                        >
                          {{ t('productKit.catalog.resultProperty') }}
                        </th>
                        <th
                          scope="col"
                          class="px-3 py-1.5 text-start font-medium"
                        >
                          {{ t('productKit.catalog.textProperty') }}
                        </th>
                        <th
                          scope="col"
                          class="px-3 py-1.5 text-start font-medium"
                        >
                          {{ t('productKit.catalog.params') }}
                        </th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-default">
                      <tr
                        v-for="mapping in row.entry.i18n"
                        :key="mapping.authorField"
                        class="align-top font-mono"
                        translate="no"
                      >
                        <th
                          scope="row"
                          class="px-3 py-1.5 text-start font-medium text-highlighted break-all"
                        >
                          {{ mapping.authorField }}
                        </th>
                        <td class="px-3 py-1.5 break-all">
                          {{ mapping.configField }}
                        </td>
                        <td class="px-3 py-1.5 break-all">
                          {{ mapping.resultProperty }}
                        </td>
                        <td class="px-3 py-1.5 break-all">
                          {{ mapping.textProperty }}
                        </td>
                        <td class="px-3 py-1.5 break-all">
                          {{ Object.keys(mapping.params).length ? Object.entries(mapping.params).map(([name, property]) => `${name} → ${property}`).join(', ') : dash }}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>

              <section
                class="flex flex-col gap-1"
                data-catalog-assets
              >
                <h5 class="text-xs font-semibold text-highlighted">
                  {{ t('productKit.catalog.assetFields') }}
                </h5>
                <p
                  v-if="!row.entry.assetFields.length"
                  class="text-xs text-muted"
                >
                  {{ t('productKit.catalog.noAssetFields') }}
                </p>
                <div
                  v-else
                  class="overflow-x-auto rounded-md border border-default"
                >
                  <table class="w-full text-start text-xs">
                    <caption class="sr-only">
                      {{ t('productKit.catalog.assetFields') }}
                    </caption>
                    <thead class="bg-elevated/50 text-muted">
                      <tr>
                        <th
                          scope="col"
                          class="px-3 py-1.5 text-start font-medium"
                        >
                          {{ t('productKit.catalog.field') }}
                        </th>
                        <th
                          scope="col"
                          class="px-3 py-1.5 text-start font-medium"
                        >
                          {{ t('productKit.catalog.mediaTypes') }}
                        </th>
                        <th
                          scope="col"
                          class="px-3 py-1.5 text-start font-medium"
                        >
                          {{ t('productKit.catalog.categories') }}
                        </th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-default">
                      <tr
                        v-for="field in row.entry.assetFields"
                        :key="field.field"
                        class="align-top font-mono"
                        translate="no"
                      >
                        <th
                          scope="row"
                          class="px-3 py-1.5 text-start font-medium text-highlighted break-all"
                        >
                          {{ field.field }}
                        </th>
                        <td class="px-3 py-1.5 break-all">
                          {{ field.acceptedMediaTypes.length ? field.acceptedMediaTypes.join(', ') : dash }}
                        </td>
                        <td class="px-3 py-1.5 break-all">
                          {{ field.acceptedCategories.length ? field.acceptedCategories.join(', ') : dash }}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>

              <section
                class="flex flex-col gap-1"
                data-catalog-views
              >
                <h5 class="text-xs font-semibold text-highlighted">
                  {{ t('productKit.catalog.views') }}
                </h5>
                <p
                  v-if="row.usage === 'unused'"
                  class="text-xs text-muted"
                >
                  {{ t('productKit.catalog.noViews') }}
                </p>
                <p
                  v-else-if="row.usage === 'unknown'"
                  class="text-xs text-muted"
                >
                  {{ usageReading ? t('productKit.catalog.readingViews') : t('productKit.catalog.usageUnknownDetail') }}
                </p>
                <ul
                  v-if="row.views.length"
                  class="space-y-0.5 text-xs"
                >
                  <li
                    v-for="used in row.views"
                    :key="used.resource.key"
                  >
                    <ULink
                      :to="viewLocation(used.resource.key)"
                      class="text-primary hover:underline"
                    >
                      {{ used.resource.name }}
                    </ULink>
                    <span class="text-muted"> · {{ t('productKit.catalog.widgetCount', { n: used.widgets }, used.widgets) }}</span>
                  </li>
                </ul>
                <p
                  v-if="row.usage === 'used' && !usageComplete && !usageReading"
                  class="text-xs text-muted"
                >
                  {{ t('productKit.catalog.usagePartial') }}
                </p>
              </section>

              <section
                class="flex flex-col gap-1"
                data-catalog-problems
              >
                <h5 class="text-xs font-semibold text-highlighted">
                  {{ t('productKit.catalog.problems') }}
                </h5>
                <p
                  v-if="!row.problems.length"
                  class="text-xs text-muted"
                >
                  {{ t('productKit.catalog.noProblems') }}
                </p>
                <template v-else>
                  <p class="text-xs text-muted">
                    {{ row.usage === 'unused' ? t('productKit.catalog.problemsOnlyHere') : t('productKit.catalog.problemsAlsoInChecks') }}
                  </p>
                  <ul class="list-disc space-y-0.5 ps-4 text-xs">
                    <li
                      v-for="(problem, index) in row.problems"
                      :key="`${problem.code}:${problem.path}:${index}`"
                    >
                      {{ diagnosticText(problem) }}
                      <code
                        class="font-mono break-all text-muted"
                        translate="no"
                      >{{ problem.path }}</code>
                    </li>
                  </ul>
                </template>
              </section>
            </div>
          </li>
        </ul>
      </template>
    </template>
  </section>
</template>
