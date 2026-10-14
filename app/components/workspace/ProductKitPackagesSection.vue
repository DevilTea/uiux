<script setup lang="ts">
import { useI18n } from '#imports'
import type { ProductKitPackage } from '../../../src/application/services/product-kit-authoring'

/**
 * Packages, in the Overview section of the Product Kit page (Rule 01a11bb1-b918-7cb5-b581-a3fd3f647f09):
 * the Design System packages the Product Kit file lists in `designSystems`, in file order, each with
 * what `uiux://product-kit` reports about it (installed version, a linked package, or missing).
 * Read-only: the Workbench never installs packages, and changing the list is `compose_product_kit`.
 */
defineProps<{ packages: readonly ProductKitPackage[] }>()
const { t } = useI18n()
/** The Product Kit file member these packages come from. */
const FIELD = 'designSystems'
</script>

<template>
  <section
    id="product-kit-packages"
    aria-labelledby="product-kit-packages-title"
    class="flex scroll-mt-6 flex-col gap-4"
    data-product-kit-section="packages"
  >
    <header class="min-w-0 space-y-1">
      <h2
        id="product-kit-packages-title"
        tabindex="-1"
        class="text-title font-semibold text-highlighted focus:outline-none"
      >
        {{ t('productKit.packages.title') }}
      </h2>
      <i18n-t
        keypath="productKit.packages.description"
        tag="p"
        scope="global"
        class="text-sm text-muted"
      >
        <template #field>
          <code class="font-mono text-xs">{{ FIELD }}</code>
        </template>
      </i18n-t>
    </header>

    <ul
      v-if="packages.length"
      class="flex flex-col divide-y divide-default border-y border-default"
      :aria-label="t('productKit.packages.title')"
    >
      <li
        v-for="item in packages"
        :key="item.package"
        class="flex flex-wrap items-center gap-x-3 gap-y-1 py-3"
        data-product-kit-package
        :data-package-status="item.status"
      >
        <code
          class="min-w-0 flex-1 truncate font-mono text-xs text-highlighted"
          translate="no"
        >{{ item.package }}</code>
        <template v-if="item.status === 'resolved'">
          <span
            v-if="item.version"
            class="font-mono text-xs text-muted"
            translate="no"
          >{{ item.version }}</span>
          <UBadge
            v-if="item.linked"
            color="info"
            variant="subtle"
            size="sm"
            icon="i-lucide-link"
            data-package-linked
          >
            {{ t('productKit.packages.linked') }}
          </UBadge>
          <UBadge
            color="success"
            variant="subtle"
            size="sm"
            icon="i-lucide-check"
          >
            {{ t('productKit.packages.installed') }}
          </UBadge>
        </template>
        <UBadge
          v-else
          color="error"
          variant="subtle"
          size="sm"
          icon="i-lucide-circle-alert"
        >
          {{ t('productKit.packages.missing') }}
        </UBadge>
      </li>
    </ul>
    <p
      v-else
      class="rounded-md border border-dashed border-default px-3 py-4 text-sm text-muted"
      data-product-kit-packages-empty
    >
      {{ t('productKit.packages.empty') }}
    </p>
    <p
      v-if="packages.some(item => item.status === 'missing')"
      class="text-xs text-muted"
    >
      {{ t('productKit.packages.missingHelp') }}
    </p>
  </section>
</template>
