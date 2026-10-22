import type { AdapterProvenance } from '../adapters/schema'
import { canonicalJsonStringify } from '../canonical-json'

/**
 * One Adapter of the active set as a formal capture records it (Clause
 * 01a1161c-008a-746d-8d53-a8301b23588f): the Handoff entry of Clause 01a115cd-d7f6-74a1-ba9f-c20a24a31ae5
 * without its `moduleIdentity`, a host file URL that would differ between hosts sharing the Workspace.
 */
export type EvidenceAdapterProvenance = Omit<AdapterProvenance, 'moduleIdentity'>

/**
 * The Workspace's current Adapter provenance: every Adapter of the active set in Adapter-list order,
 * or `unavailable` when it cannot be computed now (the Product Kit file cannot be read, the Adapter
 * set is invalid, or an Adapter has neither a package version nor a content digest), so freshness
 * judged against it is unknown.
 */
export type CurrentAdapterProvenance =
	| Readonly<{ state: 'unavailable' }>
	| Readonly<{ state: 'available'; adapters: readonly EvidenceAdapterProvenance[] }>

/** The Evidence form of a Handoff Adapter provenance entry: the same members without `moduleIdentity`. */
export function evidenceAdapterProvenance(provenance: AdapterProvenance): EvidenceAdapterProvenance {
	const { moduleIdentity: _moduleIdentity, ...recorded } = provenance
	void _moduleIdentity
	return recorded
}

/**
 * The members of an Evidence staleness context (and of the Evidence list) that carry `current`:
 * `{ adapters }` when available, else `{ adaptersUnavailable: true }`.
 */
export function adapterFreshnessContext(current: CurrentAdapterProvenance): Readonly<{ adapters?: readonly EvidenceAdapterProvenance[]; adaptersUnavailable?: true }> {
	if (current.state === 'available') return { adapters: current.adapters }
	return { adaptersUnavailable: true }
}

/**
 * Rule 01a115cd-c6de-7744-be27-715bec2e7fef: true once the recorded Adapter provenance no longer
 * matches the current one in selection, order, content or configuration, that is, once the two
 * lists differ in length or any entry differs in any member.
 */
export function adapterProvenanceChanged(recorded: readonly EvidenceAdapterProvenance[], current: readonly EvidenceAdapterProvenance[]): boolean {
	return canonicalJsonStringify(recorded) !== canonicalJsonStringify(current)
}
