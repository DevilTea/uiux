<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '#imports'
import { describeFetchError, type FetchErrorDetails } from '../../utils/fetch-error'
import { blobToBase64, stripExtension } from '../../utils/workspace-authoring'
import AuthoringErrorAlert from './AuthoringErrorAlert.vue'
import { focusFirstProblem } from '../../utils/focus-problem'

/** Upload an Asset (brief g): one file, a name, and the filename and media type it is stored with. */
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [key: string, name: string] }>()
const { t } = useI18n()

const file = ref<File | null>(null)
const name = ref('')
const filename = ref('')
const mediaType = ref('')
const touched = ref(false)
const uploading = ref(false)
const error = ref<FetchErrorDetails>()

watch(open, (value) => {
	if (!value) return
	file.value = null
	name.value = ''
	filename.value = ''
	mediaType.value = ''
	touched.value = false
	error.value = undefined
})

watch(file, (value) => {
	if (!value) return
	filename.value = value.name
	mediaType.value = value.type || 'application/octet-stream'
	if (!name.value.trim()) name.value = stripExtension(value.name)
})

const errors = computed(() => touched.value
	? {
			file: file.value ? undefined : t('assets.validation.fileRequired'),
			name: name.value.trim() ? undefined : t('assets.validation.nameRequired'),
			filename: filename.value.trim() && !/[/\\]/u.test(filename.value) ? undefined : t('assets.validation.filenameRequired'),
		}
	: { file: undefined, name: undefined, filename: undefined })

async function upload(): Promise<void> {
	touched.value = true
	if (!file.value || errors.value.name || errors.value.filename) void focusFirstProblem('[role="dialog"]')
	if (!file.value || errors.value.name || errors.value.filename || uploading.value) return
	uploading.value = true
	error.value = undefined
	try {
		const contentBase64 = await blobToBase64(file.value)
		const result = await $fetch<{ key?: string }>('/api/assets', {
			method: 'POST',
			body: {
				name: name.value.trim(),
				contentFilename: filename.value.trim(),
				mediaType: mediaType.value.trim() || 'application/octet-stream',
				contentBase64,
			},
		})
		open.value = false
		emit('created', result.key ?? '', name.value.trim())
	}
	catch (cause) {
		error.value = describeFetchError(cause, t('assets.createFailed'))
		void focusFirstProblem('[role="dialog"]')
	}
	finally {
		uploading.value = false
	}
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('assets.createTitle')"
    :description="t('assets.createDescription')"
  >
    <template #body>
      <form
        class="flex flex-col gap-4"
        novalidate
        @submit.prevent="upload"
      >
        <UFormField
          :label="t('assets.fields.file')"
          :error="errors.file"
          required
        >
          <UFileUpload
            v-model="file"
            icon="i-lucide-upload"
            :label="t('assets.fileUploadLabel')"
            :description="t('assets.fileUploadDescription')"
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="t('assets.fields.name')"
          :error="errors.name"
          required
        >
          <UInput
            v-model="name"
            :placeholder="t('assets.placeholders.name')"
            class="w-full"
          />
        </UFormField>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <UFormField
            :label="t('assets.fields.filename')"
            :error="errors.filename"
            required
          >
            <UInput
              v-model="filename"
              placeholder="logo.svg"
              class="w-full"
              :ui="{ base: 'font-mono' }"
            />
          </UFormField>
          <UFormField
            :label="t('assets.fields.mediaType')"
            :help="t('assets.mediaTypeHelp')"
          >
            <UInput
              v-model="mediaType"
              placeholder="image/svg+xml"
              class="w-full"
              :ui="{ base: 'font-mono' }"
            />
          </UFormField>
        </div>
        <AuthoringErrorAlert
          v-if="error"
          :title="t('assets.createFailed')"
          :error="error"
          @close="error = undefined"
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
          color="primary"
          variant="solid"
          icon="i-lucide-upload"
          :loading="uploading"
          @click="upload"
        >
          {{ t('assets.upload') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
