<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from '#imports'
import { diffJson } from '../../utils/workspace-authoring'

/**
 * Revision conflict (brief h, "Any form"): a caution alert that keeps the draft and offers an
 * explicit choice. "Reload theirs" drops the draft for the newer saved version; "Compare" lays
 * both side by side, and "Keep mine" carries the draft onto the newer revision, still unsaved.
 * Nothing is ever merged or retried automatically.
 */
const props = defineProps<{
	title: string
	/** The newer saved value, as the server returned it. */
	theirs: unknown
	/** The local draft. */
	yours: unknown
	/** Turns JSON Pointer paths into row labels, e.g. a Locale key. */
	formatPath?: (path: string) => string
}>()
const emit = defineEmits<{ reload: []; keepMine: [] }>()
const { t } = useI18n()

const comparing = ref(false)
const differences = computed(() => diffJson(props.theirs, props.yours))

function label(path: string): string {
	return props.formatPath ? props.formatPath(path) : path
}

function keepMine(): void {
	comparing.value = false
	emit('keepMine')
}

function reload(): void {
	comparing.value = false
	emit('reload')
}
</script>

<template>
  <UAlert
    color="warning"
    variant="subtle"
    icon="i-lucide-git-compare-arrows"
    role="alert"
    data-conflict-alert
    :title="title"
    :description="t('authoring.conflict.kept')"
    :actions="[
      { label: t('authoring.conflict.reload'), color: 'neutral', variant: 'outline', icon: 'i-lucide-refresh-cw', onClick: reload },
      { label: t('authoring.conflict.compare'), color: 'neutral', variant: 'ghost', icon: 'i-lucide-columns-2', onClick: () => { comparing = true } },
    ]"
  />

  <UModal
    v-model:open="comparing"
    :title="t('authoring.compare.title')"
    :description="t('authoring.compare.description')"
    :ui="{ content: 'sm:max-w-3xl' }"
  >
    <template #body>
      <p
        v-if="!differences.length"
        class="text-body text-muted"
      >
        {{ t('authoring.compare.none') }}
      </p>
      <div
        v-else
        class="overflow-x-auto"
      >
        <table class="w-full table-fixed border-collapse text-sm">
          <caption class="sr-only">
            {{ t('authoring.compare.title') }}
          </caption>
          <thead>
            <tr class="border-b border-default text-start text-xs text-muted">
              <th
                scope="col"
                class="w-1/4 py-2 pe-3 text-start font-medium"
              >
                {{ t('authoring.compare.field') }}
              </th>
              <th
                scope="col"
                class="py-2 pe-3 text-start font-medium"
              >
                {{ t('authoring.compare.theirs') }}
              </th>
              <th
                scope="col"
                class="py-2 text-start font-medium"
              >
                {{ t('authoring.compare.yours') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in differences"
              :key="row.path"
              class="border-b border-muted align-top"
            >
              <th
                scope="row"
                class="py-2 pe-3 text-start font-mono text-xs font-normal break-all text-muted"
              >
                {{ label(row.path) }}
              </th>
              <td class="py-2 pe-3 break-words whitespace-pre-wrap">
                <span v-if="row.theirs !== undefined">{{ row.theirs }}</span>
                <span
                  v-else
                  class="text-dimmed italic"
                >{{ t('authoring.compare.absent') }}</span>
              </td>
              <td class="py-2 break-words whitespace-pre-wrap">
                <span v-if="row.yours !== undefined">{{ row.yours }}</span>
                <span
                  v-else
                  class="text-dimmed italic"
                >{{ t('authoring.compare.absent') }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="outline"
          @click="reload"
        >
          {{ t('authoring.compare.keepTheirs') }}
        </UButton>
        <UButton
          color="primary"
          variant="solid"
          @click="keepMine"
        >
          {{ t('authoring.compare.keepMine') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
