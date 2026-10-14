<script setup lang='ts'>
import { definePageMeta } from '#imports'

/**
 * Adapters used to have this address, then a section of Workspace settings. They are managed in the
 * Overview section of the Product Kit page now (Rule 01a116f0-8a46-76bc-a29f-affaa302c44c), so the
 * retired address opens it (Clause 01a116f0-9739-754b-b024-346b1c16a866).
 */
definePageMeta({ redirect: { path: '/workspace/product-kit', query: { section: 'overview' } } })
</script>

<template>
  <div />
</template>
