import { isValidPointResourceAddress, type PointResourceAddress as UiuxResourceAddress } from '../application/dto/point-resources'

export function pointResourceUri(address: UiuxResourceAddress): string {
	if (address.kind === 'workspace') {
		if (address.key !== 'workspace') throw new TypeError('Workspace point resource key must be "workspace".')
		return 'uiux://workspace'
	}
	if (!isValidPointResourceAddress(address)) throw new TypeError(`Invalid ${address.kind} point resource key.`)
	return `uiux://${address.kind}/${encodeURIComponent(address.key)}`
}

export function parsePointResourceUri(input: string | URL): UiuxResourceAddress | undefined {
	let url: URL
	try { url = input instanceof URL ? input : new URL(input) }
	catch { return undefined }
	if (url.protocol !== 'uiux:' || url.username || url.password || url.port || url.search || url.hash) return undefined
	if (url.hostname === 'workspace')
		return url.pathname === '' || url.pathname === '/' ? { kind: 'workspace', key: 'workspace' } : undefined
	if (url.hostname !== 'view' && url.hostname !== 'flow' && url.hostname !== 'locale' && url.hostname !== 'review' && url.hostname !== 'asset') return undefined
	if (!url.pathname.startsWith('/') || url.pathname.slice(1).includes('/')) return undefined
	try {
		const key = decodeURIComponent(url.pathname.slice(1))
		const address: UiuxResourceAddress = { kind: url.hostname, key }
		return isValidPointResourceAddress(address) ? address : undefined
	}
	catch { return undefined }
}

/** The kit project file Resource template (Clause 01a11bb1-b0f1-7e5d-85ad-230c43ad99fb). */
export const KIT_FILE_RESOURCE_TEMPLATE = 'uiux://product-kit/file/{path}'

/**
 * The URI of the kit project file `path` (relative to `kit/`): the template's `{path}` in RFC 6570
 * simple expansion, so each `/` is `%2F`, as the template's variable matches one URI segment.
 */
export function kitFileResourceUri(path: string): string {
	return `uiux://product-kit/file/${encodeURIComponent(path)}`
}
