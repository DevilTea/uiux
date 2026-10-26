import { canonicalJsonBytes } from '../canonical-json'
import {
	jsonPointer,
	rejectUnknownKeys,
	validateJsonValue,
	validateUtcTimestamp,
	Validator,
	type JsonObject,
	type JsonValue,
	type ValidationResult,
} from '../validation'

/**
 * The Run Checks Evidence record (Clause 01a17670-d442-7068-8a08-c6e4ab9c09ae, owner ruling 2 of
 * https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19186750): a formal Evidence
 * record of `kind` `checks_run`, written by the Workbench after a Run Checks. Its findings are
 * reported by the Workbench, never re-checked by the server, and the record is never a formal
 * capture: nothing that reads `formal_capture` records reads it.
 */
export const CHECKS_RUN_KIND = 'checks_run'

/** The sources a run covers, in the order a record lists them; the live Preview's two are not part of a run. */
export const CHECKS_RUN_SOURCES = ['validation', 'translation', 'catalog', 'product-kit'] as const
export type ChecksRunSource = typeof CHECKS_RUN_SOURCES[number]

/** The state a run ends a source in; a source that is not checked, or still checking, is not a result. */
export const CHECKS_RUN_STATES = ['completed', 'incomplete', 'failed'] as const
export type ChecksRunState = typeof CHECKS_RUN_STATES[number]

export const CHECKS_RUN_SEVERITIES = ['error', 'warning'] as const
export const CHECKS_RUN_RESOURCE_KINDS = ['workspace', 'view', 'flow', 'locale', 'asset', 'product-kit'] as const

/** The bounds of Clause 01a17670-d442-7068-8a08-c6e4ab9c09ae. */
export const MAX_CHECKS_RUN_FINDINGS = 2000
export const MAX_CHECKS_RUN_CODE_LENGTH = 200
export const MAX_CHECKS_RUN_MESSAGE_LENGTH = 1000
export const MAX_CHECKS_RUN_PATH_LENGTH = 1000
export const MAX_CHECKS_RUN_RESOURCE_KEY_LENGTH = 512
export const MAX_CHECKS_RUN_RESOURCE_NAME_LENGTH = 500
export const MAX_CHECKS_RUN_IDENTIFIER_LENGTH = 200
export const MAX_CHECKS_RUN_BYTES = 524_288

export type ChecksRunFinding = Readonly<{
	source: ChecksRunSource
	code: string
	message: string
	path: string
	resource: Readonly<{ kind: typeof CHECKS_RUN_RESOURCE_KINDS[number]; key: string; name: string }>
	severity: typeof CHECKS_RUN_SEVERITIES[number]
	checkState: ChecksRunState
	widgetId?: string
	variantName?: string
}>

/** What a caller reports: the record's `executionContext.ranAt` and its `data`. */
export type ChecksRunInput = Readonly<{
	ranAt: string
	sources: readonly Readonly<{ source: ChecksRunSource; state: ChecksRunState }>[]
	findings: readonly ChecksRunFinding[]
}>

const INVALID = 'evidence.invalid_checks_run'
const MISMATCH = 'evidence.checks_run_mismatch'

function bounded(v: Validator, value: unknown, path: string, max: number, nonEmpty: boolean): void {
	const text = v.string(value, path, nonEmpty)
	if (text !== undefined && text.length > max) v.issue(INVALID, path, `At most ${max} characters.`)
}

function oneOf(v: Validator, value: unknown, path: string, allowed: readonly string[], label: string): void {
	if (typeof value !== 'string' || !allowed.includes(value)) v.issue(INVALID, path, `${label} is one of ${allowed.join(', ')}.`)
}

/** `{ sources, findings }`, the `data` of a record and the matching members of the tool input. */
function validateChecksRunData(sources: unknown, findings: unknown, path: string, v: Validator): void {
	const list = v.array(sources, `${path}/sources`)
	if (list) {
		if (list.length !== CHECKS_RUN_SOURCES.length)
			v.issue(INVALID, `${path}/sources`, `A run lists each of ${CHECKS_RUN_SOURCES.join(', ')} once, in that order.`)
		list.forEach((value, index) => {
			const entryPath = jsonPointer(`${path}/sources`, index)
			const entry = v.object(value, entryPath)
			if (!entry) return
			rejectUnknownKeys(entry, ['source', 'state'], entryPath, v)
			if (entry.source !== CHECKS_RUN_SOURCES[index]) v.issue(INVALID, `${entryPath}/source`, `Source ${index + 1} of a run is ${CHECKS_RUN_SOURCES[index]}.`)
			oneOf(v, entry.state, `${entryPath}/state`, CHECKS_RUN_STATES, 'A source state')
		})
	}
	const items = v.array(findings, `${path}/findings`)
	if (!items) return
	if (items.length > MAX_CHECKS_RUN_FINDINGS)
		v.issue(INVALID, `${path}/findings`, `A run records at most ${MAX_CHECKS_RUN_FINDINGS} findings.`)
	items.slice(0, MAX_CHECKS_RUN_FINDINGS).forEach((value, index) => validateChecksRunFinding(value, jsonPointer(`${path}/findings`, index), v))
}

function validateChecksRunFinding(value: unknown, path: string, v: Validator): void {
	const finding = v.object(value, path)
	if (!finding) return
	rejectUnknownKeys(finding, ['source', 'code', 'message', 'path', 'resource', 'severity', 'checkState', 'widgetId', 'variantName'], path, v)
	oneOf(v, finding.source, `${path}/source`, CHECKS_RUN_SOURCES, 'A finding source')
	bounded(v, finding.code, `${path}/code`, MAX_CHECKS_RUN_CODE_LENGTH, false)
	bounded(v, finding.message, `${path}/message`, MAX_CHECKS_RUN_MESSAGE_LENGTH, false)
	bounded(v, finding.path, `${path}/path`, MAX_CHECKS_RUN_PATH_LENGTH, false)
	oneOf(v, finding.severity, `${path}/severity`, CHECKS_RUN_SEVERITIES, 'A severity')
	oneOf(v, finding.checkState, `${path}/checkState`, CHECKS_RUN_STATES, 'A check state')
	const resource = v.object(finding.resource, `${path}/resource`)
	if (resource) {
		rejectUnknownKeys(resource, ['kind', 'key', 'name'], `${path}/resource`, v)
		oneOf(v, resource.kind, `${path}/resource/kind`, CHECKS_RUN_RESOURCE_KINDS, 'A resource kind')
		bounded(v, resource.key, `${path}/resource/key`, MAX_CHECKS_RUN_RESOURCE_KEY_LENGTH, true)
		bounded(v, resource.name, `${path}/resource/name`, MAX_CHECKS_RUN_RESOURCE_NAME_LENGTH, false)
	}
	for (const key of ['widgetId', 'variantName'] as const)
		if (Object.hasOwn(finding, key)) bounded(v, finding[key], `${path}/${key}`, MAX_CHECKS_RUN_IDENTIFIER_LENGTH, true)
}

/** The input of `record_checks_run` and `POST /api/checks/runs`: `{ ranAt, sources, findings }`. */
export function validateChecksRunInput(input: unknown, path = ''): ValidationResult<ChecksRunInput> {
	const v = new Validator()
	const body = v.object(input, path)
	if (!body) return v.finish<ChecksRunInput>(input)
	validateJsonValue(input, path, v)
	rejectUnknownKeys(body, ['ranAt', 'sources', 'findings'], path, v)
	validateUtcTimestamp(body.ranAt, `${path}/ranAt`, v)
	validateChecksRunData(body.sources, body.findings, path, v)
	return v.finish<ChecksRunInput>(input)
}

/** The state of a whole run: complete only when every source completed. */
export function checksRunComplete(sources: ChecksRunInput['sources']): boolean {
	return sources.every(entry => entry.state === 'completed')
}

/** The record's `coverage` and `data`, from a validated input. */
export function checksRunCoverageAndData(input: ChecksRunInput): Readonly<{ coverage: JsonObject; data: JsonObject }> {
	return {
		coverage: {
			complete: checksRunComplete(input.sources),
			sources: Object.fromEntries(input.sources.map(entry => [entry.source, entry.state])),
		},
		data: { sources: input.sources as unknown as JsonValue[], findings: input.findings as unknown as JsonValue[] },
	}
}

/**
 * The `checks_run` part of the formal Evidence record validation (Clause 01a17670-d442-7068-8a08-c6e4ab9c09ae):
 * the record's own shape, and the agreement of `coverage` with `data.sources`. Whether a finding is true is
 * not judged: the Workbench reported it.
 */
export function validateChecksRunEvidence(record: Readonly<Record<string, unknown>>, path: string, v: Validator): void {
	if (record.schemaVersion !== 1) v.issue(INVALID, `${path}/schemaVersion`, 'A checks_run record has schemaVersion 1.')
	if (isObject(record.executionContext)) {
		rejectUnknownKeys(record.executionContext, ['ranAt'], `${path}/executionContext`, v)
		validateUtcTimestamp(record.executionContext.ranAt, `${path}/executionContext/ranAt`, v)
	}
	if (Array.isArray(record.artifactRefs) && record.artifactRefs.length > 0)
		v.issue(INVALID, `${path}/artifactRefs`, 'A checks_run record references no artifact.')
	if (Object.hasOwn(record, 'evidenceRefs'))
		v.issue(INVALID, `${path}/evidenceRefs`, 'A checks_run record references no Evidence.')
	if (isObject(record.provenance) && Array.isArray(record.provenance.resources) && record.provenance.resources.length > 0)
		v.issue(INVALID, `${path}/provenance/resources`, 'A checks_run record lists no resource: its findings are reported, not read, by the server.')
	const data = v.object(record.data, `${path}/data`)
	if (!data) return
	rejectUnknownKeys(data, ['sources', 'findings'], `${path}/data`, v)
	const before = v.diagnostics.length
	validateChecksRunData(data.sources, data.findings, `${path}/data`, v)
	const coverage = isObject(record.coverage) ? record.coverage : undefined
	if (coverage) {
		rejectUnknownKeys(coverage, ['complete', 'sources'], `${path}/coverage`, v)
		const states = isObject(coverage.sources) ? coverage.sources : undefined
		if (!states) v.issue(INVALID, `${path}/coverage/sources`, 'Coverage maps each source to its state.')
		if (states && v.diagnostics.length === before) {
			const listed = data.sources as readonly { source: string; state: string }[]
			const same = Object.keys(states).length === listed.length && listed.every(entry => states[entry.source] === entry.state)
			if (!same) v.issue(MISMATCH, `${path}/coverage/sources`, 'Coverage states each source as data.sources does.')
			if (coverage.complete !== listed.every(entry => entry.state === 'completed'))
				v.issue(MISMATCH, `${path}/coverage/complete`, 'A run is complete only when every source completed.')
		}
	}
	// The record's size is measured last, on a record that is otherwise valid (so it is JSON).
	if (v.diagnostics.length === 0 && canonicalJsonBytes(record).byteLength > MAX_CHECKS_RUN_BYTES)
		v.issue(INVALID, path, `A checks_run record holds at most ${MAX_CHECKS_RUN_BYTES} bytes of JSON.`)
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
