import { canonicalJsonStringify } from '../canonical-json'
import type { CurrentAdapterProvenance } from '../evidence/adapter-provenance'
import type { JsonObject } from '../validation'

/**
 * Rule 01a11a5e-1385-7484-baf3-93d865fd97a5: whether a historical frame shows the Adapters-changed
 * caveat. It does when the version's recorded Adapter provenance (`adapters`, Clause
 * 01a11a5e-201a-7532-8192-517b439c6c0c) is absent, differs from the current active set in selection,
 * order, content or configuration, or cannot be compared with it because the current provenance is
 * unavailable (Rule 01a115cd-c6de-7744-be27-715bec2e7fef judges the same way).
 */
export function adaptersChangedCaveat(recorded: readonly JsonObject[] | undefined, current: CurrentAdapterProvenance | undefined): boolean {
	if (!recorded) return true
	if (!current || current.state !== 'available') return true
	return canonicalJsonStringify(recorded) !== canonicalJsonStringify(current.adapters)
}
