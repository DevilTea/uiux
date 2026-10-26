import type { ScopedWorkspaceSession } from '../application/access/scoped-session'
import type { CaptureInteractionEvidenceCommand } from '../application/services/interaction-evidence'
import { isRecord } from '../domain/validation'

type InteractionHttpResult<Body> = Readonly<{ status: number; body: Body }>

/**
 * Clause 01a17762-b85b-77d6-a399-e26843475501: `POST /api/evidence/interactions`, the same result as
 * `capture_interaction_evidence`. The body members are handed to the service as they are; it refuses
 * what does not meet the Clauses.
 */
export async function captureInteractionEvidenceForHttp(
	app: Pick<ScopedWorkspaceSession, 'captureInteractionEvidence'>,
	body: unknown,
): Promise<InteractionHttpResult<Awaited<ReturnType<ScopedWorkspaceSession['captureInteractionEvidence']>>>> {
	const input = isRecord(body) ? body : {}
	const result = await app.captureInteractionEvidence({
		viewId: input.viewId as string,
		...(input.variant !== undefined ? { variant: input.variant as string } : {}),
		renderContext: input.renderContext as CaptureInteractionEvidenceCommand['renderContext'],
		steps: input.steps as CaptureInteractionEvidenceCommand['steps'],
		assertions: input.assertions as CaptureInteractionEvidenceCommand['assertions'],
	})
	switch (result.status) {
		case 'captured': return { status: 200, body: result }
		case 'not_found': return { status: 404, body: result }
		case 'blocked': return { status: 403, body: result }
		default: return { status: 422, body: result }
	}
}
