import { computed, readonly, shallowRef } from 'vue'

import type { PermissionKey } from '../../src/application/access/keys'
import type { MemberLabel } from '../../src/application/access/labels'
import type { MemberKind } from '../../src/application/access/principal'
import type { LockableKind, PublicLease } from '../../src/application/access/leases'
import { useLiveEvents } from './useLiveEvents'

/**
 * The signed-in member of this Workbench session, as `GET /api/session` returns it (Clause
 * 01a11485-faa9-74fe-8e0a-068cd770ff1c): its permission keys and its label. `keys` are the keys
 * that take effect on this cookie session. The server is the authority: the Workbench only hides
 * or disables what the keys do not allow and names the missing key (Rule
 * 01a11485-eba3-7c07-a94f-0d69e610a0b6).
 */
export type SessionMember = Readonly<{ id: string; nickname: string; kind: MemberKind; keys: readonly string[]; label: MemberLabel }>

export type AccessSession = Readonly<{
	member: SessionMember
	credential: 'session' | 'token'
	workspaceRoot: string
	hint: string
}>

const session = shallowRef<AccessSession>()
const loaded = shallowRef(false)
let loading: Promise<AccessSession | undefined> | undefined

const locks = shallowRef<readonly PublicLease[]>([])
let lockTimer: ReturnType<typeof setInterval> | undefined
let lockSubscribers = 0
/**
 * The shell re-reads the lease list on every `lock.changed` event (`layouts/default.vue`); only
 * while the change-event stream is not open does the Workbench poll it, every `LOCK_POLL_MS`
 * (Rule 01a11485-f3d9-7663-b344-a60c2a949e5e).
 */
export const LOCK_POLL_MS = 5000

/**
 * A per-browser marker that this browser held a Workbench session. It is not a credential and
 * grants nothing: it only spares the sign-in page a session probe that can only answer 401, which
 * the browser would log as a failed resource load. Cookie-only clients still probe from the route
 * middleware, so a session established elsewhere is found there.
 */
const SESSION_HINT_KEY = 'uiux.workbench.signedIn'

function writeSessionHint(present: boolean): void {
	try {
		if (present) globalThis.localStorage?.setItem(SESSION_HINT_KEY, '1')
		else globalThis.localStorage?.removeItem(SESSION_HINT_KEY)
	}
	catch { /* storage unavailable: the sign-in page simply probes */ }
}

/** True unless this browser is known to have no session (storage unavailable counts as unknown). */
export function mayHaveSession(): boolean {
	try { return globalThis.localStorage?.getItem(SESSION_HINT_KEY) === '1' }
	catch { return true }
}

function statusOf(cause: unknown): number | undefined {
	const record = cause as { status?: number; statusCode?: number } | undefined
	return record?.status ?? record?.statusCode
}

async function loadSession(force = false): Promise<AccessSession | undefined> {
	if (loaded.value && !force) return session.value
	loading ??= $fetch<AccessSession>('/api/session', { cache: 'no-store' })
		.then((value) => {
			session.value = value
			writeSessionHint(true)
			return value
		})
		.catch((cause: unknown) => {
			// The expected signed-out answer, not a failure.
			if (statusOf(cause) === 401 || statusOf(cause) === 403) {
				session.value = undefined
				writeSessionHint(false)
				return undefined
			}
			throw cause
		})
		.finally(() => {
			loaded.value = true
			loading = undefined
		})
	return loading
}

async function refreshLocks(): Promise<void> {
	if (!session.value) return
	try {
		const result = await $fetch<{ locks: PublicLease[] }>('/api/locks', { cache: 'no-store' })
		locks.value = result.locks
	}
	catch {
		// A failed poll keeps the last known leases; the next tick retries.
	}
}

/** The server answered 401 mid-session: forget the member without asking the server again. */
function expire(): void {
	session.value = undefined
	loaded.value = true
	locks.value = []
	writeSessionHint(false)
}

const heldKeys = computed(() => new Set(session.value?.member.keys ?? []))
const live = useLiveEvents()

/**
 * Whether the signed-in member holds `key` on this session (Discussion #140, decision 12:
 * `useAccess().can(key)` replaces role ranks). Each key stands alone: no key implies another
 * (Rule 01a11485-eaac-7523-998b-26123d7618df). Signed out, nothing is allowed.
 */
function can(key: PermissionKey): boolean {
	return heldKeys.value.has(key)
}

/**
 * Re-reads the session, so a change to the member's keys applies to what the Workbench offers
 * (Rule 01a116f0-963f-7222-95fa-ae80ce735859): on every `access.changed` event (`layouts/default.vue`),
 * and when the server refuses a request for a missing key (`plugins/access.client.ts`).
 */
async function reloadSession(): Promise<AccessSession | undefined> {
	if (!loaded.value || !session.value) return session.value
	return loadSession(true).catch(() => session.value)
}

export function useAccess() {
	const member = computed(() => session.value?.member)

	async function signOut(): Promise<void> {
		try {
			await $fetch('/api/session', { method: 'DELETE' })
		}
		finally {
			expire()
		}
	}

	/** The active lease on a resource, if any. Humans never hold leases, so any lease is someone else's. */
	function lockFor(kind: LockableKind, key: string | undefined): PublicLease | undefined {
		if (!key) return undefined
		return locks.value.find(lease => lease.kind === kind && lease.key === key && Date.parse(lease.expiresAt) > Date.now())
	}

	async function forceRelease(kind: LockableKind, key: string): Promise<void> {
		await $fetch(`/api/locks/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`, { method: 'DELETE' })
		await refreshLocks()
	}

	/** Starts (reference-counted) polling of `GET /api/locks`; returns the stop function. */
	function watchLocks(): () => void {
		lockSubscribers += 1
		if (lockSubscribers === 1) {
			void refreshLocks()
			lockTimer = setInterval(() => {
				if (live.state.value !== 'open') void refreshLocks()
			}, LOCK_POLL_MS)
		}
		let stopped = false
		return () => {
			if (stopped) return
			stopped = true
			lockSubscribers -= 1
			if (lockSubscribers === 0 && lockTimer) {
				clearInterval(lockTimer)
				lockTimer = undefined
			}
		}
	}

	return {
		session: readonly(session),
		loaded: readonly(loaded),
		member,
		can,
		load: loadSession,
		reload: reloadSession,
		expire,
		signOut,
		locks: readonly(locks),
		lockFor,
		refreshLocks,
		forceRelease,
		watchLocks,
	}
}
