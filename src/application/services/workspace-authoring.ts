import type { ResourceRevision } from '../dto/revisions'
import { validateResourceRevision } from '../dto/revisions'
import type { Diagnostic } from '../../domain/validation'
import {
	validateWorkspaceManifest,
	type ThemeEntry,
	type ViewportPreset,
	type WorkspaceAdapterSelection,
	type WorkspaceManifest,
} from '../../domain/workspace/schema'
import type { FileNativePersistence } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'

export type WorkspaceSettingsUpdate = Readonly<{
	i18n: Readonly<{ defaultLocale: string; [key: string]: unknown }>
	adapters: readonly WorkspaceAdapterSelection[]
	viewports: Readonly<Record<string, ViewportPreset>>
	themes: Readonly<Record<string, ThemeEntry>>
}>

export type UpdateWorkspaceSettingsCommand = Readonly<{
	expectedRevision: string
	settings: WorkspaceSettingsUpdate
}>

export type WorkspaceAuthoringResult =
	| Readonly<{ status: 'updated'; key: 'workspace'; revision: ResourceRevision; diagnostics: readonly Diagnostic[] }>
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

export function createWorkspaceAuthoringService(persistence: FileNativePersistence): WorkspaceAuthoringService {
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
					: [{ code: 'workspace.migration_required', path: '/schemaVersion', message: 'Workspace requires migration before settings can be updated.' }],
			}
		}

		const next: WorkspaceManifest = {
			schemaVersion: current.resource.schemaVersion,
			i18n: { ...command.settings.i18n, defaultLocale: command.settings.i18n.defaultLocale },
			adapters: [...command.settings.adapters],
			viewports: command.settings.viewports,
			themes: command.settings.themes,
		}

		const validation = validateWorkspaceManifest(next)
		if (!validation.ok)
			return { status: 'invalid', key: 'workspace', diagnostics: validation.diagnostics }

		const refused = guard?.({ current: current.resource, next })
		if (refused !== undefined) return refused

		try {
			const commit = await persistence.workspace.compareAndSwap({
				key: 'workspace',
				expectedRevision: expectedRevision.value,
				resource: next,
			})
			if (!commit.ok)
				return { status: 'conflict', key: 'workspace', currentRevision: commit.conflict.currentRevision }
			const inspected = await persistence.workspace.readInspected()
			return { status: 'updated', key: 'workspace', revision: commit.revision, diagnostics: inspected.diagnostics }
		}
		catch (error) {
			if (error instanceof PersistenceError) {
				if (error.code === 'workspace.migration_required')
					return { status: 'blocked', key: 'workspace', diagnostics: error.diagnostics }
				if (error.code === 'workspace.schema_unsupported')
					return { status: 'invalid', key: 'workspace', diagnostics: [{ code: 'workspace.schema_unsupported', path: '/schemaVersion', message: error.message }] }
			}
			throw error
		}
	}

	return { updateWorkspaceSettings }
}
