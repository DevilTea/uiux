import { validateFormalEvidenceRecord, type FormalEvidenceRecord } from '../../domain/evidence/schema'

/**
 * The Evidence record in a parsed artifact when it is a valid record of one of `kinds`; any other
 * artifact yields `undefined`. The parsed `kind` is compared first, so a record of an unwanted kind
 * (such as a large `checks_run`) never reaches the full record validator, which costs about 1.5 ms
 * for a 175 KB record (issue #367). A record of a wanted kind is validated exactly as before and is
 * dropped when invalid.
 */
export function evidenceRecordOfKinds(value: unknown, kinds: readonly string[]): FormalEvidenceRecord | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
	const kind = (value as { kind?: unknown }).kind
	if (typeof kind !== 'string' || !kinds.includes(kind)) return undefined
	const validation = validateFormalEvidenceRecord(value)
	return validation.ok ? validation.value : undefined
}
