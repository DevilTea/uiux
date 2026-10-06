<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from '#imports'
import type { LockableKind } from '../../../src/application/access/leases'
import { useAccess } from '../../composables/useAccess'
import { useWorkbenchFeedback } from '../../composables/useWorkbenchFeedback'

/**
 * "Locked by <nickname> · until HH:MM" on a resource an agent holds an edit lease on (accepted
 * identity decision 12). An Owner gets "Release lock" (force-release). The lease list is polled
 * from `GET /api/locks` because no event stream exists yet.
 */
const props = defineProps<{ kind: LockableKind; resourceKey?: string }>()
const emit = defineEmits<{ (e: 'released'): void }>()

const { t, locale } = useI18n()
const access = useAccess()
const feedback = useWorkbenchFeedback()
const releasing = ref(false)
let stop: (() => void) | undefined

onMounted(() => { stop = access.watchLocks() })
onUnmounted(() => stop?.())

const lease = computed(() => access.lockFor(props.kind, props.resourceKey))
const until = computed(() => lease.value
	? new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(lease.value.expiresAt))
	: '')

async function release(): Promise<void> {
	if (!lease.value || releasing.value) return
	releasing.value = true
	try {
		await access.forceRelease(lease.value.kind, lease.value.key)
		feedback.success(t('access.lock.released'))
		emit('released')
	}
	catch (cause) {
		feedback.error(cause, t('access.lock.releaseFailed'))
	}
	finally {
		releasing.value = false
	}
}
</script>

<template>
  <div
    v-if="lease"
    class="flex items-center gap-1.5"
    data-testid="lock-badge"
    role="status"
  >
    <UTooltip :text="t('access.lock.tooltip', { nickname: lease.holder.nickname, kind: t(`access.kind.${lease.holder.kind}`) })">
      <UBadge
        color="warning"
        variant="subtle"
        icon="i-lucide-lock"
        size="md"
      >
        {{ t('access.lock.badge', { nickname: lease.holder.nickname, time: until }) }}
      </UBadge>
    </UTooltip>
    <UButton
      v-if="access.isOwner.value"
      color="neutral"
      variant="outline"
      size="xs"
      icon="i-lucide-lock-open"
      :loading="releasing"
      @click="release"
    >
      {{ t('access.lock.release') }}
    </UButton>
  </div>
</template>
