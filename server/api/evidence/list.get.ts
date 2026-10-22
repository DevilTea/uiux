import { defineEventHandler, getQuery } from 'h3'
import { adapterFreshnessContext } from '../../../src/domain/evidence/adapter-provenance'
import { productKitFreshnessContext } from '../../../src/domain/product-kit/provenance'
import { denyUnlessAllowed } from '../../../src/server/access/http'
import { requestSession } from '../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	// `workspace.read`: refused with 403 before the Evidence or the kit is read.
	const denied = denyUnlessAllowed(event, 'listEvidence')
	if (denied) return denied
	const query = getQuery(event)
	const viewId = typeof query.viewId === 'string' && query.viewId ? query.viewId : undefined
	const session = requestSession(event)
	const items = await session.listEvidence(viewId)
	// The current Product Kit provenance, so the Workbench judges each capture's freshness against it
	// (Rules 01a11bb1-be4a-… and 01a1161b-ff68-…): `productKit`, or `productKitUnavailable` when the
	// Product Kit provenance cannot be computed.
	// The kit digests are cached and shared by concurrent requests.
	// `views`: each View's current render-input digest, with the revision it was read at, so the
	// Workbench judges the View condition by the digest, not the revision (Rule 01a115cd-c5a5-…).
	const views = await session.viewRenderInputs()
	// The current Adapter provenance, likewise (Rules 01a115cd-c6de-… and 01a1161b-ff68-…): `adapters`,
	// every Adapter of the active set in Adapter-list order, or `adaptersUnavailable` when it cannot be computed.
	const [productKit, adapters] = await Promise.all([session.productKitProvenance(), session.adapterProvenance()])
	return { items, views, ...productKitFreshnessContext(productKit), ...adapterFreshnessContext(adapters) }
})
