import {
	jsonPointer,
	rejectUnknownKeys,
	validateDigest,
	validateJsonValue,
	validateUuid,
	Validator,
	type JsonObject,
	type JsonValue,
	type ValidationResult,
} from '../validation'
import { validateI18nOccurrence, validateI18nWarning, type I18nOccurrence, type I18nWarning } from '../i18n/schema'

export type EvidenceKind = string
export type EvidenceReference = Readonly<{ kind: EvidenceKind; evidence: string }>
export type EvidenceResourceRevision = Readonly<{ identity: JsonObject; revision: string }>
export type EvidenceProvenance = Readonly<{
	workspaceSchemaVersion: number
	resources: readonly EvidenceResourceRevision[]
	versions: Readonly<Record<string, string>>
	gitCommit?: string
}>
export type EvidenceCoverage = Readonly<{
	complete: boolean
	[key: string]: JsonValue
}>
export type FormalEvidenceRecord = Readonly<{
	schemaVersion: number
	kind: EvidenceKind
	executionContext: JsonObject
	coverage: EvidenceCoverage
	provenance: EvidenceProvenance
	artifactRefs: readonly string[]
	evidenceRefs?: readonly EvidenceReference[]
	data?: JsonObject
}>

export type TranslationEvidenceOccurrence = Readonly<{
	occurrence: I18nOccurrence
	evaluatedText: string
	warnings: readonly I18nWarning[]
}>

export function validateEvidenceReference(input: unknown, path = ''): ValidationResult<EvidenceReference> {
	const v = new Validator()
	const ref = v.object(input, path)
	if (!ref) return v.finish<EvidenceReference>(input)
	rejectUnknownKeys(ref, ['kind', 'evidence'], path, v)
	v.string(ref.kind, `${path}/kind`, true)
	validateDigest(ref.evidence, `${path}/evidence`, v)
	return v.finish<EvidenceReference>(input)
}

export function validateFormalEvidenceRecord(input: unknown, path = ''): ValidationResult<FormalEvidenceRecord> {
	const v = new Validator()
	const record = v.object(input, path)
	if (!record) return v.finish<FormalEvidenceRecord>(input)
	validateJsonValue(input, path, v)
	positiveInteger(record.schemaVersion, `${path}/schemaVersion`, v)
	v.string(record.kind, `${path}/kind`, true)
	const context = v.object(record.executionContext, `${path}/executionContext`)
	if (context) validateJsonValue(context, `${path}/executionContext`, v)
	const coverage = v.object(record.coverage, `${path}/coverage`)
	if (coverage && typeof coverage.complete !== 'boolean')
		v.issue('evidence.invalid_coverage', `${path}/coverage/complete`, 'Coverage must state whether the formal run was complete.')
	if (coverage) validateJsonValue(coverage, `${path}/coverage`, v)
	validateEvidenceProvenance(record.provenance, `${path}/provenance`, v)
	const artifacts = v.array(record.artifactRefs, `${path}/artifactRefs`)
	artifacts?.forEach((identity, index) => validateDigest(identity, jsonPointer(`${path}/artifactRefs`, index), v))
	if (Object.hasOwn(record, 'evidenceRefs')) {
		const refs = v.array(record.evidenceRefs, `${path}/evidenceRefs`)
		refs?.forEach((ref, index) => v.diagnostics.push(...validateEvidenceReference(ref, jsonPointer(`${path}/evidenceRefs`, index)).diagnostics))
	}
	if (Object.hasOwn(record, 'data')) {
		const data = v.object(record.data, `${path}/data`)
		if (data) validateJsonValue(data, `${path}/data`, v)
	}
	if (Object.hasOwn(record, 'id'))
		v.issue('evidence.parallel_identity_forbidden', `${path}/id`, 'Formal evidence identity is the SHA-256 digest of its immutable serialized bytes.')
	return v.finish<FormalEvidenceRecord>(input)
}

function validateEvidenceProvenance(input: unknown, path: string, v: Validator): void {
	const provenance = v.object(input, path)
	if (!provenance) return
	positiveInteger(provenance.workspaceSchemaVersion, `${path}/workspaceSchemaVersion`, v)
	const resources = v.array(provenance.resources, `${path}/resources`)
	resources?.forEach((resourceValue, index) => {
		const resourcePath = jsonPointer(`${path}/resources`, index)
		const resource = v.object(resourceValue, resourcePath)
		if (!resource) return
		const identity = v.object(resource.identity, `${resourcePath}/identity`)
		if (identity) validateJsonValue(identity, `${resourcePath}/identity`, v)
		v.string(resource.revision, `${resourcePath}/revision`, true)
	})
	const versions = v.object(provenance.versions, `${path}/versions`)
	if (versions) {
		if (!Object.hasOwn(versions, 'uiux'))
			v.issue('evidence.missing_uiux_version', `${path}/versions/uiux`, 'Evidence provenance records the UIUX version.')
		for (const [key, value] of Object.entries(versions))
			v.string(value, jsonPointer(`${path}/versions`, key), true)
	}
	if (Object.hasOwn(provenance, 'gitCommit')) v.string(provenance.gitCommit, `${path}/gitCommit`, true)
}

function positiveInteger(value: unknown, path: string, v: Validator): void {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
		v.issue('schema.expected_positive_integer', path, 'Expected a positive integer.')
}

/** An occurrence warning is evidence data, not a corruption or blocking flag. */
export function translationEvidenceContainsWarnings(value: TranslationEvidenceOccurrence): boolean {
	return value.warnings.length > 0
}

export function validateTranslationEvidenceOccurrence(input: unknown, path = ''): ValidationResult<TranslationEvidenceOccurrence> {
	const v = new Validator()
	const occurrence = v.object(input, path)
	if (!occurrence) return v.finish<TranslationEvidenceOccurrence>(input)
	rejectUnknownKeys(occurrence, ['occurrence', 'evaluatedText', 'warnings'], path, v)
	v.diagnostics.push(...validateI18nOccurrence(occurrence.occurrence, `${path}/occurrence`).diagnostics)
	v.string(occurrence.evaluatedText, `${path}/evaluatedText`)
	const warnings = v.array(occurrence.warnings, `${path}/warnings`)
	warnings?.forEach((warning, index) => v.diagnostics.push(...validateI18nWarning(warning, jsonPointer(`${path}/warnings`, index)).diagnostics))
	return v.finish<TranslationEvidenceOccurrence>(input)
}

export function validateEvidenceViewIdentity(value: unknown, path: string, v: Validator): void {
	validateUuid(value, path, v, 'View identity')
}
