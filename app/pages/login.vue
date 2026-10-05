<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { definePageMeta, navigateTo, useI18n, useRoute } from '#imports'
import { useAccess } from '../composables/useAccess'

/**
 * Sign-in (accepted identity decision 8 and 12). An invite arrives in the URL fragment, so it
 * never reaches server logs or Referer headers; it is posted once and removed from the address
 * bar with `history.replaceState`. A member token can be pasted instead.
 */
definePageMeta({ layout: false })

const { t } = useI18n()
const route = useRoute()
const access = useAccess()

const token = ref('')
const submitting = ref(false)
const fromLink = ref(false)
const errorMessage = ref('')

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const plainHttpOnLan = computed(() => typeof window !== 'undefined' && window.location.protocol === 'http:' && !LOOPBACK.has(window.location.hostname))
const recoverCommand = 'uiux invite create --workspace <dir> --member <nick>'

function nextPath(): string {
	const next = typeof route.query.next === 'string' ? route.query.next : '/'
	// Only same-app paths: never an absolute or protocol-relative URL.
	return next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : '/'
}

async function signIn(credential: string): Promise<void> {
	if (!credential.trim() || submitting.value) return
	submitting.value = true
	errorMessage.value = ''
	try {
		await $fetch('/api/session/login', { method: 'POST', body: { credential: credential.trim() } })
		token.value = ''
		await access.load(true)
		await navigateTo(nextPath(), { replace: true })
	}
	catch (cause) {
		const status = (cause as { status?: number; statusCode?: number }).status ?? (cause as { statusCode?: number }).statusCode
		errorMessage.value = status === 429 ? t('access.login.errors.rateLimited') : status === 401 ? t('access.login.errors.invalid') : t('access.login.errors.failed')
	}
	finally {
		submitting.value = false
		fromLink.value = false
	}
}

/** Signs in with an invite in the fragment; true when there was one. */
async function consumeFragment(): Promise<boolean> {
	const fragment = window.location.hash.slice(1)
	if (!fragment) return false
	// Drop the single-use secret from the address bar and history before using it.
	window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
	fromLink.value = true
	await signIn(decodeURIComponent(fragment))
	return true
}

function onHashChange(): void {
	void consumeFragment()
}

onMounted(async () => {
	// A link pasted into an already open sign-in tab only changes the fragment.
	window.addEventListener('hashchange', onHashChange)
	if (await consumeFragment()) return
	const existing = await access.load(true).catch(() => undefined)
	if (existing) await navigateTo(nextPath(), { replace: true })
})

onBeforeUnmount(() => window.removeEventListener('hashchange', onHashChange))
</script>

<template>
  <div class="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10 text-default">
    <main
      id="main"
      data-landmark="main"
      class="w-full max-w-sm space-y-5 rounded-lg border border-default bg-default p-6"
      :aria-label="t('access.login.title')"
    >
      <div class="space-y-1">
        <h1 class="text-lg font-semibold text-highlighted">
          {{ t('access.login.title') }}
        </h1>
        <p class="text-sm text-muted">
          {{ t('access.login.description') }}
        </p>
      </div>

      <UAlert
        v-if="plainHttpOnLan"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :description="t('access.login.plainHttp')"
      />

      <div
        v-if="fromLink && submitting"
        class="flex items-center gap-2 text-sm text-muted"
        role="status"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-4 animate-spin"
        />
        {{ t('access.login.signingIn') }}
      </div>

      <UAlert
        v-if="errorMessage"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        role="alert"
        :description="errorMessage"
      />

      <form
        class="space-y-3"
        @submit.prevent="signIn(token)"
      >
        <UFormField
          :label="t('access.login.tokenLabel')"
          :help="t('access.login.tokenHelp')"
          name="credential"
        >
          <UInput
            v-model="token"
            type="password"
            autocomplete="off"
            spellcheck="false"
            class="w-full font-mono"
            placeholder="uiux_t_…"
          />
        </UFormField>
        <UButton
          type="submit"
          color="primary"
          variant="solid"
          block
          :loading="submitting"
          :disabled="!token.trim()"
        >
          {{ t('access.login.submit') }}
        </UButton>
      </form>

      <USeparator />

      <div class="space-y-1 text-xs text-muted">
        <p class="font-medium text-toned">
          {{ t('access.login.recoverTitle') }}
        </p>
        <i18n-t
          keypath="access.login.recover"
          tag="p"
        >
          <template #command>
            <code class="font-mono text-toned">{{ recoverCommand }}</code>
          </template>
        </i18n-t>
      </div>
    </main>
  </div>
</template>
