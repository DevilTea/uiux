<script setup lang="ts">
import { computed, nextTick, ref, shallowRef } from 'vue'
import { useI18n, useToast } from '#imports'
import type { ProductKitComponent } from '../../../src/domain/product-kit/schema'
import { describeFetchError, type FetchErrorDetails } from '../../utils/fetch-error'
import { componentDeclarations, type ComponentDeclaration } from '../../utils/component-interface'
import { copyText } from '../../utils/copy-text'

/**
 * The Components section of the Product Kit page (Rule 01a11bb1-b918-7cb5-b581-a3fd3f647f09): the
 * component registry as a table (name, layer, files, `requires`, packages), browsing one component's
 * source with the props and emits it declares, and the commands that copy it into a product project
 * (`uiux components add`, Clause 01a11bb1-8b0c-…, and its MCP counterpart `get_component_source`).
 *
 * The registry reads with `workspace.read`, as the Product Kit file does. Browsing reads the
 * component's files through `POST /api/product-kit/components/source`, which needs
 * `product-kit.source.read` (`canBrowse`); the server enforces it. Source text is shown as text only.
 * The Catalog part of the section waits on issue #116.
 */
const props = defineProps<{
	components: Readonly<Record<string, ProductKitComponent>>
	canBrowse: boolean
}>()
const { t } = useI18n()
const toast = useToast()

// Untyped request helper: Nitro's typed-route inference overflows on this many routes.
const api = $fetch as unknown as <T = unknown>(url: string, options?: Readonly<Record<string, unknown>>) => Promise<T>

/** The Product Kit member that holds the registry. */
const REGISTRY_FIELD = 'components'

const names = computed(() => Object.keys(props.components).sort())

/** Where `uiux components add` copies to, relative to the product project; only the shown commands use it. */
const target = ref('src/components')
const targetText = computed(() => target.value.trim() || 'src/components')

function cliCommand(name: string): string {
	const dir = targetText.value
	return `uiux components add ${name} --to ${/[\s"'$`\\]/u.test(dir) ? JSON.stringify(dir) : dir}`
}

function mcpCall(name: string): string {
	return `get_component_source ${JSON.stringify({ name, withRequires: true })}`
}

async function copy(text: string): Promise<void> {
	if (await copyText(text)) toast.add({ title: t('productKit.components.copied'), color: 'success', icon: 'i-lucide-check' })
	else toast.add({ title: t('productKit.components.copyFailed'), color: 'error', icon: 'i-lucide-circle-alert', duration: 0 })
}

type SourceFile = Readonly<{ path: string; digest: string; content: string; encoding?: 'base64' }>
type ComponentSource = Readonly<{ name: string; componentDigest: string; requires: readonly string[]; packages: Readonly<Record<string, string | null>>; files: readonly SourceFile[] }>

const selected = ref<string>()
const source = shallowRef<ComponentSource>()
const sourceLoading = ref(false)
const sourceError = shallowRef<FetchErrorDetails>()
let request = 0

async function browse(name: string): Promise<void> {
	if (!props.canBrowse) return
	selected.value = name
	source.value = undefined
	sourceError.value = undefined
	sourceLoading.value = true
	const ticket = ++request
	try {
		const result = await api<{ components: readonly ComponentSource[] }>('/api/product-kit/components/source', { method: 'POST', body: { name } })
		if (ticket !== request) return
		source.value = result.components.find(component => component.name === name)
	}
	catch (cause) {
		if (ticket !== request) return
		sourceError.value = describeFetchError(cause, t('productKit.components.sourceFailed'))
	}
	finally {
		if (ticket === request) sourceLoading.value = false
	}
	await nextTick()
	document.getElementById('product-kit-component-detail-title')?.focus()
}

const declarations = computed<ComponentDeclaration[]>(() => (source.value?.files ?? [])
	.filter(file => file.encoding !== 'base64')
	.flatMap(file => componentDeclarations(file.path, file.content)))
const propsDeclarations = computed(() => declarations.value.filter(item => item.kind === 'props'))
const emitsDeclarations = computed(() => declarations.value.filter(item => item.kind === 'emits'))
</script>

<template>
  <section
    id="product-kit-components"
    aria-labelledby="product-kit-components-title"
    class="flex flex-col gap-4"
    data-product-kit-section="components"
  >
    <header class="space-y-1">
      <h2
        id="product-kit-components-title"
        tabindex="-1"
        class="text-title font-semibold text-highlighted focus:outline-none"
      >
        {{ t('productKit.components.title') }}
      </h2>
      <i18n-t
        keypath="productKit.components.description"
        tag="p"
        scope="global"
        class="text-sm text-muted"
      >
        <template #field>
          <code class="font-mono text-xs">{{ REGISTRY_FIELD }}</code>
        </template>
      </i18n-t>
    </header>

    <p
      v-if="!names.length"
      class="rounded-md border border-dashed border-default p-4 text-sm text-muted"
      data-components-empty
    >
      {{ t('productKit.components.empty') }}
    </p>
    <template v-else>
      <UFormField
        :label="t('productKit.components.target')"
        :help="t('productKit.components.targetHelp')"
        class="max-w-80"
      >
        <UInput
          v-model="target"
          class="w-full font-mono"
          spellcheck="false"
          autocomplete="off"
          data-components-target
        />
      </UFormField>

      <div class="overflow-x-auto rounded-md border border-default">
        <table
          class="w-full text-start text-sm"
          data-components-table
        >
          <caption class="sr-only">
            {{ t('productKit.components.title') }}
          </caption>
          <thead class="bg-elevated/50 text-xs text-muted">
            <tr>
              <th
                scope="col"
                class="px-3 py-2 text-start font-medium"
              >
                {{ t('productKit.components.name') }}
              </th>
              <th
                scope="col"
                class="px-3 py-2 text-start font-medium"
              >
                {{ t('productKit.components.layer') }}
              </th>
              <th
                scope="col"
                class="px-3 py-2 text-start font-medium"
              >
                {{ t('productKit.components.files') }}
              </th>
              <th
                scope="col"
                class="px-3 py-2 text-start font-medium"
              >
                {{ t('productKit.components.requires') }}
              </th>
              <th
                scope="col"
                class="px-3 py-2 text-start font-medium"
              >
                {{ t('productKit.components.packages') }}
              </th>
              <th
                scope="col"
                class="px-3 py-2"
              >
                <span class="sr-only">{{ t('productKit.components.actions') }}</span>
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-default">
            <tr
              v-for="name in names"
              :key="name"
              class="align-top"
              :data-component-row="name"
            >
              <th
                scope="row"
                class="px-3 py-2 text-start font-mono text-xs font-medium text-highlighted"
                translate="no"
              >
                {{ name }}
              </th>
              <td class="px-3 py-2">
                <UBadge
                  color="neutral"
                  variant="subtle"
                  size="sm"
                >
                  {{ t(components[name]!.layer === 'design-system' ? 'productKit.components.layers.designSystem' : 'productKit.components.layers.product') }}
                </UBadge>
              </td>
              <td class="px-3 py-2">
                <ul
                  class="space-y-0.5 font-mono text-xs break-all"
                  translate="no"
                >
                  <li
                    v-for="path in components[name]!.files"
                    :key="path"
                  >
                    {{ path }}
                  </li>
                </ul>
              </td>
              <td
                class="px-3 py-2 font-mono text-xs"
                translate="no"
              >
                <span v-if="components[name]!.requires?.length">{{ components[name]!.requires!.join(', ') }}</span>
                <span
                  v-else
                  class="text-dimmed"
                >—</span>
              </td>
              <td
                class="px-3 py-2 font-mono text-xs"
                translate="no"
              >
                <span v-if="components[name]!.packages?.length">{{ components[name]!.packages!.join(', ') }}</span>
                <span
                  v-else
                  class="text-dimmed"
                >—</span>
              </td>
              <td class="px-3 py-2">
                <div class="flex justify-end gap-1">
                  <UButton
                    v-if="canBrowse"
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    icon="i-lucide-file-code"
                    :aria-label="t('productKit.components.browseNamed', { name })"
                    :aria-pressed="selected === name"
                    data-component-browse
                    @click="browse(name)"
                  >
                    {{ t('productKit.components.browse') }}
                  </UButton>
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    icon="i-lucide-copy"
                    :aria-label="t('productKit.components.copyCommandNamed', { name })"
                    data-component-copy-cli
                    @click="copy(cliCommand(name))"
                  >
                    {{ t('productKit.components.copyCommand') }}
                  </UButton>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p
        v-if="!canBrowse"
        class="flex items-center gap-1.5 text-xs text-muted"
        data-access-notice="component-source"
        data-missing-key="product-kit.source.read"
      >
        <UIcon
          name="i-lucide-user-lock"
          class="size-3.5 shrink-0"
        />
        {{ t('productKit.components.browseRequiresKey', { key: 'product-kit.source.read' }) }}
      </p>

      <div
        v-if="selected"
        class="flex flex-col gap-4 rounded-md border border-default p-4"
        data-component-detail
        :data-component="selected"
        aria-live="polite"
      >
        <div class="flex items-start justify-between gap-3">
          <h3
            id="product-kit-component-detail-title"
            tabindex="-1"
            class="font-mono text-sm font-semibold text-highlighted focus:outline-none"
            translate="no"
          >
            {{ selected }}
          </h3>
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            icon="i-lucide-x"
            :aria-label="t('common.close')"
            @click="selected = undefined"
          />
        </div>

        <section
          :aria-label="t('productKit.components.copyCommands')"
          class="flex flex-col gap-2"
        >
          <h4 class="text-xs font-medium text-muted">
            {{ t('productKit.components.copyCommands') }}
          </h4>
          <div
            v-for="command in [{ id: 'cli', label: t('productKit.components.cli'), text: cliCommand(selected) }, { id: 'mcp', label: t('productKit.components.mcp'), text: mcpCall(selected) }]"
            :key="command.id"
            class="flex items-center gap-2"
          >
            <span class="w-12 shrink-0 text-xs text-muted">{{ command.label }}</span>
            <code
              class="min-w-0 flex-1 rounded border border-default bg-muted px-2 py-1 font-mono text-xs break-all"
              translate="no"
              :data-component-command="command.id"
            >{{ command.text }}</code>
            <UButton
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-copy"
              :aria-label="t('productKit.components.copyNamed', { what: command.label })"
              @click="copy(command.text)"
            />
          </div>
        </section>

        <USkeleton
          v-if="sourceLoading"
          class="h-24 w-full"
          :aria-label="t('common.loading')"
        />
        <UAlert
          v-else-if="sourceError"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="t('productKit.components.sourceFailed')"
          :description="sourceError.message"
          :actions="[{ label: t('common.retry'), color: 'neutral', variant: 'outline', onClick: () => { void browse(selected!) } }]"
          data-component-source-error
        />
        <template v-else-if="source">
          <section
            :aria-label="t('productKit.components.interface')"
            class="flex flex-col gap-2"
            data-component-interface
          >
            <h4 class="text-xs font-medium text-muted">
              {{ t('productKit.components.interface') }}
            </h4>
            <div
              v-for="group in [{ id: 'props', label: t('productKit.components.props'), items: propsDeclarations }, { id: 'emits', label: t('productKit.components.emits'), items: emitsDeclarations }]"
              :key="group.id"
              class="flex flex-col gap-1"
              :data-component-declarations="group.id"
            >
              <span class="text-xs font-medium text-default">{{ group.label }}</span>
              <p
                v-if="!group.items.length"
                class="text-xs text-muted"
              >
                {{ t('productKit.components.notDeclared') }}
              </p>
              <figure
                v-for="(item, index) in group.items"
                :key="`${item.file}-${index}`"
                class="flex flex-col gap-1"
              >
                <pre
                  class="max-h-60 overflow-auto rounded-md border border-default bg-muted p-2 font-mono text-xs whitespace-pre-wrap text-default"
                  translate="no"
                >{{ item.text }}</pre>
                <figcaption
                  class="font-mono text-xs text-muted"
                  translate="no"
                >
                  {{ item.file }}
                </figcaption>
              </figure>
            </div>
            <p class="text-xs text-muted">
              {{ t('productKit.components.interfaceHelp') }}
            </p>
          </section>

          <section
            :aria-label="t('productKit.components.sourceFiles')"
            class="flex flex-col gap-2"
          >
            <h4 class="text-xs font-medium text-muted">
              {{ t('productKit.components.sourceFiles') }}
            </h4>
            <details
              v-for="file in source.files"
              :key="file.path"
              class="rounded-md border border-default"
              :data-component-file="file.path"
            >
              <summary
                class="cursor-pointer px-3 py-1.5 font-mono text-xs"
                translate="no"
              >
                {{ file.path }}
              </summary>
              <p
                v-if="file.encoding === 'base64'"
                class="px-3 pb-2 text-xs text-muted"
              >
                {{ t('productKit.files.binary') }}
              </p>
              <pre
                v-else
                class="max-h-96 overflow-auto border-t border-default bg-muted p-3 font-mono text-xs whitespace-pre text-default"
                tabindex="0"
                translate="no"
                data-component-file-content
              >{{ file.content }}</pre>
            </details>
          </section>
        </template>
      </div>
    </template>
  </section>
</template>
