import { createError, defineEventHandler, getQuery } from 'h3'
import { adapterFreshnessContext } from '../../../src/domain/evidence/adapter-provenance'
import { CHECKS_RUN_KIND } from '../../../src/domain/evidence/checks-run'
import { INTERACTION_REPLAY_KIND } from '../../../src/domain/evidence/interaction-replay'
import { FLOW_TRACE_KIND } from '../../../src/domain/evidence/schema'
import { productKitFreshnessContext } from '../../../src/domain/product-kit/provenance'
import { denyUnlessAllowed } from '../../../src/server/access/http'
import { requestSession } from '../../../src/server/request-session'

/** The kinds besides `formal_capture` a Review submission may cite from the Workbench picker (Rule 01a11544-55b0-…). */
const LISTABLE_KINDS: readonly string[] = [CHECKS_RUN_KIND, FLOW_TRACE_KIND, INTERACTION_REPLAY_KIND]

export default defineEventHandler(async (event) => {
	// `workspace.read`: refused with 403 before the Evidence or the kit is read.
	const denied = denyUnlessAllowed(event, 'listEvidence')
	if (denied) return denied
	const query = getQuery(event)
	const viewId = typeof query.viewId === 'string' && query.viewId ? query.viewId : undefined
	const session = requestSession(event)
	// `?kinds=checks_run,flow_trace,interaction_replay`: those Evidence records alone, read as the picker of
	// "Submit for review" lists them (a point-in-time record is shown with what it recorded, never judged
	// here). Without it the list is the formal captures and what their freshness is judged against.
	if (query.kinds !== undefined) {
		// A repeated `kinds` (an array) is refused, not read as its first value or ignored.
		if (typeof query.kinds !== 'string') throw createError({ statusCode: 400, statusMessage: 'The Evidence kinds to list are one comma-separated kinds value.' })
		const kinds = [...new Set(query.kinds.split(',').filter(Boolean))]
		const unknown = kinds.filter(kind => !LISTABLE_KINDS.includes(kind))
		if (kinds.length === 0 || unknown.length > 0)
			throw createError({ statusCode: 400, statusMessage: `The Evidence kinds to list are among ${LISTABLE_KINDS.join(', ')}.` })
		// `flows`: each Flow's current Flow input digest, which a listed `flow_trace` is judged by (Rule 01a1814f-8256-…).
		return { items: await session.listEvidence(viewId, kinds), flows: await session.flowInputs() }
	}
	const items = await session.listEvidence(viewId)
	// The current Product Kit provenance, so the Workbench judges each capture's freshness against it
	// (Rules 01a11bb1-be4a-… and 01a1161b-ff68-…): `productKit`, or `productKitUnavailable` when the
	// Product Kit provenance cannot be computed.
	// The kit digests are cached and shared by concurrent requests.
	// `views`: each View's current render-input digest, with the revision it was read at, so the
	// Workbench judges the View condition by the digest, not the revision (Rule 01a115cd-c5a5-…).
	const views = await session.viewRenderInputs()
	// `flows`: each Flow's current Flow input digest, which a `flow_trace` is judged by (Rule 01a1814f-8256-…).
	const flows = await session.flowInputs()
	// The current Adapter provenance, likewise (Rules 01a115cd-c6de-… and 01a1161b-ff68-…): `adapters`,
	// every Adapter of the active set in Adapter-list order, or `adaptersUnavailable` when it cannot be computed.
	const [productKit, adapters] = await Promise.all([session.productKitProvenance(), session.adapterProvenance()])
	return { items, views, flows, ...productKitFreshnessContext(productKit), ...adapterFreshnessContext(adapters) }
})
