import { defineEventHandler, getQuery } from 'h3'
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
	return { items, ...productKitFreshnessContext(await session.productKitProvenance()) }
})
