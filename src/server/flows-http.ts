import type { ScopedWorkspaceSession } from '../application/access/scoped-session'
import type { FlowRenderContext } from '../application/services/flow-evidence'
import type { ValidateFlowResult } from '../application/services/workspace-session'
import { isFullUuid, isRecord } from '../domain/validation'

type FlowHttpResult<Body> = Readonly<{ status: number; body: Body }>

/** Clause 01a172cc-de18-79ea-a611-c8ea5a34e250: `POST /api/flows/:id/validate`, the same result as `validate_flow`. */
export async function validateFlowForHttp(app: Pick<ScopedWorkspaceSession, 'validateFlow'>, flowId: string): Promise<FlowHttpResult<ValidateFlowResult>> {
	if (!isFullUuid(flowId)) return { status: 404, body: { status: 'not_found', flowId } }
	const result = await app.validateFlow(flowId)
	return { status: 'status' in result ? 404 : 200, body: result }
}

/** Clause 01a172cc-e195-711b-bfa9-5de6c1c8ff87: `POST /api/flows/:id/evidence`, the same result as `capture_flow_evidence`. */
export async function captureFlowEvidenceForHttp(app: Pick<ScopedWorkspaceSession, 'captureFlowEvidence'>, flowId: string, body: unknown): Promise<FlowHttpResult<Awaited<ReturnType<ScopedWorkspaceSession['captureFlowEvidence']>>>> {
	const input = isRecord(body) ? body : {}
	const result = await app.captureFlowEvidence({
		flowId,
		renderContext: input.renderContext as FlowRenderContext,
		...(input.recipe !== undefined ? { recipe: input.recipe } : {}),
	})
	switch (result.status) {
		case 'captured': return { status: 200, body: result }
		case 'not_found': return { status: 404, body: result }
		case 'blocked': return { status: 403, body: result }
		default: return { status: 422, body: result }
	}
}
