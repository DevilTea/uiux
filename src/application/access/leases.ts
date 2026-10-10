import type { MemberKind } from './principal'

/**
 * Agent edit leases (accepted identity decision 11): per point resource, held by a member,
 * fail-fast, 5 minutes after the holder's last successful write or explicit acquire, in process
 * memory only. A lease is coordination; CAS stays the correctness guarantee.
 */
export const LOCKABLE_KINDS = ['view', 'flow', 'locale', 'asset', 'workspace'] as const
export type LockableKind = typeof LOCKABLE_KINDS[number]
export const LEASE_TTL_MS = 5 * 60 * 1000
export const MAX_ACQUIRE_RESOURCES = 16

export type LeaseAddress = Readonly<{ kind: LockableKind; key: string }>
export type LeaseHolder = Readonly<{ memberId: string; nickname: string; kind: MemberKind }>
export type Lease = Readonly<{ kind: LockableKind; key: string; holder: LeaseHolder; expiresAt: string }>
/** The public lease view: no member id, only the holder's nickname and kind. */
export type PublicLease = Readonly<{ kind: LockableKind; key: string; holder: Readonly<{ nickname: string; kind: MemberKind }>; expiresAt: string }>

export function isLockableKind(value: unknown): value is LockableKind {
	return typeof value === 'string' && (LOCKABLE_KINDS as readonly string[]).includes(value)
}

export function isValidLeaseAddress(value: unknown): value is LeaseAddress {
	if (typeof value !== 'object' || value === null) return false
	const { kind, key } = value as Record<string, unknown>
	if (!isLockableKind(kind) || typeof key !== 'string' || key.length === 0 || key.length > 256) return false
	return kind !== 'workspace' || key === 'workspace'
}

export function publicLease(lease: Lease): PublicLease {
	return { kind: lease.kind, key: lease.key, holder: { nickname: lease.holder.nickname, kind: lease.holder.kind }, expiresAt: lease.expiresAt }
}

export type LeaseChange = Readonly<{ kind: LockableKind; key: string }>

/** A synchronous check-and-reserve made before an asynchronous domain write (rule 4). */
export type WriteTicket = Readonly<{
	/** The write succeeded: keep (and renew) the reservation. */
	commit(): void
	/** The write failed: drop the reservation if it was new; an existing lease stays as it was. */
	abort(): void
	/** Moves a new reservation to the key the write actually produced (for example a canonical id). */
	rekey(key: string): void
}>

export type BeginWriteResult =
	| Readonly<{ status: 'ok'; ticket: WriteTicket }>
	| Readonly<{ status: 'locked'; lease: Lease }>

export type AcquireResult =
	| Readonly<{ status: 'acquired'; leases: readonly Lease[] }>
	| Readonly<{ status: 'locked'; conflicts: readonly Lease[] }>

export interface LeaseManager {
	/** The active lease on a resource, if any (expiry is evaluated lazily). */
	find(address: LeaseAddress): Lease | undefined
	/** Check (and for agents tentatively reserve) a resource before writing it. */
	beginWrite(address: LeaseAddress, holder: LeaseHolder, options: Readonly<{ autoAcquire: boolean }>): BeginWriteResult
	/** All-or-nothing acquire; re-acquiring one's own lease renews it. */
	acquire(addresses: readonly LeaseAddress[], holder: LeaseHolder): AcquireResult
	/** Releases the holder's leases on the listed resources, or all of them; idempotent. */
	release(holder: LeaseHolder, addresses?: readonly LeaseAddress[]): readonly Lease[]
	/** Owner force-release. */
	forceRelease(address: LeaseAddress): Lease | undefined
	/** Drops every lease held by a member (removal or loss of Editor). */
	dropHolder(memberId: string): readonly Lease[]
	list(): readonly Lease[]
	onChange(listener: (change: LeaseChange) => void): () => void
	/**
	 * Installs the check that a lease's holder may still hold it (the live server: still a member
	 * holding the kind's write key). A lease failing it has ended (Rule
	 * 01a11485-f074-7d3c-80f4-f4ced35ef8f2): every lookup drops it like an expired one, so it never
	 * blocks another member's write or acquire.
	 */
	setHolderCheck(check: ((lease: Lease) => boolean) | undefined): void
}

const addressKey = (address: LeaseAddress) => `${address.kind}\u0000${address.key}`

export function createLeaseManager(options: Readonly<{ now?: () => number; ttlMs?: number }> = {}): LeaseManager {
	const now = options.now ?? (() => Date.now())
	const ttl = options.ttlMs ?? LEASE_TTL_MS
	const leases = new Map<string, Lease>()
	const listeners = new Set<(change: LeaseChange) => void>()
	let holderCheck: ((lease: Lease) => boolean) | undefined

	const emit = (lease: Pick<Lease, 'kind' | 'key'>) => {
		for (const listener of listeners) {
			try { listener({ kind: lease.kind, key: lease.key }) }
			catch { /* listeners never break a write */ }
		}
	}

	function active(address: LeaseAddress): Lease | undefined {
		const id = addressKey(address)
		const lease = leases.get(id)
		if (!lease) return undefined
		// An expired lease, or one whose holder may no longer hold it, has ended: treat it as released.
		if (Date.parse(lease.expiresAt) <= now() || (holderCheck !== undefined && !holderCheck(lease))) {
			leases.delete(id)
			emit(lease)
			return undefined
		}
		return lease
	}

	function grant(address: LeaseAddress, holder: LeaseHolder): Lease {
		const lease: Lease = { kind: address.kind, key: address.key, holder, expiresAt: new Date(now() + ttl).toISOString() }
		leases.set(addressKey(address), lease)
		return lease
	}

	function sweep(): void {
		for (const lease of [...leases.values()]) active(lease)
	}

	return {
		find: active,

		beginWrite(address, holder, { autoAcquire }) {
			const existing = active(address)
			if (existing && existing.holder.memberId !== holder.memberId) return { status: 'locked', lease: existing }
			if (!autoAcquire) {
				// Human writes only check. A human never holds a lease, so a held one is always another member's.
				return { status: 'ok', ticket: { commit() {}, abort() {}, rekey() {} } }
			}
			let reserved: Lease = existing ?? grant(address, holder)
			const isNew = !existing
			if (isNew) emit(reserved)
			let settled = false
			return {
				status: 'ok',
				ticket: {
					commit() {
						if (settled) return
						settled = true
						const current = leases.get(addressKey(reserved))
						// Renew only while the reservation is still ours (it may have been force-released meanwhile).
						if (current === reserved || (current && current.holder.memberId === holder.memberId))
							grant(reserved, holder)
					},
					abort() {
						if (settled) return
						settled = true
						if (isNew && leases.get(addressKey(reserved)) === reserved) {
							leases.delete(addressKey(reserved))
							emit(reserved)
						}
					},
					rekey(key) {
						if (settled || !isNew || key === reserved.key) return
						if (leases.get(addressKey(reserved)) !== reserved) return
						const target = { kind: reserved.kind, key }
						const other = active(target)
						if (other && other.holder.memberId !== holder.memberId) return
						leases.delete(addressKey(reserved))
						emit(reserved)
						reserved = grant(target, holder)
						emit(reserved)
					},
				},
			}
		},

		acquire(addresses, holder) {
			const conflicts: Lease[] = []
			for (const address of addresses) {
				const existing = active(address)
				if (existing && existing.holder.memberId !== holder.memberId) conflicts.push(existing)
			}
			if (conflicts.length > 0) return { status: 'locked', conflicts }
			const granted = addresses.map(address => grant(address, holder))
			for (const lease of granted) emit(lease)
			return { status: 'acquired', leases: granted }
		},

		release(holder, addresses) {
			sweep()
			const targets = addresses
				? addresses.map(address => leases.get(addressKey(address))).filter((lease): lease is Lease => lease !== undefined)
				: [...leases.values()]
			const released: Lease[] = []
			for (const lease of targets) {
				if (lease.holder.memberId !== holder.memberId) continue
				leases.delete(addressKey(lease))
				released.push(lease)
				emit(lease)
			}
			return released
		},

		forceRelease(address) {
			const lease = active(address)
			if (!lease) return undefined
			leases.delete(addressKey(address))
			emit(lease)
			return lease
		},

		dropHolder(memberId) {
			const dropped: Lease[] = []
			for (const lease of [...leases.values()]) {
				if (lease.holder.memberId !== memberId) continue
				leases.delete(addressKey(lease))
				dropped.push(lease)
				emit(lease)
			}
			return dropped
		},

		list() {
			sweep()
			return [...leases.values()].sort((left, right) => addressKey(left) < addressKey(right) ? -1 : 1)
		},

		onChange(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},

		setHolderCheck(check) {
			holderCheck = check
		},
	}
}
