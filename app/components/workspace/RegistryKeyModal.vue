<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '#imports'

/**
 * Reference-impact check for an identity-changing registry edit (Part 10): renaming or
 * removing a Viewport or theme key. The dialog names what still refers to the key and
 * requires an explicit acknowledgement before the change reaches the draft.
 */
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{
	mode: 'rename' | 'remove'
	registryKey: string
	takenKeys: readonly string[]
	/** Evidence records captured with this key; `undefined` while the check runs. */
	evidenceCount?: number
	evidenceFailed?: boolean
}>()
const emit = defineEmits<{ confirm: [newKey?: string] }>()
const { t } = useI18n()

const newKey = ref('')
const acknowledged = ref(false)
const touched = ref(false)

watch(open, (value) => {
	if (!value) return
	newKey.value = props.registryKey
	acknowledged.value = false
	touched.value = false
}, { immediate: true })

const keyError = computed(() => {
	if (props.mode !== 'rename' || !touched.value) return undefined
	const key = newKey.value.trim()
	if (!key) return t('settings.validation.keyRequired')
	if (/\s/u.test(key)) return t('settings.validation.keyWhitespace')
	if (key !== props.registryKey && props.takenKeys.includes(key)) return t('settings.validation.keyTaken', { key })
	return undefined
})

const canConfirm = computed(() => {
	if (!acknowledged.value) return false
	if (props.mode === 'remove') return true
	const key = newKey.value.trim()
	return !!key && key !== props.registryKey && !/\s/u.test(key) && !props.takenKeys.includes(key)
})

function confirm(): void {
	touched.value = true
	if (!canConfirm.value) return
	emit('confirm', props.mode === 'rename' ? newKey.value.trim() : undefined)
	open.value = false
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="mode === 'rename' ? t('settings.registry.renameTitle', { key: registryKey }) : t('settings.registry.removeTitle', { key: registryKey })"
    :description="mode === 'rename' ? t('settings.keyChange') : t('settings.registry.removeDescription')"
  >
    <template #body>
      <form
        class="flex flex-col gap-4"
        @submit.prevent="confirm"
      >
        <UFormField
          v-if="mode === 'rename'"
          :label="t('settings.registry.newKey')"
          :help="t('settings.registry.newKeyHelp')"
          :error="keyError"
          required
        >
          <UInput
            v-model="newKey"
            class="w-full"
            :ui="{ base: 'font-mono' }"
            autofocus
            @blur="touched = true"
          />
        </UFormField>

        <section
          class="flex flex-col gap-2"
          :aria-label="t('settings.registry.references')"
        >
          <h3 class="text-xs font-medium text-muted">
            {{ t('settings.registry.references') }}
          </h3>
          <ul class="flex flex-col gap-1.5 text-sm">
            <li class="flex items-start gap-2">
              <UIcon
                :name="evidenceCount ? 'i-lucide-history' : 'i-lucide-camera'"
                class="mt-0.5 size-4 shrink-0 text-muted"
              />
              <span v-if="evidenceFailed">{{ t('settings.registry.evidenceUnknown') }}</span>
              <span v-else-if="evidenceCount === undefined">{{ t('settings.registry.checking') }}</span>
              <i18n-t
                v-else
                keypath="settings.registry.evidence"
                :plural="evidenceCount"
                scope="global"
                tag="span"
              >
                <template #n>
                  {{ evidenceCount }}
                </template>
                <template #key>
                  <code class="font-mono text-xs">{{ registryKey }}</code>
                </template>
              </i18n-t>
            </li>
            <li class="flex items-start gap-2">
              <UIcon
                name="i-lucide-link-2-off"
                class="mt-0.5 size-4 shrink-0 text-muted"
              />
              <i18n-t
                keypath="settings.registry.links"
                scope="global"
                tag="span"
              >
                <template #key>
                  <code class="font-mono text-xs">{{ registryKey }}</code>
                </template>
              </i18n-t>
            </li>
          </ul>
        </section>

        <UCheckbox
          v-model="acknowledged"
          :label="t('settings.registry.acknowledge', { key: registryKey })"
          data-registry-acknowledge
        />
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="outline"
          @click="open = false"
        >
          {{ t('common.cancel') }}
        </UButton>
        <UButton
          :color="mode === 'remove' ? 'error' : 'primary'"
          :variant="mode === 'remove' ? 'soft' : 'solid'"
          :disabled="!canConfirm"
          @click="confirm"
        >
          {{ mode === 'rename' ? t('settings.registry.confirmRename') : t('settings.registry.confirmRemove') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
