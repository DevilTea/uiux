<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from '#imports'
import { useAccess } from '../../composables/useAccess'
import type { FetchErrorLock } from '../../utils/fetch-error'

/**
 * A save refused with `423 resource.locked` (accepted identity decision 11): names the holder and
 * the lease expiry, and says the draft is kept, as a revision conflict does. Nothing is retried.
 * The lease list is re-read at once so the page's Lock badge and read-only state catch up.
 */
const props = defineProps<{ lock?: FetchErrorLock }>()
const emit = defineEmits<{ dismiss: [] }>()

const { t, locale } = useI18n()
const access = useAccess()

onMounted(() => { void access.refreshLocks() })

const until = computed(() => {
	const expiresAt = props.lock ? Date.parse(props.lock.expiresAt) : Number.NaN
	return Number.isFinite(expiresAt)
		? new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(expiresAt))
		: '–'
})
</script>

<template>
  <UAlert
    color="warning"
    variant="subtle"
    icon="i-lucide-lock"
    role="alert"
    data-locked-alert
    :title="t('access.lock.saveRefused', { nickname: lock?.holder.nickname ?? '?', time: until })"
    :description="t('access.lock.saveRefusedBody')"
    close
    @update:open="(open: boolean) => { if (!open) emit('dismiss') }"
  />
</template>
