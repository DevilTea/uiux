<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from '#imports'
import { REVIEWER_NAME_MAX_LENGTH, useReviewerIdentity } from '../../composables/useReviewerIdentity'

/**
 * Reviewer identity picker: a local display name written as Review actor provenance
 * `{ type: 'human', displayName }`. No roster, no authentication.
 */
const { t } = useI18n()
const identity = useReviewerIdentity()

const open = ref(false)
const draft = ref('')

watch(open, (value) => {
	if (value) draft.value = identity.name.value
})

function save(): void {
	identity.setName(draft.value)
	open.value = false
}
</script>

<template>
  <UPopover
    v-model:open="open"
    :content="{ align: 'end', sideOffset: 6 }"
  >
    <UButton
      color="neutral"
      variant="ghost"
      class="gap-2 px-1.5"
      :aria-label="identity.hasName.value ? t('identity.commentingAs', { name: identity.name.value }) : t('identity.setName')"
    >
      <UAvatar
        v-if="identity.hasName.value"
        :text="identity.initials.value"
        size="2xs"
        :ui="{ fallback: 'font-semibold text-xs text-default' }"
      />
      <UIcon
        v-else
        name="i-lucide-user-round"
        class="size-4"
      />
      <span class="hidden max-w-32 truncate lg:inline">{{ identity.hasName.value ? identity.name.value : t('identity.setName') }}</span>
    </UButton>

    <template #content>
      <form
        class="w-72 space-y-3 p-3"
        @submit.prevent="save"
      >
        <div class="space-y-0.5">
          <p class="text-sm font-semibold text-highlighted">
            {{ t('identity.title') }}
          </p>
          <p class="text-xs text-muted">
            {{ t('identity.description') }}
          </p>
        </div>
        <UFormField
          :label="t('identity.nameLabel')"
          name="reviewerName"
        >
          <UInput
            v-model="draft"
            autofocus
            autocomplete="name"
            :maxlength="REVIEWER_NAME_MAX_LENGTH"
            :placeholder="t('identity.placeholder')"
            class="w-full"
          />
        </UFormField>
        <div class="flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            @click="open = false"
          >
            {{ t('common.cancel') }}
          </UButton>
          <UButton
            color="primary"
            variant="solid"
            size="sm"
            type="submit"
          >
            {{ t('common.save') }}
          </UButton>
        </div>
      </form>
    </template>
  </UPopover>
</template>
