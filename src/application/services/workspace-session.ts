import type { FlowResource } from '../../domain/flows/schema'
import type { I18nResource } from '../../domain/i18n/schema'
import type { ViewResource } from '../../domain/views/schema'
import type { WorkspaceManifest } from '../../domain/workspace/schema'
import type { FileNativePersistence, WorkspaceInspection } from '../../persistence'
import type { Diagnostic } from '../../domain/validation'
import type { ResourceRevision } from '../dto/revisions'
import { isValidPointResourceAddress, type PointResourceKind } from '../dto/point-resources'

export type PointResourceRead =
	| Readonly<{ kind: 'workspace'; key: 'workspace'; resource: WorkspaceManifest; revision: ResourceRevision; diagnostics: readonly Diagnostic[]; inspection: WorkspaceInspection }>
	| Readonly<{ kind: 'view'; key: string; resource: ViewResource; revision: ResourceRevision; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ kind: 'flow'; key: string; resource: FlowResource; revision: ResourceRevision; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ kind: 'locale'; key: string; resource: I18nResource; revision: ResourceRevision; diagnostics: readonly Diagnostic[] }>

export interface WorkspaceApplicationSession {
	readPointResource(kind: PointResourceKind, key: string): Promise<PointResourceRead | undefined>
}

/**
 * Application-facing selected-Workspace facade shared by HTTP/MCP/Workbench.
 * Transports never reach into FileNativePersistence directly.
 */
export function createWorkspaceApplicationSession(persistence: FileNativePersistence): WorkspaceApplicationSession {
	return {
		async readPointResource(kind, key) {
			if (!isValidPointResourceAddress({ kind, key })) return undefined
			switch (kind) {
				case 'workspace': {
					if (key !== 'workspace') return undefined
					const read = await persistence.workspace.readInspected()
					if (!read.resource || !read.revision) return undefined
					return { kind, key, resource: read.resource, revision: read.revision, diagnostics: read.diagnostics, inspection: read.inspection }
				}
				case 'view': {
					const read = await persistence.views.readInspected(key)
					return read && { kind, key, resource: read.resource, revision: read.revision, diagnostics: read.diagnostics }
				}
				case 'flow': {
					const read = await persistence.flows.readInspected(key)
					return read && { kind, key, resource: read.resource, revision: read.revision, diagnostics: read.diagnostics }
				}
				case 'locale': {
					const read = await persistence.locales.readInspected(key)
					return read && { kind, key, resource: read.resource, revision: read.revision, diagnostics: read.diagnostics }
				}
			}
		},
	}
}
