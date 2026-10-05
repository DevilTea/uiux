<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import type { ViewportOption } from '../../../src/preview/render-context-options'

/**
 * The render-context bar (brief b, sections 5 and 6): Variant, Locale, viewport and theme of the
 * previewed View. Each control is a ghost select showing icon, label and the effective value, never
 * a blank placeholder. A dimension with nothing authored says so in its menu; an invalid selection is
 * listed disabled with the reason. The bar changes only the Preview render context, never the
 * Workbench chrome locale or appearance.
 *
 * `layout="bar"` is the desktop toolbar row; `layout="stacked"` is the compact summary popover.
 */
const props = withDefaults(defineProps<{ layout?: 'bar' | 'stacked' }>(), { layout: 'bar' })

const { t } = useI18n()
const workbench = useWorkbench()
const { contextOptions, selectedVariant, selectedLocale, selectedViewportId, selectedThemeId } = workbench

// reka-ui Select items cannot use '' as a value, so the base (no Variant) state uses a sentinel.
const BASE_VARIANT = '__uiux_base_variant__'

const variantModel = computed({
	get: () => contextOptions.value.variants.selected || BASE_VARIANT,
	set: (value: string) => { selectedVariant.value = value === BASE_VARIANT ? '' : value },
})
const localeModel = computed({
	get: () => contextOptions.value.locales.selected,
	set: (value: string) => { selectedLocale.value = value },
})
const viewportModel = computed({
	get: () => contextOptions.value.viewports.selectedId,
	set: (value: string) => { selectedViewportId.value = value },
})
const themeModel = computed({
	get: () => contextOptions.value.themes.selected,
	set: (value: string) => { selectedThemeId.value = value },
})

type ContextItem = {
	label: string
	value?: string
	type?: 'label' | 'item'
	disabled?: boolean
	description?: string
	icon?: string
	dims?: string
	primary?: boolean
}

const invalidItem = (value: string): ContextItem => ({ label: value, value, disabled: true, icon: 'i-lucide-circle-alert', description: t('ctx.notInWorkspace') })

const variantItems = computed<ContextItem[]>(() => {
	const options = contextOptions.value.variants
	const items: ContextItem[] = [
		{ label: t('ctx.base'), value: BASE_VARIANT },
		...options.available.map(name => ({ label: name, value: name })),
	]
	if (!options.hasVariants) items.push({ type: 'label', label: t('workbench.context.noVariantsHint') })
	if (options.isInvalid && options.selected) items.push(invalidItem(options.selected))
	return items
})

const localeItems = computed<ContextItem[]>(() => {
	const options = contextOptions.value.locales
	const items: ContextItem[] = options.available.map(code => ({ label: code, value: code, primary: code === options.defaultLocale }))
	if (options.isInvalid) items.push(invalidItem(options.selected))
	return items
})

function viewportName(option: ViewportOption): string {
	return option.isDefault ? t('workbench.context.defaultViewportName') : (option.label ?? option.id)
}

function viewportDims(width: number, height: number): string {
	return t('canvas.dimensions', { width, height })
}

const viewportItems = computed<ContextItem[]>(() => {
	const options = contextOptions.value.viewports
	const items: ContextItem[] = options.available.map(option => ({ label: viewportName(option), value: option.id, dims: viewportDims(option.width, option.height) }))
	if (options.isEmpty) items.push({ type: 'label', label: t('workbench.context.noViewportsHint') })
	if (options.isInvalid) items.push(invalidItem(options.selectedId))
	return items
})

const themeItems = computed<ContextItem[]>(() => {
	const options = contextOptions.value.themes
	if (options.isEmpty)
		return [
			{ label: t('workbench.context.defaultThemeOption', { theme: options.selected }), value: options.selected },
			{ type: 'label', label: t('workbench.context.noThemesHint') },
		]
	const items: ContextItem[] = options.options.map(option => ({ label: option.label ?? option.id, value: option.id }))
	if (options.isInvalid) items.push(invalidItem(options.selected))
	return items
})

const values = computed(() => {
	const options = contextOptions.value
	const viewport = options.viewports.available.find(option => option.id === options.viewports.selectedId)
	const theme = options.themes.options.find(option => option.id === options.themes.selected)
	return {
		variant: options.variants.selected || t('ctx.base'),
		locale: options.locales.selected,
		viewport: viewport ? viewportName(viewport) : options.viewports.selectedId,
		viewportDims: viewportDims(options.viewports.selectedDimensions.width, options.viewports.selectedDimensions.height),
		theme: theme?.label ?? options.themes.selected,
	}
})

/** Opened by `Shift V`, `Shift L` and `Shift T` from the canvas. */
const open = ref({ variant: false, locale: false, viewport: false, theme: false })
defineExpose({ openMenu: (dimension: keyof typeof open.value) => { open.value[dimension] = true } })

const isBar = computed(() => props.layout === 'bar')
const selectUi = computed(() => ({
	base: isBar.value ? 'h-7 hover:bg-elevated max-w-72' : 'w-full hover:bg-elevated',
	leadingIcon: 'size-4 text-dimmed',
	trailingIcon: 'size-3.5 text-dimmed',
	content: 'min-w-60 w-auto max-w-[min(24rem,90vw)]',
	itemDescription: 'text-xs',
	label: 'font-normal text-muted text-xs/4 whitespace-normal',
}))
</script>

<template>
  <div
    role="group"
    :aria-label="t('workbench.context.groupLabel')"
    :class="isBar ? 'flex min-w-0 items-center gap-0.5' : 'grid gap-2'"
    data-render-context
  >
    <USelectMenu
      v-model="variantModel"
      v-model:open="open.variant"
      :items="variantItems"
      value-key="value"
      variant="ghost"
      size="sm"
      icon="i-lucide-layers"
      trailing-icon="i-lucide-chevron-down"
      :search-input="variantItems.length > 8 ? { placeholder: t('ctx.searchVariants') } : false"
      :color="contextOptions.variants.isInvalid ? 'error' : 'neutral'"
      :highlight="contextOptions.variants.isInvalid"
      :aria-label="t('workbench.context.variant')"
      :ui="selectUi"
      data-context="variant"
    >
      <span class="flex min-w-0 items-baseline gap-1.5">
        <span class="shrink-0 text-muted">{{ t('ctx.variant') }}</span>
        <span
          class="truncate font-medium"
          :class="contextOptions.variants.isInvalid ? 'text-error' : 'text-highlighted'"
        >{{ values.variant }}</span>
      </span>
    </USelectMenu>

    <USeparator
      v-if="isBar"
      orientation="vertical"
      class="mx-1 h-4"
    />

    <USelect
      v-model="localeModel"
      v-model:open="open.locale"
      :items="localeItems"
      variant="ghost"
      size="sm"
      icon="i-lucide-languages"
      trailing-icon="i-lucide-chevron-down"
      :color="contextOptions.locales.isInvalid ? 'error' : 'neutral'"
      :highlight="contextOptions.locales.isInvalid"
      :aria-label="t('workbench.context.locale')"
      :ui="selectUi"
      data-context="locale"
    >
      <span class="flex min-w-0 items-baseline gap-1.5">
        <span class="shrink-0 text-muted">{{ t('ctx.locale') }}</span>
        <span
          class="truncate font-medium"
          :class="contextOptions.locales.isInvalid ? 'text-error' : 'text-highlighted'"
        >{{ values.locale }}</span>
      </span>
      <template #item-trailing="{ item }">
        <UBadge
          v-if="(item as ContextItem).primary"
          color="neutral"
          variant="soft"
          size="sm"
        >
          {{ t('ctx.primaryLocale') }}
        </UBadge>
      </template>
    </USelect>

    <USeparator
      v-if="isBar"
      orientation="vertical"
      class="mx-1 h-4"
    />

    <USelect
      v-model="viewportModel"
      v-model:open="open.viewport"
      :items="viewportItems"
      variant="ghost"
      size="sm"
      icon="i-lucide-monitor-smartphone"
      trailing-icon="i-lucide-chevron-down"
      :color="contextOptions.viewports.isInvalid ? 'error' : 'neutral'"
      :highlight="contextOptions.viewports.isInvalid"
      :aria-label="t('workbench.context.viewport')"
      :ui="selectUi"
      data-context="viewport"
    >
      <span class="flex min-w-0 items-baseline gap-1.5">
        <span class="shrink-0 text-muted">{{ t('ctx.viewport') }}</span>
        <span
          class="truncate font-medium"
          :class="contextOptions.viewports.isInvalid ? 'text-error' : 'text-highlighted'"
        >{{ values.viewport }}</span>
        <span class="shrink-0 font-mono text-xs text-muted">{{ values.viewportDims }}</span>
      </span>
      <template #item-trailing="{ item }">
        <span
          v-if="(item as ContextItem).dims"
          class="font-mono text-xs text-muted"
        >{{ (item as ContextItem).dims }}</span>
      </template>
    </USelect>

    <USeparator
      v-if="isBar"
      orientation="vertical"
      class="mx-1 h-4"
    />

    <USelect
      v-model="themeModel"
      v-model:open="open.theme"
      :items="themeItems"
      variant="ghost"
      size="sm"
      icon="i-lucide-sun-moon"
      trailing-icon="i-lucide-chevron-down"
      :color="contextOptions.themes.isInvalid ? 'error' : 'neutral'"
      :highlight="contextOptions.themes.isInvalid"
      :aria-label="t('workbench.context.theme')"
      :title="t('ctx.themeHint')"
      :ui="selectUi"
      data-context="theme"
    >
      <span class="flex min-w-0 items-baseline gap-1.5">
        <span class="shrink-0 text-muted">{{ t('ctx.theme') }}</span>
        <span
          class="truncate font-medium"
          :class="contextOptions.themes.isInvalid ? 'text-error' : 'text-highlighted'"
        >{{ values.theme }}</span>
      </span>
    </USelect>
  </div>
</template>
