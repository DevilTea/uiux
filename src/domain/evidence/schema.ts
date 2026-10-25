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
import { validateI18nOccurrenceLocator, validateI18nWarning, type I18nOccurrenceLocator, type I18nWarning } from '../i18n/schema'
import { validateProductKitProvenance, type ProductKitProvenance } from '../product-kit/provenance'
import { validateAdapterProvenanceMembers } from '../adapters/schema'
import type { EvidenceAdapterProvenance } from './adapter-provenance'

export type EvidenceKind = string
export type EvidenceReference = Readonly<{ kind: EvidenceKind; evidence: string }>
export type EvidenceResourceRevision = Readonly<{ identity: JsonObject; revision: string }>
export type EvidenceProvenance = Readonly<{
	workspaceSchemaVersion: number
	resources: readonly EvidenceResourceRevision[]
	versions: Readonly<Record<string, string>>
	/** Clause 01a11bb1-8fc4-7b7d-87da-d3fc5d457d98: the Product Kit provenance at capture time; absent on a capture recorded without it. */
	productKit?: ProductKitProvenance
	/**
	 * Clause 01a1161c-008a-746d-8d53-a8301b23588f: every Adapter of the active set at capture time, in
	 * Adapter-list order; absent on a capture recorded without it, whose freshness is unknown (Rule
	 * 01a1161b-ff68-…).
	 */
	adapters?: readonly EvidenceAdapterProvenance[]
	/**
	 * Clause 01a14e30-2d4a-7ce9-ad68-58db56f36f47: the render-input digest of the captured View at
	 * capture time; absent on a capture recorded without it, which is stale (Rule 01a115cd-c53c-…).
	 */
	renderInputDigest?: string
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

/** Clause 01a115cd-cf78-7bfa-b606-b196496d0389: one evaluated translation-result Property of a formal capture. */
export type TranslationEvidenceOccurrence = Readonly<{
	occurrence: I18nOccurrenceLocator
	evaluatedText: string
	warnings: readonly I18nWarning[]
}>

/** Clause 01a17245-062a-7971-b541-6780119bbcfa: a declared translation-result Property that could not be evaluated. */
export type TranslationMissingOccurrence = Readonly<I18nOccurrenceLocator & { reason: string }>

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
	if (record.kind === 'formal_capture') validateFormalTranslationEvidence(record, path, v)
	if (Object.hasOwn(record, 'id'))
		v.issue('evidence.parallel_identity_forbidden', `${path}/id`, 'Formal evidence identity is the SHA-256 digest of its immutable serialized bytes.')
	return v.finish<FormalEvidenceRecord>(input)
}

/**
 * Clauses 01a17245-0527-7911-adbe-7af2e8962e18 (`data.translations`), 01a17245-05a6-7541-8d2a-0f30f310919b and
 * 01a17245-062a-7971-b541-6780119bbcfa (`coverage.translations`): both members are optional (a capture recorded
 * before them has neither), and a translation gap always makes the record's own coverage incomplete.
 */
function validateFormalTranslationEvidence(record: Readonly<Record<string, unknown>>, path: string, v: Validator): void {
	const data = isPlainObject(record.data) ? record.data : undefined
	const coverage = isPlainObject(record.coverage) ? record.coverage : undefined
	let entryCount: number | undefined
	if (data && Object.hasOwn(data, 'translations')) {
		const entries = v.array(data.translations, `${path}/data/translations`)
		entries?.forEach((entry, index) => v.diagnostics.push(...validateTranslationEvidenceOccurrence(entry, jsonPointer(`${path}/data/translations`, index)).diagnostics))
		entryCount = entries?.length
	}
	if (!coverage || !Object.hasOwn(coverage, 'translations')) return
	const translationsPath = `${path}/coverage/translations`
	const translations = v.object(coverage.translations, translationsPath)
	if (!translations) return
	if (typeof translations.complete !== 'boolean') {
		v.issue('evidence.invalid_translation_coverage', `${translationsPath}/complete`, 'Translation coverage must state whether every declared translation-result Property was evaluated.')
		return
	}
	if (translations.complete) {
		rejectUnknownKeys(translations, ['complete', 'evaluated'], translationsPath, v)
		if (typeof translations.evaluated !== 'number' || !Number.isInteger(translations.evaluated) || translations.evaluated < 0)
			v.issue('evidence.invalid_translation_coverage', `${translationsPath}/evaluated`, 'Complete translation coverage records how many Properties were evaluated, a non-negative integer.')
		else if (entryCount !== translations.evaluated)
			v.issue('evidence.translation_coverage_mismatch', `${translationsPath}/evaluated`, 'Complete translation coverage must count exactly the entries of data.translations.')
		return
	}
	rejectUnknownKeys(translations, ['complete', 'missing'], translationsPath, v)
	if (coverage.complete !== false)
		v.issue('evidence.translation_coverage_mismatch', `${path}/coverage/complete`, 'A record with a translation-result Property that could not be evaluated is not complete.')
	const missing = v.array(translations.missing, `${translationsPath}/missing`)
	if (!missing) return
	if (missing.length === 0)
		v.issue('evidence.invalid_translation_coverage', `${translationsPath}/missing`, 'Incomplete translation coverage lists at least one missing Property.')
	missing.forEach((item, index) => v.diagnostics.push(...validateTranslationMissingOccurrence(item, jsonPointer(`${translationsPath}/missing`, index)).diagnostics))
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
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
	if (Object.hasOwn(provenance, 'productKit')) validateProductKitProvenance(provenance.productKit, `${path}/productKit`, v)
	if (Object.hasOwn(provenance, 'adapters')) validateEvidenceAdapters(provenance.adapters, `${path}/adapters`, v)
	if (Object.hasOwn(provenance, 'renderInputDigest')) validateDigest(provenance.renderInputDigest, `${path}/renderInputDigest`, v)
	if (Object.hasOwn(provenance, 'gitCommit')) v.string(provenance.gitCommit, `${path}/gitCommit`, true)
}

/**
 * Clause 01a1161c-008a-746d-8d53-a8301b23588f: each entry has the Handoff entry's members but
 * `moduleIdentity` (`EvidenceAdapterProvenance`), and each Adapter ID appears once.
 */
function validateEvidenceAdapters(input: unknown, path: string, v: Validator): void {
	const adapters = v.array(input, path)
	if (!adapters) return
	const seen = new Set<string>()
	adapters.forEach((value, index) => {
		const entryPath = jsonPointer(path, index)
		const entry = v.object(value, entryPath)
		if (!entry) return
		rejectUnknownKeys(entry, ['moduleSpecifier', 'adapterId', 'apiVersion', 'packageVersion', 'contentDigest', 'configDigest'], entryPath, v)
		validateAdapterProvenanceMembers(entry, entryPath, v)
		if (typeof entry.adapterId !== 'string') return
		if (seen.has(entry.adapterId))
			v.issue('evidence.duplicate_adapter', `${entryPath}/adapterId`, `Adapter ${entry.adapterId} is recorded more than once.`)
		seen.add(entry.adapterId)
	})
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
	v.diagnostics.push(...validateI18nOccurrenceLocator(occurrence.occurrence, `${path}/occurrence`).diagnostics)
	v.string(occurrence.evaluatedText, `${path}/evaluatedText`)
	const warnings = v.array(occurrence.warnings, `${path}/warnings`)
	warnings?.forEach((warning, index) => v.diagnostics.push(...validateI18nWarning(warning, jsonPointer(`${path}/warnings`, index)).diagnostics))
	return v.finish<TranslationEvidenceOccurrence>(input)
}

export function validateTranslationMissingOccurrence(input: unknown, path = ''): ValidationResult<TranslationMissingOccurrence> {
	const v = new Validator()
	const missing = v.object(input, path)
	if (!missing) return v.finish<TranslationMissingOccurrence>(input)
	const { reason, ...locator } = missing
	v.diagnostics.push(...validateI18nOccurrenceLocator(locator, path).diagnostics)
	v.string(reason, `${path}/reason`, true)
	return v.finish<TranslationMissingOccurrence>(input)
}

export function validateEvidenceViewIdentity(value: unknown, path: string, v: Validator): void {
	validateUuid(value, path, v, 'View identity')
}
