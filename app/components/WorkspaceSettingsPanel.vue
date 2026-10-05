<script setup lang="ts">
import { ref, shallowRef, watch } from 'vue'
import { useI18n } from '#imports'
import { useWorkbenchFeedback } from '../composables/useWorkbenchFeedback'
import type { FetchErrorDetails } from '../utils/fetch-error'
import type { WorkspaceManifest } from '../../src/domain/workspace/schema'

type Diagnostic = Readonly<{ code: string; path: string; message: string }>
type WorkspaceRead = Readonly<{
	kind: 'workspace'
	key: 'workspace'
	revision: string
	diagnostics: readonly Diagnostic[]
	resource: WorkspaceManifest
}>

const props = defineProps<{
	workspace?: WorkspaceRead
	readOnly?: boolean
}>()

const emit = defineEmits<{
	(e: 'saved', result: unknown): void
	(e: 'reload'): void
	(e: 'changed'): void
}>()

const { t } = useI18n()
const feedback = useWorkbenchFeedback()

interface LocalAdapter {
	moduleSpecifier: string
	config: string
}

interface LocalViewport {
	id: string
	width: number | null
	height: number | null
}

interface LocalTheme {
	id: string
}

const defaultLocale = ref('en-US')
const localAdapters = ref<LocalAdapter[]>([])
const localViewports = ref<LocalViewport[]>([])
const localThemes = ref<LocalTheme[]>([])

const saving = ref(false)
const saveError = shallowRef<FetchErrorDetails>()
const conflict = ref(false)

const dimensionFormat: Intl.NumberFormatOptions = { useGrouping: false, maximumFractionDigits: 0 }

function syncFromProps() {
	conflict.value = false
	saveError.value = undefined
	if (!props.workspace?.resource) return

	const res = props.workspace.resource
	defaultLocale.value = res.i18n?.defaultLocale || 'en-US'

	localAdapters.value = (res.adapters || []).map(a => ({
		moduleSpecifier: a.moduleSpecifier || '',
		config: a.config !== undefined ? (typeof a.config === 'string' ? a.config : JSON.stringify(a.config, null, 2)) : '',
	}))

	localViewports.value = Object.entries(res.viewports || {}).map(([id, vp]) => ({
		id,
		width: vp?.dimensions?.width ?? 1280,
		height: vp?.dimensions?.height ?? 800,
	}))

	localThemes.value = Object.keys(res.themes || {}).map(id => ({ id }))
}

watch(() => props.workspace, syncFromProps, { immediate: true })

function addAdapter() {
	if (props.readOnly) return
	localAdapters.value.push({ moduleSpecifier: '', config: '' })
}

function removeAdapter(index: number) {
	if (props.readOnly) return
	localAdapters.value.splice(index, 1)
}

function addViewport() {
	if (props.readOnly) return
	const nextId = `viewport-${localViewports.value.length + 1}`
	localViewports.value.push({ id: nextId, width: 1280, height: 800 })
}

function removeViewport(index: number) {
	if (props.readOnly) return
	localViewports.value.splice(index, 1)
}

function addTheme() {
	if (props.readOnly) return
	const nextId = `theme-${localThemes.value.length + 1}`
	localThemes.value.push({ id: nextId })
}

function removeTheme(index: number) {
	if (props.readOnly) return
	localThemes.value.splice(index, 1)
}

async function handleSave() {
	if (props.readOnly) return
	if (!props.workspace) return
	saving.value = true
	saveError.value = undefined
	conflict.value = false

	const viewportsPayload: Record<string, { dimensions: { width: number; height: number } }> = {}
	for (const vp of localViewports.value) {
		const key = vp.id.trim()
		if (key) {
			viewportsPayload[key] = {
				dimensions: {
					width: Number(vp.width) || 1280,
					height: Number(vp.height) || 800,
				},
			}
		}
	}

	const themesPayload: Record<string, Record<string, unknown>> = {}
	for (const th of localThemes.value) {
		const key = th.id.trim()
		if (key) {
			themesPayload[key] = {}
		}
	}

	const adaptersPayload = localAdapters.value
		.map(a => {
			let conf: unknown = undefined
			if (a.config.trim()) {
				try {
					conf = JSON.parse(a.config)
				}
				catch {
					conf = a.config
				}
			}
			return {
				moduleSpecifier: a.moduleSpecifier.trim(),
				...(conf !== undefined ? { config: conf } : {}),
			}
		})
		.filter(a => a.moduleSpecifier.length > 0)

	try {
		const result = await $fetch('/api/workspace/settings', {
			method: 'PUT',
			body: {
				expectedRevision: props.workspace.revision,
				settings: {
					i18n: { defaultLocale: defaultLocale.value.trim() },
					adapters: adaptersPayload,
					viewports: viewportsPayload,
					themes: themesPayload,
				},
			},
		})
		feedback.success(t('workspaceSettings.saved'))
		emit('saved', result)
		emit('changed')
	}
	catch (err: unknown) {
		const errorObj = err as { status?: number; statusCode?: number }
		if (errorObj?.status === 409 || errorObj?.statusCode === 409) {
			conflict.value = true
		}
		else {
			saveError.value = feedback.error(err, t('workspaceSettings.saveFailed'))
		}
	}
	finally {
		saving.value = false
	}
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col space-y-5 overflow-y-auto p-4 text-xs text-default">
    <div class="flex items-start justify-between gap-2 border-b border-default pb-3">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold text-highlighted">
          {{ t('workspaceSettings.title') }}
        </h2>
        <i18n-t
          keypath="workspaceSettings.subtitle"
          tag="p"
          scope="global"
          class="text-xs text-muted"
        >
          <template #file>
            <code class="font-mono">.uiux/workspace.json</code>
          </template>
        </i18n-t>
      </div>
      <UBadge
        v-if="workspace"
        color="neutral"
        variant="subtle"
        size="xs"
        class="shrink-0 font-mono"
        :title="workspace.revision"
      >
        {{ t('workspaceSettings.revisionBadge', { revision: `${workspace.revision.slice(0, 14)}…` }) }}
      </UBadge>
    </div>

    <!-- Conflict State Alert -->
    <UAlert
      v-if="conflict"
      color="error"
      variant="subtle"
      icon="i-lucide-git-compare-arrows"
      :title="t('workspaceSettings.conflict.title')"
      :description="t('workspaceSettings.conflict.description')"
      :actions="[{
        label: t('workspaceSettings.conflict.reload'),
        color: 'error',
        variant: 'solid',
        size: 'xs',
        icon: 'i-lucide-refresh-cw',
        onClick: () => emit('reload'),
      }]"
    />

    <!-- Error Alert -->
    <UAlert
      v-else-if="saveError"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="t('workspaceSettings.saveFailed')"
      close
      @update:open="saveError = undefined"
    >
      <template #description>
        <p>{{ saveError.message }}</p>
        <ul
          v-if="saveError.diagnostics.length > 1"
          class="mt-1 list-disc space-y-0.5 pl-4"
        >
          <li
            v-for="(diag, idx) in saveError.diagnostics"
            :key="idx"
            class="break-words"
          >
            <code
              v-if="diag.path"
              class="font-mono"
            >{{ diag.path }}</code>
            {{ diag.message }}
          </li>
        </ul>
      </template>
    </UAlert>

    <!-- Form Section: i18n Default Locale -->
    <UFormField
      :label="t('workspaceSettings.defaultLocale.label')"
      :description="t('workspaceSettings.defaultLocale.description')"
      size="xs"
    >
      <UInput
        v-model="defaultLocale"
        :disabled="readOnly"
        size="xs"
        placeholder="en-US"
        class="w-full"
        :ui="{ base: 'font-mono' }"
      />
    </UFormField>

    <USeparator />

    <!-- Form Section: Adapters -->
    <section
      id="workspace-adapters"
      class="scroll-mt-4 space-y-2"
    >
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <h3 class="flex items-center gap-1.5 font-medium text-highlighted">
            {{ t('workspaceSettings.adapters.title') }}
            <UBadge
              color="neutral"
              variant="subtle"
              size="xs"
            >
              {{ localAdapters.length }}
            </UBadge>
          </h3>
          <p class="text-xs text-muted">
            {{ t('workspaceSettings.adapters.description') }}
          </p>
        </div>
        <UButton
          v-if="!readOnly"
          color="neutral"
          variant="outline"
          size="xs"
          icon="i-lucide-plus"
          class="shrink-0"
          @click="addAdapter"
        >
          {{ t('workspaceSettings.adapters.add') }}
        </UButton>
      </div>

      <div
        v-if="localAdapters.length"
        class="space-y-2"
      >
        <UCard
          v-for="(adapter, idx) in localAdapters"
          :key="idx"
          variant="subtle"
          :ui="{ body: 'space-y-2 p-2.5 sm:p-2.5' }"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-medium text-muted">{{ t('workspaceSettings.adapters.item', { n: idx + 1 }) }}</span>
            <UButton
              v-if="!readOnly"
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-trash-2"
              :aria-label="t('workspaceSettings.adapters.remove', { n: idx + 1 })"
              @click="removeAdapter(idx)"
            />
          </div>
          <UFormField
            :label="t('workspaceSettings.adapters.moduleSpecifier')"
            size="xs"
          >
            <UInput
              v-model="adapter.moduleSpecifier"
              :disabled="readOnly"
              size="xs"
              placeholder="@package/adapter"
              class="w-full"
              :ui="{ base: 'font-mono' }"
            />
          </UFormField>
          <UFormField
            :label="t('workspaceSettings.adapters.config')"
            :hint="t('workspaceSettings.adapters.configHint')"
            size="xs"
          >
            <UTextarea
              v-model="adapter.config"
              :disabled="readOnly"
              size="xs"
              :rows="1"
              autoresize
              :maxrows="8"
              placeholder="{}"
              class="w-full"
              :ui="{ base: 'font-mono' }"
            />
          </UFormField>
        </UCard>
      </div>
      <UEmpty
        v-else
        size="xs"
        variant="outline"
        icon="i-lucide-puzzle"
        :description="t('workspaceSettings.adapters.empty')"
        :ui="{ root: 'p-3 sm:p-3 lg:p-3 gap-2' }"
      />
    </section>

    <USeparator />

    <!-- Form Section: Viewports -->
    <section class="space-y-2">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <h3 class="flex items-center gap-1.5 font-medium text-highlighted">
            {{ t('workspaceSettings.viewports.title') }}
            <UBadge
              color="neutral"
              variant="subtle"
              size="xs"
            >
              {{ localViewports.length }}
            </UBadge>
          </h3>
          <p class="text-xs text-muted">
            {{ t('workspaceSettings.viewports.description') }}
          </p>
        </div>
        <UButton
          v-if="!readOnly"
          color="neutral"
          variant="outline"
          size="xs"
          icon="i-lucide-plus"
          class="shrink-0"
          @click="addViewport"
        >
          {{ t('workspaceSettings.viewports.add') }}
        </UButton>
      </div>

      <div
        v-if="localViewports.length"
        class="space-y-2"
      >
        <UCard
          v-for="(vp, idx) in localViewports"
          :key="idx"
          variant="subtle"
          :ui="{ body: 'space-y-2 p-2.5 sm:p-2.5' }"
        >
          <div class="flex items-end gap-2">
            <UFormField
              :label="t('workspaceSettings.viewports.id')"
              size="xs"
              class="min-w-0 flex-1"
            >
              <UInput
                v-model="vp.id"
                :disabled="readOnly"
                size="xs"
                :placeholder="t('workspaceSettings.viewports.idPlaceholder')"
                class="w-full"
                :ui="{ base: 'font-mono' }"
              />
            </UFormField>
            <UButton
              v-if="!readOnly"
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-trash-2"
              :aria-label="t('workspaceSettings.viewports.remove', { id: vp.id || idx + 1 })"
              @click="removeViewport(idx)"
            />
          </div>
          <div class="grid grid-cols-2 gap-2">
            <UFormField
              :label="t('workspaceSettings.viewports.width')"
              size="xs"
            >
              <UInputNumber
                v-model="vp.width"
                :disabled="readOnly"
                :min="1"
                :format-options="dimensionFormat"
                size="xs"
                class="w-full"
              />
            </UFormField>
            <UFormField
              :label="t('workspaceSettings.viewports.height')"
              size="xs"
            >
              <UInputNumber
                v-model="vp.height"
                :disabled="readOnly"
                :min="1"
                :format-options="dimensionFormat"
                size="xs"
                class="w-full"
              />
            </UFormField>
          </div>
        </UCard>
      </div>
      <UEmpty
        v-else
        size="xs"
        variant="outline"
        icon="i-lucide-monitor-smartphone"
        :description="t('workspaceSettings.viewports.empty')"
        :ui="{ root: 'p-3 sm:p-3 lg:p-3 gap-2' }"
      />
    </section>

    <USeparator />

    <!-- Form Section: Themes (Workspace preview themes, not the Workbench appearance) -->
    <section class="space-y-2">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <h3 class="flex items-center gap-1.5 font-medium text-highlighted">
            {{ t('workspaceSettings.themes.title') }}
            <UBadge
              color="neutral"
              variant="subtle"
              size="xs"
            >
              {{ localThemes.length }}
            </UBadge>
          </h3>
          <p class="text-xs text-muted">
            {{ t('workspaceSettings.themes.description') }}
          </p>
        </div>
        <UButton
          v-if="!readOnly"
          color="neutral"
          variant="outline"
          size="xs"
          icon="i-lucide-plus"
          class="shrink-0"
          @click="addTheme"
        >
          {{ t('workspaceSettings.themes.add') }}
        </UButton>
      </div>
      <UAlert
        color="info"
        variant="subtle"
        icon="i-lucide-info"
        :description="t('workspaceSettings.themes.notAppearance')"
        :ui="{ description: 'text-xs' }"
      />

      <div
        v-if="localThemes.length"
        class="space-y-1.5"
      >
        <div
          v-for="(th, idx) in localThemes"
          :key="idx"
          class="flex items-center gap-2"
        >
          <UInput
            v-model="th.id"
            :disabled="readOnly"
            size="xs"
            :placeholder="t('workspaceSettings.themes.idPlaceholder')"
            :aria-label="t('workspaceSettings.themes.idLabel', { n: idx + 1 })"
            class="min-w-0 flex-1"
            :ui="{ base: 'font-mono' }"
          />
          <UButton
            v-if="!readOnly"
            color="neutral"
            variant="ghost"
            size="xs"
            icon="i-lucide-trash-2"
            :aria-label="t('workspaceSettings.themes.remove', { id: th.id || idx + 1 })"
            @click="removeTheme(idx)"
          />
        </div>
      </div>
      <UEmpty
        v-else
        size="xs"
        variant="outline"
        icon="i-lucide-palette"
        :description="t('workspaceSettings.themes.empty')"
        :ui="{ root: 'p-3 sm:p-3 lg:p-3 gap-2' }"
      />
    </section>

    <!-- Manifest Diagnostics -->
    <UAlert
      v-if="workspace?.diagnostics?.length"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('workspaceSettings.diagnostics.title', { n: workspace.diagnostics.length }, workspace.diagnostics.length)"
    >
      <template #description>
        <ul class="mt-1 space-y-1.5">
          <li
            v-for="diag in workspace.diagnostics"
            :key="diag.code + diag.path"
            class="break-words"
          >
            <span class="font-mono font-semibold">{{ diag.code }}</span>
            <span
              v-if="diag.path"
              class="ml-1 font-mono text-muted"
            >{{ diag.path }}</span>
            <p class="mt-0.5">
              {{ diag.message }}
            </p>
          </li>
        </ul>
      </template>
    </UAlert>

    <!-- Actions -->
    <div
      v-if="!readOnly"
      class="flex items-center justify-between border-t border-default pt-3"
    >
      <UButton
        color="neutral"
        variant="ghost"
        size="xs"
        icon="i-lucide-undo-2"
        @click="syncFromProps"
      >
        {{ t('workspaceSettings.reset') }}
      </UButton>
      <UButton
        color="primary"
        variant="solid"
        size="sm"
        icon="i-lucide-save"
        :loading="saving"
        :disabled="!workspace"
        @click="handleSave"
      >
        {{ saving ? t('common.saving') : t('workspaceSettings.save') }}
      </UButton>
    </div>
  </div>
</template>
