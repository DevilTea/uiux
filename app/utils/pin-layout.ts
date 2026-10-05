import { clusterPins, PIN_CLUSTER_RADIUS, type PinEdgeSide, type PinHiddenReason, type PinPlacement, type PinPlacementState } from '../../src/preview/pin-visibility'
import type { Point } from '../../src/preview/protocol/schema'

/**
 * Presentation of the canvas pin layer (brief c §6–8; multi-target decision 7). Pure, so the
 * per-frame work stays small and testable:
 *
 * - `layoutPins` splits the visible placements into single pins and count clusters, in reading
 *   order, with a structural `key` that changes only when what is drawn changes (membership,
 *   clustering, order), never when pins merely move. The layer re-renders on the key and writes
 *   positions as transforms.
 * - `pinStatuses` reduces placements to `{ state, reason }` per thread for the list and bubble,
 *   which then re-render only when a thread's status changes, not on every scrolled frame.
 * - `canvasOrder` and `cycleThread` are the keyboard path through the pins (`J` / `K`).
 */

/** Rows closer than this many CSS px read as one row (left to right). */
const ROW_TOLERANCE = 4

/** Reading order: top to bottom, then left to right within a row. */
export function compareReadingOrder(left: Point, right: Point): number {
	const dy = left.y - right.y
	if (Math.abs(dy) > ROW_TOLERANCE) return dy
	return left.x - right.x || dy
}

export type PinLayoutItem =
	| Readonly<{ kind: 'pin'; key: string; threadId: string; point: Point }>
	| Readonly<{ kind: 'cluster'; key: string; threadIds: readonly string[]; point: Point }>

export type PinLayout = Readonly<{ items: readonly PinLayoutItem[]; key: string }>

/**
 * Visible pins, merged within `radius` into clusters (presentation only), in reading order.
 * Threads in `solo` (open, dragged, hovered in the list) are never merged; `excluded` ones (the
 * pending composer) are not laid out at all.
 */
export function layoutPins(
	placements: readonly PinPlacement[],
	options: Readonly<{ solo?: ReadonlySet<string>; excluded?: ReadonlySet<string>; radius?: number }> = {},
): PinLayout {
	const solo: PinLayoutItem[] = []
	const rest: PinPlacement[] = []
	for (const placement of placements) {
		if (placement.state !== 'visible' || !placement.point || options.excluded?.has(placement.threadId)) continue
		if (options.solo?.has(placement.threadId)) solo.push({ kind: 'pin', key: `p:${placement.threadId}`, threadId: placement.threadId, point: placement.point })
		else rest.push(placement)
	}
	const items: PinLayoutItem[] = [...solo]
	for (const cluster of clusterPins(rest, options.radius ?? PIN_CLUSTER_RADIUS)) {
		if (cluster.threadIds.length === 1) {
			const threadId = cluster.threadIds[0]!
			items.push({ kind: 'pin', key: `p:${threadId}`, threadId, point: cluster.point })
		}
		// A cluster keeps its element while its membership changes (keyed by its first thread).
		else items.push({ kind: 'cluster', key: `c:${cluster.threadIds[0]}`, threadIds: cluster.threadIds, point: cluster.point })
	}
	items.sort((left, right) => compareReadingOrder(left.point, right.point))
	return { items, key: items.map(item => item.kind === 'cluster' ? `${item.key}=${item.threadIds.join(',')}` : item.key).join('|') }
}

export type PinStatus = Readonly<{ state: PinPlacementState; reason?: PinHiddenReason | 'missing-widget'; side?: PinEdgeSide }>

/**
 * Per-thread `{ state, reason, side }`. Returns `previous` when nothing changed, so a computed
 * built on it does not trigger its dependents while pins only move.
 */
export function pinStatuses(placements: readonly PinPlacement[], previous?: ReadonlyMap<string, PinStatus>): ReadonlyMap<string, PinStatus> {
	const next = new Map<string, PinStatus>()
	let same = !!previous && previous.size === placements.length
	for (const placement of placements) {
		const status: PinStatus = {
			state: placement.state,
			...(placement.reason ? { reason: placement.reason } : {}),
			...(placement.edge ? { side: placement.edge.side } : {}),
		}
		const before = previous?.get(placement.threadId)
		if (same && (!before || before.state !== status.state || before.reason !== status.reason || before.side !== status.side)) same = false
		next.set(placement.threadId, status)
	}
	return same && previous ? previous : next
}

/**
 * The keyboard order of the pins on the canvas: drawn pins in reading order, then threads behind
 * edge indicators (top, right, bottom, left). Threads that are not on the canvas at all are left
 * to the Comments list.
 */
export function canvasOrder(placements: readonly PinPlacement[], excluded?: ReadonlySet<string>): string[] {
	const visible = placements.filter(placement => placement.state === 'visible' && placement.point && !excluded?.has(placement.threadId))
	visible.sort((left, right) => compareReadingOrder(left.point!, right.point!))
	const SIDES: readonly PinEdgeSide[] = ['top', 'right', 'bottom', 'left']
	const offscreen = placements
		.filter(placement => placement.state === 'offscreen' && placement.edge && !excluded?.has(placement.threadId))
		.sort((left, right) => SIDES.indexOf(left.edge!.side) - SIDES.indexOf(right.edge!.side))
	return [...visible, ...offscreen].map(placement => placement.threadId)
}

/** The next (`1`) or previous (`-1`) thread in `order`, wrapping; the first or last without a current one. */
export function cycleThread(order: readonly string[], current: string | undefined, direction: 1 | -1): string | undefined {
	if (!order.length) return undefined
	const index = current ? order.indexOf(current) : -1
	if (index < 0) return direction === 1 ? order[0] : order[order.length - 1]
	return order[(index + direction + order.length) % order.length]
}
