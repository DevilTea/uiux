<script setup lang="ts">
import { ref, watch } from 'vue'
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
}>()

const emit = defineEmits<{
	(e: 'saved', result: unknown): void
	(e: 'reload'): void
}>()

interface LocalAdapter {
	moduleSpecifier: string
	config: string
}

interface LocalViewport {
	id: string
	width: number
	height: number
}

interface LocalTheme {
	id: string
}

const defaultLocale = ref('en-US')
const localAdapters = ref<LocalAdapter[]>([])
const localViewports = ref<LocalViewport[]>([])
const localThemes = ref<LocalTheme[]>([])

const saving = ref(false)
const saveError = ref<string>()
const conflict = ref(false)
const saveSuccess = ref(false)

function syncFromProps() {
	conflict.value = false
	saveError.value = undefined
	saveSuccess.value = false
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
	localAdapters.value.push({ moduleSpecifier: '', config: '' })
}

function removeAdapter(index: number) {
	localAdapters.value.splice(index, 1)
}

function addViewport() {
	const nextId = `viewport-${localViewports.value.length + 1}`
	localViewports.value.push({ id: nextId, width: 1280, height: 800 })
}

function removeViewport(index: number) {
	localViewports.value.splice(index, 1)
}

function addTheme() {
	const nextId = `theme-${localThemes.value.length + 1}`
	localThemes.value.push({ id: nextId })
}

function removeTheme(index: number) {
	localThemes.value.splice(index, 1)
}

async function handleSave() {
	if (!props.workspace) return
	saving.value = true
	saveError.value = undefined
	conflict.value = false
	saveSuccess.value = false

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
		saveSuccess.value = true
		emit('saved', result)
	}
	catch (err: unknown) {
		const errorObj = err as { status?: number; statusCode?: number; data?: { message?: string } }
		if (errorObj?.status === 409 || errorObj?.statusCode === 409) {
			conflict.value = true
		}
		else {
			saveError.value = errorObj?.data?.message || (err instanceof Error ? err.message : 'Failed to update workspace settings')
		}
	}
	finally {
		saving.value = false
	}
}
</script>

<template>
  <div class="flex h-full flex-col overflow-y-auto p-4 text-xs text-neutral-200 space-y-5">
    <div class="flex items-center justify-between border-b border-neutral-800 pb-3">
      <div>
        <h2 class="text-sm font-semibold text-white">
          Workspace Settings
        </h2>
        <p class="text-[11px] text-neutral-400">
          Canonical manifest configuration (.uiux/workspace.json)
        </p>
      </div>
      <div
        v-if="workspace"
        class="text-right"
      >
        <span class="rounded bg-neutral-800 px-2 py-0.5 font-mono text-[10px] text-neutral-400">
          Rev: {{ workspace.revision.slice(0, 14) }}…
        </span>
      </div>
    </div>

    <!-- Conflict State Alert -->
    <div
      v-if="conflict"
      class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-amber-300 space-y-2"
    >
      <div class="flex items-center gap-1.5 font-semibold text-amber-400">
        <span>⚠ Stale Revision Conflict (409)</span>
      </div>
      <p class="text-[11px] leading-relaxed">
        The workspace manifest was updated by another process. Your observed revision is stale. To prevent accidental overwrites, please reload the latest state.
      </p>
      <UButton
        color="warning"
        variant="solid"
        size="xs"
        @click="emit('reload')"
      >
        Reload Latest Manifest
      </UButton>
    </div>

    <!-- Error Alert -->
    <div
      v-else-if="saveError"
      class="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-red-300"
    >
      <p class="font-medium text-red-400">
        Update Failed
      </p>
      <p class="mt-1 text-[11px]">
        {{ saveError }}
      </p>
    </div>

    <!-- Success Alert -->
    <div
      v-else-if="saveSuccess"
      class="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2.5 text-emerald-300"
    >
      ✓ Workspace settings updated successfully.
    </div>

    <!-- Form Section: i18n Default Locale -->
    <div class="space-y-1.5">
      <label class="block font-medium text-neutral-300">Default Locale (i18n)</label>
      <p class="text-[11px] text-neutral-500">
        Canonical BCP 47 primary locale tag for the Workspace.
      </p>
      <UInput
        v-model="defaultLocale"
        size="xs"
        placeholder="en-US"
        class="w-full font-mono"
      />
    </div>

    <!-- Form Section: Adapters -->
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <div>
          <label class="font-medium text-neutral-300">Adapters ({{ localAdapters.length }})</label>
          <p class="text-[11px] text-neutral-500">
            Registered widget packages or local adapter specifiers.
          </p>
        </div>
        <UButton
          color="neutral"
          variant="outline"
          size="xs"
          @click="addAdapter"
        >
          + Add Adapter
        </UButton>
      </div>

      <div
        v-if="localAdapters.length"
        class="space-y-2"
      >
        <div
          v-for="(adapter, idx) in localAdapters"
          :key="idx"
          class="rounded border border-neutral-800 bg-neutral-900/60 p-2.5 space-y-2"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-[10px] font-semibold text-neutral-400 uppercase">Adapter {{ idx + 1 }}</span>
            <button
              type="button"
              class="text-neutral-500 hover:text-red-400 text-xs"
              @click="removeAdapter(idx)"
            >
              ✕ Remove
            </button>
          </div>
          <div>
            <span class="text-[10px] text-neutral-500">Module Specifier:</span>
            <UInput
              v-model="adapter.moduleSpecifier"
              size="xs"
              placeholder="@package/adapter or ./adapters/custom.ts"
              class="w-full font-mono mt-0.5"
            />
          </div>
          <div>
            <span class="text-[10px] text-neutral-500">Config (Optional JSON):</span>
            <UInput
              v-model="adapter.config"
              size="xs"
              placeholder="{}"
              class="w-full font-mono mt-0.5"
            />
          </div>
        </div>
      </div>
      <div
        v-else
        class="rounded border border-dashed border-neutral-800 p-3 text-center text-neutral-500 text-[11px]"
      >
        No adapters configured. Only RootShell is active.
      </div>
    </div>

    <!-- Form Section: Viewports -->
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <div>
          <label class="font-medium text-neutral-300">Viewports ({{ localViewports.length }})</label>
          <p class="text-[11px] text-neutral-500">
            Preset canvas dimensions available in render context.
          </p>
        </div>
        <UButton
          color="neutral"
          variant="outline"
          size="xs"
          @click="addViewport"
        >
          + Add Viewport
        </UButton>
      </div>

      <div
        v-if="localViewports.length"
        class="space-y-2"
      >
        <div
          v-for="(vp, idx) in localViewports"
          :key="idx"
          class="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900/60 p-2"
        >
          <div class="flex-1">
            <span class="text-[10px] text-neutral-500">Preset ID:</span>
            <UInput
              v-model="vp.id"
              size="xs"
              placeholder="e.g. mobile"
              class="font-mono mt-0.5"
            />
          </div>
          <div class="w-20">
            <span class="text-[10px] text-neutral-500">Width:</span>
            <UInput
              v-model.number="vp.width"
              type="number"
              size="xs"
              class="font-mono mt-0.5"
            />
          </div>
          <div class="w-20">
            <span class="text-[10px] text-neutral-500">Height:</span>
            <UInput
              v-model.number="vp.height"
              type="number"
              size="xs"
              class="font-mono mt-0.5"
            />
          </div>
          <button
            type="button"
            class="text-neutral-500 hover:text-red-400 self-end mb-1 text-xs px-1"
            title="Remove viewport"
            @click="removeViewport(idx)"
          >
            ✕
          </button>
        </div>
      </div>
      <div
        v-else
        class="rounded border border-dashed border-neutral-800 p-3 text-center text-neutral-500 text-[11px]"
      >
        No custom viewports defined. (Default fallback 1280 × 800)
      </div>
    </div>

    <!-- Form Section: Themes -->
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <div>
          <label class="font-medium text-neutral-300">Themes ({{ localThemes.length }})</label>
          <p class="text-[11px] text-neutral-500">
            Theme IDs supported by workspace components.
          </p>
        </div>
        <UButton
          color="neutral"
          variant="outline"
          size="xs"
          @click="addTheme"
        >
          + Add Theme
        </UButton>
      </div>

      <div
        v-if="localThemes.length"
        class="space-y-1.5"
      >
        <div
          v-for="(th, idx) in localThemes"
          :key="idx"
          class="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900/60 p-2"
        >
          <div class="flex-1">
            <UInput
              v-model="th.id"
              size="xs"
              placeholder="e.g. dark, light"
              class="font-mono"
            />
          </div>
          <button
            type="button"
            class="text-neutral-500 hover:text-red-400 text-xs px-1"
            title="Remove theme"
            @click="removeTheme(idx)"
          >
            ✕
          </button>
        </div>
      </div>
      <div
        v-else
        class="rounded border border-dashed border-neutral-800 p-3 text-center text-neutral-500 text-[11px]"
      >
        No custom themes configured.
      </div>
    </div>

    <!-- Manifest Diagnostics -->
    <div
      v-if="workspace?.diagnostics?.length"
      class="space-y-1.5"
    >
      <p class="font-medium text-amber-400">
        Manifest Diagnostics ({{ workspace.diagnostics.length }})
      </p>
      <div
        v-for="diag in workspace.diagnostics"
        :key="diag.code + diag.path"
        class="rounded bg-amber-500/10 p-2 text-amber-200"
      >
        <span class="font-mono font-semibold">[{{ diag.code }}]</span>
        <span class="ml-1 font-mono text-neutral-400">{{ diag.path }}</span>
        <p class="mt-0.5 text-neutral-300">
          {{ diag.message }}
        </p>
      </div>
    </div>

    <!-- Actions -->
    <div class="pt-2 border-t border-neutral-800 flex items-center justify-between">
      <UButton
        color="neutral"
        variant="ghost"
        size="xs"
        @click="syncFromProps"
      >
        Reset Changes
      </UButton>
      <UButton
        color="primary"
        variant="solid"
        size="sm"
        :loading="saving"
        @click="handleSave"
      >
        Save Settings
      </UButton>
    </div>
  </div>
</template>
