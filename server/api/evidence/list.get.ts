import { defineEventHandler, getQuery } from 'h3'
import { requestSession } from '../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const query = getQuery(event)
	const viewId = typeof query.viewId === 'string' && query.viewId ? query.viewId : undefined
	const session = requestSession(event)
	const items = await session.listEvidence(viewId)
	// The current Product Kit provenance, so the Workbench judges each capture's freshness against it
	// (Rules 01a11bb1-be4a-… and 01a1161b-ff68-…); absent below schemaVersion 5.
	const productKit = await session.productKitProvenance()
	return { items, ...(productKit ? { productKit } : {}) }
})
