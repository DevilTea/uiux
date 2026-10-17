import { validateWorkspaceManifest } from '../domain/workspace/schema'
import { isRecord } from '../domain/validation'

/**
 * The Workspace schema policy: the one `schemaVersion` this UIUX reads. There is no other recognized
 * version and no migration (Rules 01a1144e-4fe2-7bbe-82f2-e846e43def27 and
 * 01a1144e-5079-7c4e-99a4-912094aba0d4): a Workspace at any other version, older or newer, is
 * `unsupported`.
 */
export type WorkspaceSchemaPolicy = Readonly<{
	currentVersion: number
}>

export type WorkspaceInspection =
	| Readonly<{ state: 'current'; version: number; targetVersion: number; diagnostics: readonly { code: string; path: string; message: string }[] }>
	| Readonly<{ state: 'unsupported'; version?: number; targetVersion: number; diagnostics: readonly { code: string; path: string; message: string }[] }>
	| Readonly<{ state: 'missing_manifest'; targetVersion: number; diagnostics: readonly { code: string; path: string; message: string }[] }>

export function defineWorkspaceSchemaPolicy(policy: WorkspaceSchemaPolicy): WorkspaceSchemaPolicy {
	if (!Number.isInteger(policy.currentVersion) || policy.currentVersion < 1)
		throw new TypeError('Workspace policy currentVersion must be a positive integer supplied by the product schema registry.')
	return Object.freeze({ currentVersion: policy.currentVersion })
}

/**
 * The message of every refusal of a Workspace whose `schemaVersion` is not the current one (Clause
 * 01a14928-275b-74d5-ad43-c82932e39cb3): it names the version read and the current version, and
 * suggests `uiux init` in a new directory to start over.
 */
export function unsupportedSchemaVersionMessage(version: number, currentVersion: number): string {
	return `Workspace schemaVersion ${version} is not supported: this UIUX reads only schemaVersion ${currentVersion}. To start over, run uiux init in a new directory.`
}

/**
 * The message of an operation refused because of `inspection`: `refusal`, followed by
 * {@link unsupportedSchemaVersionMessage} when the manifest has a `schemaVersion` other than the
 * current one.
 */
export function workspaceRefusalMessage(inspection: WorkspaceInspection, refusal: string): string {
	if (inspection.state !== 'unsupported' || inspection.version === undefined || !Number.isInteger(inspection.version) || inspection.version === inspection.targetVersion)
		return refusal
	return `${refusal} ${unsupportedSchemaVersionMessage(inspection.version, inspection.targetVersion)}`
}

export function inspectWorkspaceManifest(manifest: unknown, policy: WorkspaceSchemaPolicy): WorkspaceInspection {
	const validation = validateWorkspaceManifest(manifest)
	const version = isRecord(manifest) && typeof manifest.schemaVersion === 'number' ? manifest.schemaVersion : undefined
	if (version === undefined || !Number.isInteger(version) || version < 1) {
		return {
			state: 'unsupported',
			...(version === undefined ? {} : { version }),
			targetVersion: policy.currentVersion,
			diagnostics: validation.diagnostics.length > 0 ? validation.diagnostics : [{ code: 'workspace.invalid_schema_version', path: '/schemaVersion', message: 'Workspace schemaVersion is not a supported integer.' }],
		}
	}
	if (version === policy.currentVersion)
		return { state: 'current', version, targetVersion: policy.currentVersion, diagnostics: validation.diagnostics }
	return {
		state: 'unsupported',
		version,
		targetVersion: policy.currentVersion,
		diagnostics: [...validation.diagnostics, { code: 'workspace.schema_unsupported', path: '/schemaVersion', message: unsupportedSchemaVersionMessage(version, policy.currentVersion) }],
	}
}
