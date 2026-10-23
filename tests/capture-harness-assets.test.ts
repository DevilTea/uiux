import { EventEmitter } from 'node:events'
import type { Page } from 'playwright'
import { describe, expect, it } from 'vitest'

import { isBoundAssetPath, trackBoundAssetFailures } from '../src/application/services/capture-harness'

/**
 * The network watch of the capture harness (issue #323): any failed request for a bound Asset's URL,
 * in either form of Clause 01a167f4-401d-7330-ac65-0a900adbccd6, fails the capture.
 */

const BASE = 'http://127.0.0.1:4000'
const DIGEST = `sha256:${'a'.repeat(64)}`

function watch() {
	const page = new EventEmitter()
	const failures = trackBoundAssetFailures(page as unknown as Page, BASE)
	const respond = (url: string, status: number) => page.emit('response', { url: () => url, status: () => status, ok: () => status >= 200 && status < 300 })
	const fail = (url: string, errorText: string) => page.emit('requestfailed', { url: () => url, failure: () => ({ errorText }) })
	return { failures, respond, fail }
}

describe('bound Asset network watch', () => {
	it('knows both URL forms', () => {
		expect(isBoundAssetPath('/api/assets/abc/content')).toBe(true)
		expect(isBoundAssetPath(`/api/history/blobs/${DIGEST}`)).toBe(true)
		expect(isBoundAssetPath('/api/assets/abc')).toBe(false)
		expect(isBoundAssetPath('/api/preview/assets')).toBe(false)
	})

	it('counts a non-2xx answer in either form, and a failed request', () => {
		const { failures, respond, fail } = watch()
		respond(`${BASE}/api/assets/abc/content?digest=${DIGEST}`, 409)
		respond(`${BASE}/api/history/blobs/${DIGEST}`, 404)
		fail(`${BASE}/api/assets/abc/content?digest=${DIGEST}`, 'net::ERR_CONNECTION_RESET')
		expect(failures()).toBe(3)
	})

	it('does not count 2xx, 304, a browser-aborted request, other URLs or other origins', () => {
		const { failures, respond, fail } = watch()
		respond(`${BASE}/api/assets/abc/content?digest=${DIGEST}`, 200)
		respond(`${BASE}/api/assets/abc/content?digest=${DIGEST}`, 304)
		fail(`${BASE}/api/assets/abc/content?digest=${DIGEST}`, 'net::ERR_ABORTED')
		respond(`${BASE}/api/views`, 500)
		respond('http://elsewhere.test/api/assets/abc/content', 404)
		expect(failures()).toBe(0)
	})
})
