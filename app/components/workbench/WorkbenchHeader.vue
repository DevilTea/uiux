<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import RenderContextControls from './RenderContextControls.vue'
import SessionStatus from './SessionStatus.vue'
import WorkbenchPreferences from './WorkbenchPreferences.vue'

const { t } = useI18n()
const workbench = useWorkbench()
const { isReadOnly, publicationInfo, selectedView, loading } = workbench

const modeLabel = computed(() => isReadOnly.value ? t('workbench.header.modePublished') : t('workbench.header.modeLocal'))
</script>

<template>
  <header class="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-default bg-default px-4">
    <div class="flex min-w-0 flex-1 items-center gap-3">
      <h1 class="shrink-0 text-sm font-semibold tracking-tight text-highlighted">
        {{ t('app.title') }}
      </h1>
      <UBadge
        color="neutral"
        variant="subtle"
        size="sm"
        class="shrink-0 whitespace-nowrap"
        :icon="isReadOnly ? 'i-lucide-lock' : 'i-lucide-hard-drive'"
      >
        {{ modeLabel }}
      </UBadge>
      <UTooltip
        v-if="publicationInfo?.sourceRevision"
        :text="publicationInfo.publicationIdentity"
      >
        <span class="font-mono text-xs text-dimmed">
          {{ publicationInfo.sourceRevision.slice(0, 12) }}
        </span>
      </UTooltip>
      <template v-if="selectedView">
        <USeparator
          orientation="vertical"
          class="h-5"
        />
        <div class="flex min-w-0 items-center gap-2">
          <span class="truncate text-xs font-medium text-toned">{{ selectedView.resource.name }}</span>
          <UBadge
            v-if="selectedView.resource.feature"
            color="neutral"
            variant="soft"
            size="xs"
          >
            {{ selectedView.resource.feature }}
          </UBadge>
        </div>
      </template>
    </div>

    <RenderContextControls
      v-if="selectedView"
      class="shrink-0"
    />

    <div class="flex shrink-0 items-center gap-2">
      <!-- The preview session is protocol plumbing: only surface it while connecting or when it fails. -->
      <template v-if="workbench.preview.sessionPhase.value === 'initiating' || workbench.preview.sessionPhase.value === 'failed'">
        <SessionStatus />
        <USeparator
          orientation="vertical"
          class="h-5"
        />
      </template>
      <WorkbenchPreferences />
      <UButton
        color="neutral"
        variant="outline"
        size="sm"
        icon="i-lucide-refresh-cw"
        :loading="loading"
        @click="workbench.refreshAll()"
      >
        {{ t('common.refresh') }}
      </UButton>
    </div>
  </header>
</template>
