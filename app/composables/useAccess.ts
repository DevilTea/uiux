import { computed, readonly, shallowRef } from 'vue'

import { ACCESS_ROLES, type AccessRole, type MemberKind } from '../../src/application/access/principal'
import type { LockableKind, PublicLease } from '../../src/application/access/leases'

/**
 * The signed-in member of this Workbench session (accepted identity decision 12). The server is
 * the authority: this only hides or disables what the role cannot do and names the role required.
 */
export type SessionMember = Readonly<{ id: string; nickname: string; kind: MemberKind; role: AccessRole }>

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
/** No `/api/events` stream exists yet, so the Workbench polls the lease list. */
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

export function roleRank(role: AccessRole): number {
	return ACCESS_ROLES.indexOf(role)
}

export function useAccess() {
	const member = computed(() => session.value?.member)
	const role = computed(() => member.value?.role)

	/** True when the signed-in member's role is at least `minimum`. */
	function can(minimum: AccessRole): boolean {
		return role.value !== undefined && roleRank(role.value) >= roleRank(minimum)
	}

	const isOwner = computed(() => member.value?.kind === 'human' && role.value === 'owner')
	const canReview = computed(() => can('reviewer'))
	const canAuthor = computed(() => can('editor'))

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
			lockTimer = setInterval(() => { void refreshLocks() }, LOCK_POLL_MS)
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
		role,
		can,
		isOwner,
		canReview,
		canAuthor,
		load: loadSession,
		expire,
		signOut,
		locks: readonly(locks),
		lockFor,
		refreshLocks,
		forceRelease,
		watchLocks,
	}
}
