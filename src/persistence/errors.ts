import type { Diagnostic } from '../domain/validation'

export type PersistenceErrorCode =
	| 'persistence.invalid_identity'
	| 'persistence.path_rejected'
	| 'persistence.invalid_json'
	| 'persistence.invalid_resource'
	| 'persistence.identity_mismatch'
	| 'persistence.resource_not_found'
	| 'persistence.resource_exists'
	| 'persistence.write_failed'
	| 'persistence.lock_busy'
	| 'persistence.recovery_failed'
	| 'persistence.asset_shape_invalid'
	| 'persistence.artifact_corrupt'
	| 'workspace.manifest_missing'
	| 'workspace.migration_required'
	| 'workspace.schema_unsupported'
	| 'workspace.migration_unavailable'
	| 'workspace.migration_failed'

export class PersistenceError extends Error {
	readonly code: PersistenceErrorCode
	readonly diagnostics: readonly Diagnostic[]
	override readonly cause?: unknown

	constructor(code: PersistenceErrorCode, message: string, options: { diagnostics?: readonly Diagnostic[]; cause?: unknown } = {}) {
		super(message)
		this.name = 'PersistenceError'
		this.code = code
		this.diagnostics = options.diagnostics ?? []
		this.cause = options.cause
	}
}
