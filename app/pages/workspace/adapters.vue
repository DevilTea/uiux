<script setup lang="ts">
import WorkspaceSettingsPage from '../../components/workspace/WorkspaceSettingsPage.vue'

/**
 * Adapters. The Adapter set is part of the Workspace settings document, so this opens the
 * settings page at its Adapters section rather than keeping a second editor for it.
 */
</script>

<template>
  <WorkspaceSettingsPage initial-section="adapters" />
</template>
