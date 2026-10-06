<script setup lang='ts'>
import { definePageMeta } from '#imports'

/**
 * Adapters used to be a second route onto the settings page. The Adapter set is part of the
 * Workspace settings document, so the old address now redirects to its section there.
 */
definePageMeta({ redirect: { path: '/workspace/settings', query: { section: 'adapters' } } })
</script>

<template>
  <div />
</template>
