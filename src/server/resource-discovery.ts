import type { ResourceDiscoveryPage } from '../application/dto/resource-discovery'
import type { WorkspaceApplicationSession } from '../application/services/workspace-session'
import type { Diagnostic } from '../domain/validation'

export type ResourceDiscoveryHttpResult =
	| Readonly<{ status: 200; body: ResourceDiscoveryPage }>
	| Readonly<{ status: 400; body: { code: 'invalid_discovery_request'; diagnostics: readonly Diagnostic[] } }>

export async function listResourcesForHttp(app: Pick<WorkspaceApplicationSession, 'listPointResources'>, input: unknown): Promise<ResourceDiscoveryHttpResult> {
	return mapOutcome(await app.listPointResources(input))
}

export async function searchResourcesForHttp(app: Pick<WorkspaceApplicationSession, 'searchPointResources'>, input: unknown): Promise<ResourceDiscoveryHttpResult> {
	return mapOutcome(await app.searchPointResources(input))
}

function mapOutcome(outcome: Awaited<ReturnType<WorkspaceApplicationSession['listPointResources']>>): ResourceDiscoveryHttpResult {
	return outcome.status === 'ok'
		? { status: 200, body: outcome.page }
		: { status: 400, body: { code: 'invalid_discovery_request', diagnostics: outcome.diagnostics } }
}
