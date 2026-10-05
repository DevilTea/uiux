<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import type { ViewportOption } from '../../../src/preview/render-context-options'

/**
 * Render context selection for the previewed View (Workspace variant, locale,
 * viewport preset and theme). Every select shows the effective value the
 * preview actually renders, never a blank placeholder.
 */
const { t } = useI18n()
const workbench = useWorkbench()
const { contextOptions, selectedVariant, selectedLocale, selectedViewportId, selectedThemeId } = workbench

// reka-ui Select items cannot use '' as a value, so the base (no variant) state uses a sentinel.
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

const variantItems = computed(() => [
	{ label: t('workbench.context.baseVariant'), value: BASE_VARIANT },
	...contextOptions.value.variants.available.map(name => ({ label: name, value: name })),
	...(contextOptions.value.variants.isInvalid && contextOptions.value.variants.selected
		? [{ label: contextOptions.value.variants.selected, value: contextOptions.value.variants.selected, disabled: true }]
		: []),
])

const localeItems = computed(() => {
	const items = contextOptions.value.locales.available.map(code => ({
		label: code === contextOptions.value.locales.defaultLocale ? t('workbench.context.defaultLocaleOption', { locale: code }) : code,
		value: code,
	}))
	if (contextOptions.value.locales.isInvalid)
		items.push({ label: contextOptions.value.locales.selected, value: contextOptions.value.locales.selected })
	return items
})

function viewportLabel(option: ViewportOption): string {
	const name = option.isDefault ? t('workbench.context.defaultViewportName') : (option.label ?? option.id)
	return t('workbench.context.viewportOption', { name, width: option.width, height: option.height })
}

const viewportItems = computed(() => {
	const items = contextOptions.value.viewports.available.map(option => ({ label: viewportLabel(option), value: option.id }))
	if (contextOptions.value.viewports.isInvalid)
		items.push({ label: contextOptions.value.viewports.selectedId, value: contextOptions.value.viewports.selectedId })
	return items
})

const themeItems = computed(() => {
	if (contextOptions.value.themes.isEmpty)
		return [{ label: t('workbench.context.defaultThemeOption', { theme: contextOptions.value.themes.selected }), value: contextOptions.value.themes.selected }]
	const items = contextOptions.value.themes.options.map(option => ({ label: option.label ?? option.id, value: option.id }))
	if (contextOptions.value.themes.isInvalid)
		items.push({ label: contextOptions.value.themes.selected, value: contextOptions.value.themes.selected })
	return items
})

const variantHint = computed(() => contextOptions.value.variants.hasVariants ? undefined : t('workbench.context.noVariantsHint'))
const viewportHint = computed(() => contextOptions.value.viewports.isEmpty ? t('workbench.context.noViewportsHint') : undefined)
const themeHint = computed(() => contextOptions.value.themes.isEmpty ? t('workbench.context.noThemesHint') : t('workbench.context.themeHint'))
</script>

<template>
  <div
    role="group"
    :aria-label="t('workbench.context.groupLabel')"
    class="flex min-w-0 items-center gap-2.5"
  >
    <UFormField
      :label="t('workbench.context.variant')"
      orientation="horizontal"
      size="xs"
      :ui="{ root: 'items-center', label: 'text-muted font-normal whitespace-nowrap', container: 'flex items-center gap-1' }"
    >
      <USelect
        v-model="variantModel"
        :items="variantItems"
        size="xs"
        :disabled="!contextOptions.variants.hasVariants"
        :color="contextOptions.variants.isInvalid ? 'error' : undefined"
        :highlight="contextOptions.variants.isInvalid"
        class="w-36"
      />
      <UTooltip
        v-if="variantHint"
        :text="variantHint"
      >
        <UIcon
          name="i-lucide-info"
          class="size-3.5 text-dimmed"
          tabindex="0"
          role="img"
          :aria-label="variantHint"
        />
      </UTooltip>
    </UFormField>

    <UFormField
      :label="t('workbench.context.locale')"
      orientation="horizontal"
      size="xs"
      :ui="{ root: 'items-center', label: 'text-muted font-normal whitespace-nowrap', container: 'flex items-center gap-1' }"
    >
      <USelect
        v-model="localeModel"
        :items="localeItems"
        size="xs"
        :disabled="!contextOptions.locales.hasAdditionalLocales && !contextOptions.locales.isInvalid"
        :color="contextOptions.locales.isInvalid ? 'error' : undefined"
        :highlight="contextOptions.locales.isInvalid"
        class="w-32"
      />
    </UFormField>

    <UFormField
      :label="t('workbench.context.viewport')"
      orientation="horizontal"
      size="xs"
      :ui="{ root: 'items-center', label: 'text-muted font-normal whitespace-nowrap', container: 'flex items-center gap-1' }"
    >
      <USelect
        v-model="viewportModel"
        :items="viewportItems"
        size="xs"
        :disabled="contextOptions.viewports.isEmpty"
        :color="contextOptions.viewports.isInvalid ? 'error' : contextOptions.viewports.isEmpty ? 'warning' : undefined"
        :highlight="contextOptions.viewports.isInvalid || contextOptions.viewports.isEmpty"
        class="w-44"
      />
      <UTooltip
        v-if="viewportHint"
        :text="viewportHint"
      >
        <UIcon
          name="i-lucide-info"
          class="size-3.5 text-dimmed"
          tabindex="0"
          role="img"
          :aria-label="viewportHint"
        />
      </UTooltip>
    </UFormField>

    <UFormField
      :label="t('workbench.context.theme')"
      orientation="horizontal"
      size="xs"
      :ui="{ root: 'items-center', label: 'text-muted font-normal whitespace-nowrap', container: 'flex items-center gap-1' }"
    >
      <USelect
        v-model="themeModel"
        :items="themeItems"
        size="xs"
        icon="i-lucide-swatch-book"
        :disabled="contextOptions.themes.isEmpty"
        :color="contextOptions.themes.isInvalid ? 'error' : undefined"
        :highlight="contextOptions.themes.isInvalid"
        class="w-28"
      />
      <UTooltip
        v-if="themeHint"
        :text="themeHint"
      >
        <UIcon
          name="i-lucide-info"
          class="size-3.5 text-dimmed"
          tabindex="0"
          role="img"
          :aria-label="themeHint"
        />
      </UTooltip>
    </UFormField>
  </div>
</template>
