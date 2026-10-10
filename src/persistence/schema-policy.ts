import { validateWorkspaceManifest } from '../domain/workspace/schema'
import { isRecord } from '../domain/validation'

export type WorkspaceSnapshot = ReadonlyMap<string, Uint8Array>

/**
 * One step of the Workspace schema migration chain.
 *
 * Invariant: a step never reads across resources. It rewrites each resource from that resource's
 * own files plus the manifest (`.uiux/workspace.json`), never from another resource's files.
 * The version reads for Preview depend on it: when they upgrade an older version in memory they
 * leave out, whole, every unrelated resource whose content is no longer stored
 * (`src/application/services/history-preview.ts`). A future step that does read other resources
 * must make those resources required there too, or that upgrade silently changes its output.
 */
export type WorkspaceMigrationStep = Readonly<{
	fromVersion: number
	toVersion: number
	id: string
	/** Implementations must be deterministic and return the complete resulting canonical file set. */
	apply(snapshot: WorkspaceSnapshot): WorkspaceSnapshot | Promise<WorkspaceSnapshot>
}>

export type WorkspaceSchemaPolicy = Readonly<{
	currentVersion: number
	recognizedVersions: readonly number[]
	steps: readonly WorkspaceMigrationStep[]
}>

export type WorkspaceInspection =
	| Readonly<{ state: 'current'; version: number; targetVersion: number; diagnostics: readonly { code: string; path: string; message: string }[] }>
	| Readonly<{ state: 'migration_required'; version: number; targetVersion: number; migrationPlan: readonly WorkspaceMigrationStep[]; diagnostics: readonly { code: string; path: string; message: string }[] }>
	| Readonly<{ state: 'unsupported'; version?: number; targetVersion: number; diagnostics: readonly { code: string; path: string; message: string }[] }>
	| Readonly<{ state: 'missing_manifest'; targetVersion: number; diagnostics: readonly { code: string; path: string; message: string }[] }>

export function defineWorkspaceSchemaPolicy(policy: WorkspaceSchemaPolicy): WorkspaceSchemaPolicy {
	if (!Number.isInteger(policy.currentVersion) || policy.currentVersion < 1)
		throw new TypeError('Workspace policy currentVersion must be a positive integer supplied by the product schema registry.')
	const recognized = new Set(policy.recognizedVersions)
	if (!recognized.has(policy.currentVersion))
		throw new TypeError('Workspace policy must recognize its currentVersion.')
	if ([...recognized].some(version => !Number.isInteger(version) || version < 1))
		throw new TypeError('Workspace policy recognizedVersions must contain positive integers.')
	const ids = new Set<string>()
	const edges = new Set<string>()
	for (const step of policy.steps) {
		if (!step.id || ids.has(step.id))
			throw new TypeError('Workspace migration step ids must be non-empty and unique.')
		if (!recognized.has(step.fromVersion) || !recognized.has(step.toVersion) || step.toVersion <= step.fromVersion)
			throw new TypeError(`Workspace migration step ${step.id} must connect recognized versions in ascending order.`)
		const edge = `${step.fromVersion}->${step.toVersion}`
		if (edges.has(edge))
			throw new TypeError(`Workspace migration policy has duplicate edge ${edge}.`)
		ids.add(step.id)
		edges.add(edge)
	}
	for (const version of recognized) {
		if (version < policy.currentVersion && !findMigrationPlan(policy, version))
			throw new TypeError(`Workspace policy has no deterministic migration plan from recognized version ${version} to currentVersion.`)
	}
	return Object.freeze({
		currentVersion: policy.currentVersion,
		recognizedVersions: Object.freeze([...recognized].sort((a, b) => a - b)),
		steps: Object.freeze([...policy.steps]),
	})
}

export function findMigrationPlan(policy: WorkspaceSchemaPolicy, fromVersion: number): readonly WorkspaceMigrationStep[] | undefined {
	if (fromVersion === policy.currentVersion)
		return []
	const queue: { version: number; plan: WorkspaceMigrationStep[] }[] = [{ version: fromVersion, plan: [] }]
	const shortest: WorkspaceMigrationStep[][] = []
	let shortestLength = Number.POSITIVE_INFINITY
	while (queue.length > 0) {
		const candidate = queue.shift()!
		if (candidate.plan.length >= shortestLength)
			continue
		for (const step of policy.steps.filter(item => item.fromVersion === candidate.version)) {
			const plan = [...candidate.plan, step]
			if (step.toVersion === policy.currentVersion) {
				shortestLength = plan.length
				shortest.push(plan)
			}
			else {
				queue.push({ version: step.toVersion, plan })
			}
		}
	}
	if (shortest.length === 0)
		return undefined
	if (shortest.length > 1)
		throw new TypeError(`Workspace policy has ambiguous shortest migration plans from version ${fromVersion}.`)
	return shortest[0]
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
	if (!policy.recognizedVersions.includes(version)) {
		return {
			state: 'unsupported',
			version,
			targetVersion: policy.currentVersion,
			diagnostics: [...validation.diagnostics, { code: 'workspace.schema_unsupported', path: '/schemaVersion', message: 'Workspace schemaVersion is unknown or newer than this policy supports.' }],
		}
	}
	const migrationPlan = findMigrationPlan(policy, version)
	if (!migrationPlan) {
		return {
			state: 'unsupported',
			version,
			targetVersion: policy.currentVersion,
			diagnostics: [...validation.diagnostics, { code: 'workspace.migration_unavailable', path: '/schemaVersion', message: 'Workspace schemaVersion is recognized but has no available migration plan.' }],
		}
	}
	return { state: 'migration_required', version, targetVersion: policy.currentVersion, migrationPlan, diagnostics: validation.diagnostics }
}
