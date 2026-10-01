import { jsonPointer, validateUuid, Validator, type ValidationResult } from './validation'

/**
 * Cross-resource UUID ownership is checked after decoding resources. The
 * caller supplies only UUID-based identities; Variant and registry keys are
 * intentionally absent because their canonical identities are names/keys.
 */
export type FullUuidClaim = Readonly<{ id: unknown; resource: string; path: string }>

export function validateUniqueFullUuidClaims(claims: readonly FullUuidClaim[]): ValidationResult<readonly FullUuidClaim[]> {
	const v = new Validator()
	const owners = new Map<string, number>()
	claims.forEach((claim, index) => {
		const claimPath = claim.path || jsonPointer('', index)
		if (typeof claim.resource !== 'string' || claim.resource.length === 0)
			v.issue('identity.missing_resource_kind', `${claimPath}/resource`, 'UUID claim identifies its resource kind.')
		if (!validateUuid(claim.id, `${claimPath}/id`, v)) return
		const first = owners.get(claim.id)
		if (first !== undefined) {
			const firstClaim = claims[first]!
			v.issue('identity.duplicate_uuid', `${claimPath}/id`, `UUID is already claimed by ${firstClaim.resource} at ${firstClaim.path || jsonPointer('', first)}.`)
		}
		else {
			owners.set(claim.id, index)
		}
	})
	return v.finish<readonly FullUuidClaim[]>(claims)
}
