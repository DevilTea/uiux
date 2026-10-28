import type { ResourceRevision } from '../dto/revisions'
import { summarizeChange, type ChangeSummary } from '../dto/change-summary'
import { analyzeImpact, withResource, type ImpactItem } from '../../domain/impact'
import { nextSingleFileRevision, readImpactWorkspace } from './impact-picture'
import { validateResourceRevision } from '../dto/revisions'
import type { Diagnostic } from '../../domain/validation'
import { trimRequirementsSetting, REQUIREMENT_DIAGNOSTIC_CODES, type RequirementsSetting } from '../../domain/requirements/schema'
import { noUiDiagnostics, providerUnavailableDiagnostic, readRequirementsProvider, resolveSpecProviderRoot, type RequirementsProviderOptions } from './requirements-provider'
import {
	validateWorkspaceManifest,
	type ThemeEntry,
	type ViewportPreset,
	type WorkspaceManifest,
} from '../../domain/workspace/schema'
import type { FileNativePersistence } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'

export type WorkspaceSettingsUpdate = Readonly<{
	i18n: Readonly<{ defaultLocale: string; [key: string]: unknown }>
	viewports: Readonly<Record<string, ViewportPreset>>
	themes: Readonly<Record<string, ThemeEntry>>
	/**
	 * The requirements setting (Clause 01a18120-f49d-…): a given one replaces the whole setting, `null`
	 * removes it and an omitted one keeps it (Clause 01a11485-f769-…).
	 */
	requirements?: RequirementsSetting | null
}>

export type UpdateWorkspaceSettingsCommand = Readonly<{
	expectedRevision: string
	settings: WorkspaceSettingsUpdate
	/** Acknowledges the impact of removing or renaming a viewport or theme key (Clause 01a172ce-bdef-7cf6-bf8c-770dc9dd5e34). */
	acknowledgeImpact?: boolean
}>

export type WorkspaceAuthoringResult =
	| Readonly<{ status: 'updated'; key: 'workspace'; revision: ResourceRevision; diagnostics: readonly Diagnostic[]; changeSummary: ChangeSummary; impacts?: readonly ImpactItem[] }>
	| Readonly<{ status: 'impact_acknowledgement_required'; key: 'workspace'; impacts: readonly ImpactItem[] }>
	| Readonly<{ status: 'not_found'; key: 'workspace' }>
	| Readonly<{ status: 'conflict'; key: 'workspace'; currentRevision: ResourceRevision }>
	| Readonly<{ status: 'invalid_expected_revision'; key: 'workspace'; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'invalid'; key: 'workspace'; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'blocked'; key: 'workspace'; diagnostics: readonly Diagnostic[] }>

/**
 * A caller's check of a settings change against the manifest it replaces, such as an
 * authorization that depends on what changes. It runs after the revision check, on the manifest at
 * `expectedRevision`, which the compare-and-swap then requires, so the change it allows is exactly
 * the change written. A returned refusal is answered as is and nothing is written.
 */
export type WorkspaceSettingsGuard<R> = (change: Readonly<{ current: WorkspaceManifest; next: WorkspaceManifest }>) => R | undefined

export type WorkspaceAuthoringService = Readonly<{
	updateWorkspaceSettings<R = never>(command: UpdateWorkspaceSettingsCommand, guard?: WorkspaceSettingsGuard<R>): Promise<WorkspaceAuthoringResult | R>
}>

export function createWorkspaceAuthoringService(persistence: FileNativePersistence, requirementsOptions: RequirementsProviderOptions = {}): WorkspaceAuthoringService {
	async function updateWorkspaceSettings<R = never>(command: UpdateWorkspaceSettingsCommand, guard?: WorkspaceSettingsGuard<R>): Promise<WorkspaceAuthoringResult | R> {
		const expectedRevision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: 'workspace', diagnostics: expectedRevision.diagnostics }

		const current = await persistence.workspace.readInspected()
		if (!current.resource || !current.revision)
			return { status: 'not_found', key: 'workspace' }
		if (current.revision !== expectedRevision.value)
			return { status: 'conflict', key: 'workspace', currentRevision: current.revision }

		if (current.inspection.state !== 'current') {
			return {
				status: 'blocked',
				key: 'workspace',
				diagnostics: current.diagnostics.length > 0
					? current.diagnostics
					: [{ code: 'workspace.schema_unsupported', path: '/schemaVersion', message: 'Workspace settings cannot be updated for an unsupported Workspace schema.' }],
			}
		}

		// Clause 01a18120-f52d-…: a write trims the `noUi` IDs and reasons before checking.
		const requirements = command.settings.requirements === undefined ? current.resource.requirements : command.settings.requirements === null ? undefined : trimRequirementsSetting(command.settings.requirements)
		const next: WorkspaceManifest = {
			schemaVersion: current.resource.schemaVersion,
			i18n: { ...command.settings.i18n, defaultLocale: command.settings.i18n.defaultLocale },
			viewports: command.settings.viewports,
			themes: command.settings.themes,
			...(requirements === undefined ? {} : { requirements }),
		}

		const validation = validateWorkspaceManifest(next)
		if (!validation.ok)
			return { status: 'invalid', key: 'workspace', diagnostics: validation.diagnostics }
		// Clause 01a18120-f49d-…: a `spec` provider's real path lies inside the Git work tree that holds the Workspace root.
		if (command.settings.requirements?.provider === 'spec') {
			const resolved = await resolveSpecProviderRoot(persistence.root, command.settings.requirements, requirementsOptions)
			if (!resolved.ok)
				return { status: 'invalid', key: 'workspace', diagnostics: [{ code: REQUIREMENT_DIAGNOSTIC_CODES.providerInvalid, path: '/requirements/path', message: resolved.reason }] }
		}

		const refused = guard?.({ current: current.resource, next })
		if (refused !== undefined) return refused

		// Rule 01a172ce-2e97-7d83-b175-f0d15f846768: removing or renaming a viewport or theme key needs
		// the caller to acknowledge the impact a restore of the settings would list.
		let impacts: readonly ImpactItem[] = []
		if (removesRenderKey(current.resource, next)) {
			const before = await readImpactWorkspace(persistence, { evidence: true })
			impacts = analyzeImpact(before, withResource(before, { kind: 'workspace', key: 'workspace' }, next, nextSingleFileRevision('workspace', next)))
			if (impacts.length > 0 && command.acknowledgeImpact !== true)
				return { status: 'impact_acknowledgement_required', key: 'workspace', impacts }
		}

		try {
			const commit = await persistence.workspace.compareAndSwap({
				key: 'workspace',
				expectedRevision: expectedRevision.value,
				resource: next,
			})
			if (!commit.ok)
				return { status: 'conflict', key: 'workspace', currentRevision: commit.conflict.currentRevision }
			const inspected = await persistence.workspace.readInspected()
			// Clause 01a18120-f5b9-…: the result reports the IDs the provider lacks (or that it cannot be read) and keeps them.
			const provider = requirements === undefined ? undefined : await readRequirementsProvider(persistence.root, requirements, requirementsOptions)
			const requirementDiagnostics = !provider ? [] : provider.status === 'unavailable' ? [providerUnavailableDiagnostic(provider, '/requirements')] : noUiDiagnostics(provider)
			return { status: 'updated', key: 'workspace', revision: commit.revision, diagnostics: requirementDiagnostics.length > 0 ? [...inspected.diagnostics, ...requirementDiagnostics] : inspected.diagnostics, changeSummary: summarizeChange(current.resource, next), ...(impacts.length > 0 ? { impacts } : {}) }
		}
		catch (error) {
			if (error instanceof PersistenceError) {
				if (error.code === 'workspace.schema_unsupported')
					return { status: 'invalid', key: 'workspace', diagnostics: [{ code: 'workspace.schema_unsupported', path: '/schemaVersion', message: error.message }] }
			}
			throw error
		}
	}

	return { updateWorkspaceSettings }
}

/** Whether the change drops a viewport or theme key the manifest has now (a rename drops the old key). */
function removesRenderKey(current: WorkspaceManifest, next: WorkspaceManifest): boolean {
	const dropped = (was: Readonly<Record<string, unknown>> | undefined, now: Readonly<Record<string, unknown>> | undefined) => Object.keys(was ?? {}).some(key => !Object.hasOwn(now ?? {}, key))
	return dropped(current.viewports, next.viewports) || dropped(current.themes, next.themes)
}
