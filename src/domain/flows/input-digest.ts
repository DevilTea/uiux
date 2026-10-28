import { createHash } from 'node:crypto'
import { canonicalJsonBytes } from '../canonical-json'

/**
 * The Flow input digest of a UX Flow (Clause 01a1814f-81c2-7c7a-93c8-1beecd1c5740): `sha256:<hex>`
 * over the canonical JSON of the Flow without its `requirements`, encoded as every other canonical
 * JSON identity is (`canonicalJsonBytes`). A `flow_trace` records it as `flowInputDigest` at
 * capture time, and its freshness compares it with the Flow's current one (Rule
 * 01a1814f-8256-7927-92d9-b3d2ba9e5719), so an edit of only the requirement references leaves the
 * trace fresh (Rule 01a18121-00a2-7263-a1e6-3729863eb0f6).
 *
 * Server-side only (it hashes with `node:crypto`); the Workbench receives the digests from the
 * Evidence list.
 */
export function flowInputDigest(flow: unknown): string {
	const record = typeof flow === 'object' && flow !== null && !Array.isArray(flow) ? flow as Record<string, unknown> : {}
	const rest = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'requirements'))
	return `sha256:${createHash('sha256').update(canonicalJsonBytes(rest)).digest('hex')}`
}
