<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { useWorkbenchShell } from '../../composables/useWorkbenchShell'

/** The `?` dialog listing the Workbench keyboard shortcuts (brief a, section 9). */
const { t } = useI18n()
const shell = useWorkbenchShell()

const rows = computed(() => [
	{ keys: [['meta', 'K']], label: t('shortcuts.search') },
	{ keys: [['G', 'O'], ['G', 'V'], ['G', 'F'], ['G', 'R']], label: t('shortcuts.goTo') },
	{ keys: [['[']], label: t('shortcuts.toggleSidebar') },
	{ keys: [[']']], label: t('shortcuts.togglePanel') },
	{ keys: [['meta', '.']], label: t('shortcuts.toggleTheme') },
	{ keys: [['F6'], ['shift', 'F6']], label: t('shortcuts.landmarks') },
	{ keys: [['Esc']], label: t('shortcuts.exitComment') },
	{ keys: [['?']], label: t('shortcuts.help') },
])
</script>

<template>
  <UModal
    v-model:open="shell.shortcutsOpen.value"
    :title="t('shortcuts.title')"
    :description="shell.singleKeyShortcuts.value ? t('shortcuts.description') : t('shortcuts.singleKeyOff')"
  >
    <template #body>
      <dl class="divide-y divide-default text-sm">
        <div
          v-for="row in rows"
          :key="row.label"
          class="flex items-center justify-between gap-4 py-2"
        >
          <dt class="text-default">
            {{ row.label }}
          </dt>
          <dd class="flex flex-wrap items-center justify-end gap-1.5">
            <span
              v-for="(combo, index) in row.keys"
              :key="index"
              class="inline-flex items-center gap-0.5"
            >
              <UKbd
                v-for="key in combo"
                :key="key"
                :value="key"
              />
            </span>
          </dd>
        </div>
      </dl>
    </template>
  </UModal>
</template>
