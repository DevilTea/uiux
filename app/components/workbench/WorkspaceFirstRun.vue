<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { useAccess } from '../../composables/useAccess'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchFeedback } from '../../composables/useWorkbenchFeedback'
import { copyText } from '../../utils/copy-text'

/**
 * First run of a Workspace with no Views (brief h "Overview · No Views"; onboard). Views are
 * authored by an agent through MCP, so the path to value is: connect the agent, ask it for a
 * View, refresh. One primary action (copy the endpoint the agent needs), one secondary (refresh).
 */
const { t } = useI18n()
const workbench = useWorkbench()
const access = useAccess()
const feedback = useWorkbenchFeedback()

const endpoint = computed(() => typeof window === 'undefined' ? '/mcp' : `${window.location.origin}/mcp`)
const workspaceDir = computed(() => access.session.value?.workspaceRoot ?? '<dir>')
const memberCommand = computed(() => `uiux member add <agent> --workspace ${workspaceDir.value} --kind agent --role editor`)
const tokenCommand = computed(() => `uiux token create --workspace ${workspaceDir.value} --member <agent>`)

async function copy(text: string): Promise<void> {
	if (await copyText(text)) feedback.success(t('firstRun.copied'))
	else feedback.error(undefined, t('firstRun.copyFailed'))
}
</script>

<template>
  <section
    class="mx-auto w-full max-w-3xl px-4 pt-4 pb-16 sm:px-6"
    aria-labelledby="first-run-heading"
    data-first-run
  >
    <h2
      id="first-run-heading"
      class="text-title font-semibold text-highlighted"
    >
      {{ t('firstRun.title') }}
    </h2>
    <p class="mt-1 max-w-[65ch] text-sm text-muted">
      {{ t('firstRun.description') }}
    </p>

    <ol class="mt-5 divide-y divide-default border-y border-default">
      <li class="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 py-4">
        <span
          class="grid size-6 place-items-center rounded-full bg-elevated font-mono text-xs text-highlighted"
          aria-hidden="true"
        >1</span>
        <div class="min-w-0 space-y-2">
          <h3 class="text-sm font-semibold text-highlighted">
            {{ t('firstRun.connect.title') }}
          </h3>
          <p class="text-sm text-muted">
            {{ t('firstRun.connect.body') }}
          </p>
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <code
              class="min-w-0 truncate rounded-md border border-default bg-muted px-2 py-1 font-mono text-xs text-highlighted"
              data-first-run-endpoint
            >{{ endpoint }}</code>
            <UButton
              color="primary"
              variant="solid"
              size="sm"
              icon="i-lucide-copy"
              :label="t('firstRun.copyEndpoint')"
              data-first-run-copy
              @click="copy(endpoint)"
            />
          </div>
          <p class="text-xs text-muted">
            {{ t('firstRun.connect.token') }}
          </p>
          <div
            v-for="command in [memberCommand, tokenCommand]"
            :key="command"
            class="flex min-w-0 items-start gap-1"
          >
            <code class="min-w-0 flex-1 rounded-md bg-muted px-2 py-1 font-mono text-xs break-all text-toned">{{ command }}</code>
            <UTooltip :text="t('firstRun.copyCommand')">
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-lucide-copy"
                :aria-label="t('firstRun.copyCommand')"
                @click="copy(command)"
              />
            </UTooltip>
          </div>
        </div>
      </li>
      <li class="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 py-4">
        <span
          class="grid size-6 place-items-center rounded-full bg-elevated font-mono text-xs text-highlighted"
          aria-hidden="true"
        >2</span>
        <div class="min-w-0 space-y-1">
          <h3 class="text-sm font-semibold text-highlighted">
            {{ t('firstRun.create.title') }}
          </h3>
          <i18n-t
            keypath="firstRun.create.body"
            tag="p"
            class="text-sm text-muted"
            scope="global"
          >
            <template #tool>
              <code class="rounded-sm bg-elevated px-1 py-0.5 font-mono text-xs text-highlighted">create_view</code>
            </template>
          </i18n-t>
        </div>
      </li>
      <li class="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 py-4">
        <span
          class="grid size-6 place-items-center rounded-full bg-elevated font-mono text-xs text-highlighted"
          aria-hidden="true"
        >3</span>
        <div class="min-w-0 space-y-2">
          <h3 class="text-sm font-semibold text-highlighted">
            {{ t('firstRun.review.title') }}
          </h3>
          <p class="text-sm text-muted">
            {{ t('firstRun.review.body') }}
          </p>
          <UButton
            size="sm"
            icon="i-lucide-refresh-cw"
            :loading="workbench.loading.value"
            :label="t('common.refresh')"
            data-first-run-refresh
            @click="workbench.refreshAll()"
          />
        </div>
      </li>
    </ol>
  </section>
</template>
