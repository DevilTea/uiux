<script setup lang='ts'>
import { definePageMeta } from '#imports'

/**
 * `/views` used to be a second, thinner list of the same Views as the Overview's Views tab. The
 * Overview list is the one View list now (readiness, Reviews, Checks, Evidence and the View
 * opened last), so the old address lands on that tab.
 */
definePageMeta({ redirect: { path: '/', query: { tab: 'views' } } })
</script>

<template>
  <div />
</template>
