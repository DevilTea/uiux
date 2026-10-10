/**
 * The fixed values of the Version history records Contract (01a11a5e-1db8-7f0b-b7fa-ee8836c0cfa7).
 * Rule 01a11a5e-015f-79f8-9d29-72674bd748c6: the autosave boundaries and the host retention are
 * fixed; nothing here is read from a Workspace setting, a command option or the environment.
 */

/** Clause 01a11a5e-1f14-7a54-ab36-2c1e53bbc995: the format version of every history record. */
export const HISTORY_SCHEMA_VERSION = 1

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS

/** Clause 01a11a5e-2320-7d05-94b9-01e99c0ef7d2: the autosave closing boundaries. */
export const AUTOSAVE_IDLE_MS = 2 * MINUTE_MS
export const AUTOSAVE_MAX_SPAN_MS = 30 * MINUTE_MS
export const AUTOSAVE_MAX_EVENTS = 200

/** Clause 01a11a5e-2374-7d1e-8c35-778d6188cbfe: host retention of autosave and external versions. */
export const HOST_RETENTION_MAX_AGE_MS = 30 * DAY_MS
export const HOST_RETENTION_MIN_KEPT = 200
export const HOST_PRUNE_INTERVAL_MS = DAY_MS

/** Clause 01a11a5e-2272-795d-8806-1dedf74f7e21: checkpoint name and note limits, in characters. */
export const CHECKPOINT_NAME_MIN_LENGTH = 1
export const CHECKPOINT_NAME_MAX_LENGTH = 120
export const CHECKPOINT_NOTE_MAX_LENGTH = 2000

/**
 * Clause 01a11a5e-1fc4-7bf0-a402-61c345f454c2: the resource kinds this build knows. The set is open
 * (seam 3): records naming another kind still validate; `product-kit` and `access-presets` are
 * listed by the Clause and arrive with later schema versions.
 */
export const HISTORY_RESOURCE_KINDS = Object.freeze(['workspace', 'product-kit', 'access-presets', 'view', 'flow', 'locale', 'asset'] as const)
export type KnownHistoryResourceKind = typeof HISTORY_RESOURCE_KINDS[number]
/** The kinds whose only key is the kind itself. */
export const SINGLETON_HISTORY_RESOURCE_KINDS = Object.freeze(['workspace', 'product-kit', 'access-presets'] as const)

/** Clauses 01a11a5e-2070-7c38-a62e-daae1fd8ac43 and 01a11a5e-20c6-7573-8530-e6fed6d8d4af. */
export const HOST_VERSION_TYPES = Object.freeze(['autosave', 'external', 'system'] as const)
export type HostVersionType = typeof HOST_VERSION_TYPES[number]
export const HISTORY_VERSION_TYPES = Object.freeze(['checkpoint', ...HOST_VERSION_TYPES] as const)
export type HistoryVersionType = typeof HISTORY_VERSION_TYPES[number]

/** Clause 01a11a5e-216d-7587-8022-66a66f264eee: the design operations recorded as write events. */
export const HISTORY_WRITE_OPERATIONS = Object.freeze([
	'createView',
	'updateViewSpec',
	'updateViewStructure',
	'updateWorkspaceSettings',
	'composeProductKit',
	'updateProductKit',
	'updateComponentRegistry',
	'updateAccessPresets',
	'createLocale',
	'updateLocale',
	'createFlow',
	'updateFlow',
	'createAsset',
	'replaceAsset',
	'promoteReviewToDecision',
	'restoreResourceVersion',
] as const)
export type HistoryWriteOperation = typeof HISTORY_WRITE_OPERATIONS[number]

/** Clause 01a11a5e-21c4-79f7-b6f9-4128d842c278: actor types and system actor ids. */
export const HISTORY_ACTOR_TYPES = Object.freeze(['human', 'agent', 'system', 'external'] as const)
export type HistoryActorType = typeof HISTORY_ACTOR_TYPES[number]
export const HISTORY_SYSTEM_ACTOR_IDS = Object.freeze(['system:migrate', 'system:baseline'] as const)
export type HistorySystemActorId = typeof HISTORY_SYSTEM_ACTOR_IDS[number]

/** Clause 01a11a5e-221b-7a04-a6cb-66bc9608c11f. */
export const HISTORY_SOURCES = Object.freeze(['workbench', 'mcp', 'cli'] as const)
export type HistorySource = typeof HISTORY_SOURCES[number]

/** Clause 01a11a5e-22ca-756e-8128-8f730ca887c9: system checkpoint names. */
export const BASELINE_CHECKPOINT_NAME = 'Baseline'
export function migrationCheckpointName(targetSchemaVersion: number): string {
	return `Before migration to schemaVersion ${targetSchemaVersion}`
}

/** Clause 01a11a5e-23cd-718c-b4db-807f823238ed: per-resource comparison summary statuses. */
export const COMPARISON_SUMMARY_STATUSES = Object.freeze(['added', 'removed', 'modified', 'unchanged'] as const)
export type ComparisonSummaryStatus = typeof COMPARISON_SUMMARY_STATUSES[number]

/**
 * The resource kinds this build can restore from a version (Feature
 * 01a11a5d-fd6b-7f9d-be15-2bc2bc3adc13). Review threads are never restored (Rule
 * 01a11a5e-189f-7b86-8270-e9b5d62aaa65); `product-kit`, `access-presets` and kinds this build does
 * not know are refused (seam 3). Shared by the restore service and the Workbench, which offers
 * "Restore this version" for these kinds only.
 */
export const RESTORABLE_RESOURCE_KINDS = Object.freeze(['workspace', 'view', 'flow', 'locale', 'asset'] as const satisfies readonly KnownHistoryResourceKind[])
export type RestorableResourceKind = typeof RESTORABLE_RESOURCE_KINDS[number]

export function isRestorableResourceKind(kind: unknown): kind is RestorableResourceKind {
	return typeof kind === 'string' && (RESTORABLE_RESOURCE_KINDS as readonly string[]).includes(kind)
}
