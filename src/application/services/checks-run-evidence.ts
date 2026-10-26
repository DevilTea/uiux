import packageJson from '../../../package.json' with { type: 'json' }
import { canonicalJsonBytes } from '../../domain/canonical-json'
import { checksRunCoverageAndData, CHECKS_RUN_KIND, validateChecksRunInput } from '../../domain/evidence/checks-run'
import { validateFormalEvidenceRecord, type FormalEvidenceRecord } from '../../domain/evidence/schema'
import type { Diagnostic } from '../../domain/validation'
import type { FileNativePersistence } from '../../persistence'

export type RecordChecksRunResult =
	| Readonly<{ status: 'recorded'; evidenceDigest: string; evidence: FormalEvidenceRecord }>
	| Readonly<{ status: 'invalid'; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'failed'; diagnostics: readonly Diagnostic[] }>

export interface ChecksRunEvidenceService {
	record(input: unknown): Promise<RecordChecksRunResult>
}

/**
 * Run Checks Evidence (Rule 01a115cd-bc2c-795f-babe-0d19eb80de96, Clauses 01a17670-d442-7068-8a08-c6e4ab9c09ae
 * and 01a17671-11bf-7711-887b-121a02602cf4): the Workbench reports what a Run Checks found, and the server
 * stores it as one immutable `checks_run` record. The findings are not checked again; the input is bounded
 * and shaped, and an input that is not is refused before anything is stored.
 */
export function createChecksRunEvidenceService(persistence: FileNativePersistence): ChecksRunEvidenceService {
	async function record(input: unknown): Promise<RecordChecksRunResult> {
		const parsed = validateChecksRunInput(input)
		if (!parsed.ok) return { status: 'invalid', diagnostics: parsed.diagnostics }
		const workspace = await persistence.workspace.readInspected()
		if (!workspace.resource || !workspace.revision)
			return { status: 'failed', diagnostics: [{ code: 'workspace.manifest_missing', path: '/workspace', message: 'Selected workspace manifest is missing or unreadable.' }] }
		const { coverage, data } = checksRunCoverageAndData(parsed.value)
		const evidence: FormalEvidenceRecord = {
			schemaVersion: 1,
			kind: CHECKS_RUN_KIND,
			executionContext: { ranAt: parsed.value.ranAt },
			coverage: coverage as FormalEvidenceRecord['coverage'],
			provenance: {
				workspaceSchemaVersion: workspace.resource.schemaVersion,
				resources: [],
				versions: { uiux: packageJson.version },
			},
			artifactRefs: [],
			data,
		}
		const validation = validateFormalEvidenceRecord(evidence)
		if (!validation.ok) return { status: 'invalid', diagnostics: validation.diagnostics }
		const { identity: evidenceDigest } = await persistence.artifacts.put(canonicalJsonBytes(evidence))
		return { status: 'recorded', evidenceDigest, evidence }
	}
	return { record }
}
