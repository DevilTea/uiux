<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import KitButton from '~/components/kit/ui/Button.vue'

/**
 * A Kit `Button` that navigates through the app's router. The Kit knows no router, so the link's address
 * comes from `NuxtLink` (its `custom` slot) and goes to the Kit as `href`: a middle-click, a modifier-click and
 * "copy link address" stay the browser's, and a plain click is handed to `navigate`, which leaves the
 * modified and non-primary clicks to the browser. Everything else (`variant`, `size`, `icon`, `label`, ...) is
 * a Kit `Button` prop or attribute. A `disabled` link has no `href` and does not navigate.
 */
defineOptions({ inheritAttrs: false })

defineProps<{
  to: RouteLocationRaw
}>()
</script>

<template>
  <NuxtLink
    v-slot="{ href, navigate }"
    :to="to"
    custom
  >
    <KitButton
      v-bind="$attrs"
      :href="href ?? undefined"
      @click="navigate"
    />
  </NuxtLink>
</template>
