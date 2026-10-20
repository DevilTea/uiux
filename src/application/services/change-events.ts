import { randomUUID } from 'node:crypto'

import type { LeaseManager } from '../access/leases'
import type { ResourceRevision } from '../dto/revisions'
import { ACCESS_PRESETS_RESOURCE_KIND } from '../../domain/access-presets/schema'
import type { CommittedResourceChange } from '../../persistence/file-native'

/**
 * The change events the server pushes to open Workbenches (Feature "Live refresh",
 * 01a111e4-0315-7755-b867-e3c7b50d22e6; names and payload fields owned by Clause
 * 01a114ec-e839-7b11-957c-41c88b692e12). An event names what changed and never carries canonical
 * content, an actor or a message body (Rule 01a11485-f382-7307-b0c1-a1947715cf03): clients re-read
 * through the normal point-read and list APIs.
 */
export type ChangeEvent =
	| Readonly<{ type: 'resource.changed'; kind: ChangeEventResourceKind; key: string; revision: ResourceRevision }>
	| Readonly<{ type: 'resource.removed'; kind: ChangeEventResourceKind; key: string }>
	| Readonly<{ type: 'lock.changed'; kind: string; key: string }>
	| Readonly<{ type: 'access.changed' }>

/**
 * The resources whose commits emit (Rule 01a11485-f365-70ce-82d9-43ea3f5ea5bb, with the Access
 * presets of Clause 01a114ec-e839-7b11-957c-41c88b692e12). History adds no kind (Rule
 * 01a11a5e-08c7-73c1-bc66-3af814a454d6).
 */
export const CHANGE_EVENT_RESOURCE_KINDS = ['view', 'flow', 'locale', 'review', 'asset', 'workspace', ACCESS_PRESETS_RESOURCE_KIND] as const
export type ChangeEventResourceKind = typeof CHANGE_EVENT_RESOURCE_KINDS[number]

export function isChangeEventResourceKind(kind: string): kind is ChangeEventResourceKind {
	return (CHANGE_EVENT_RESOURCE_KINDS as readonly string[]).includes(kind)
}

export type ChangeEventListener = (event: ChangeEvent) => void

export interface ChangeEventBus {
	/** A new ID per server process: a client that sees it change resynchronizes (Rule 01a11485-f39f-7464-9f8f-608335ed9800). */
	readonly serverInstanceId: string
	publish(event: ChangeEvent): void
	subscribe(listener: ChangeEventListener): () => void
	readonly subscriberCount: number
}

/** An in-process bus: events go to the listeners subscribed now, and nothing is kept or replayed. */
export function createChangeEventBus(options: Readonly<{ serverInstanceId?: string }> = {}): ChangeEventBus {
	const listeners = new Set<ChangeEventListener>()
	return {
		serverInstanceId: options.serverInstanceId ?? randomUUID(),
		publish(event) {
			for (const listener of [...listeners]) {
				try { listener(event) }
				catch (error) { console.error(`uiux: a change-event listener failed: ${error instanceof Error ? error.message : String(error)}`) }
			}
		},
		subscribe(listener) {
			listeners.add(listener)
			return () => { listeners.delete(listener) }
		},
		get subscriberCount() {
			return listeners.size
		},
	}
}

/** The events for the resources of one committed write; other kinds (the Product Kit file) emit none. */
export function changeEventsForCommit(changes: readonly CommittedResourceChange[]): readonly ChangeEvent[] {
	const events: ChangeEvent[] = []
	for (const change of changes) {
		if (!isChangeEventResourceKind(change.kind)) continue
		events.push(change.revision === null
			? { type: 'resource.removed', kind: change.kind, key: change.key }
			: { type: 'resource.changed', kind: change.kind, key: change.key, revision: change.revision })
	}
	return events
}

/**
 * Publishes every committed canonical write of `persistence`, from `/api/*` and `/mcp` alike, since
 * both commit through the same persistence in this process (Rule 01a11485-f3bb-760b-9132-0e8c2f6bbf43).
 */
export function publishCommits(bus: ChangeEventBus, persistence: Readonly<{ onCanonicalCommit(listener: (changes: readonly CommittedResourceChange[]) => void): () => void }>): () => void {
	return persistence.onCanonicalCommit((changes) => {
		for (const event of changeEventsForCommit(changes)) bus.publish(event)
	})
}

/** Publishes `lock.changed` when a lease is acquired, released, ends or is force-released (Rule 01a114ec-e706-7c39-84a6-2e4a536daed2). */
export function publishLeaseChanges(bus: ChangeEventBus, leases: Pick<LeaseManager, 'onChange'>): () => void {
	return leases.onChange(change => bus.publish({ type: 'lock.changed', kind: change.kind, key: change.key }))
}
