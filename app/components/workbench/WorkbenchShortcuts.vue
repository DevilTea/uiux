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
	{ keys: [['V'], ['C'], ['I']], label: t('shortcuts.tools') },
	{ keys: [['shift', '1'], ['meta', '0']], label: t('shortcuts.fit') },
	{ keys: [['shift', '0']], label: t('shortcuts.actualSize') },
	{ keys: [['meta', '='], ['meta', '-']], label: t('shortcuts.zoom') },
	{ keys: [['alt', '↑'], ['alt', '↓'], ['alt', '←'], ['alt', '→']], label: t('shortcuts.walkTree') },
	{ keys: [['shift', 'V'], ['shift', 'L'], ['shift', 'T']], label: t('shortcuts.contextMenus') },
	{ keys: [['alt', '1'], ['alt', '2'], ['alt', '3'], ['alt', '4']], label: t('shortcuts.panelTabs') },
	{ keys: [['meta', 'C']], label: t('shortcuts.copyId') },
	{ keys: [['E']], label: t('shortcuts.editSection') },
	{ keys: [['meta', '↵'], ['Esc']], label: t('shortcuts.saveSection') },
	{ keys: [['Esc']], label: t('shortcuts.exitComment') },
	{ keys: [['J'], ['K']], label: t('shortcuts.nextThread') },
	{ keys: [['R']], label: t('shortcuts.replyThread') },
	{ keys: [['E']], label: t('shortcuts.resolveThread') },
	{ keys: [['shift', 'E']], label: t('shortcuts.resolveThreadAs') },
	{ keys: [['O']], label: t('shortcuts.openThreadInCanvas') },
	{ keys: [['shift', 'meta', 'E']], label: t('shortcuts.exportHandoff') },
	{ keys: [['shift', 'meta', 'P']], label: t('shortcuts.captureEvidence') },
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
