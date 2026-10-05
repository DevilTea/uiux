import { describe, expect, it } from 'vitest'
import { describeFetchError, formatFetchError } from '../app/utils/fetch-error'

function fetchError(statusCode: number, data: unknown, message = `[POST] "/api/evidence/capture": ${statusCode} Unprocessable Entity`) {
	return Object.assign(new Error(message), { statusCode, status: statusCode, data })
}

describe('describeFetchError', () => {
	it('extracts per-context capture failures instead of the transport string', () => {
		const details = describeFetchError(fetchError(422, {
			status: 'failed',
			results: [{
				status: 'failed',
				error: 'Playwright Chromium is not installed.',
				diagnostics: [{ code: 'evidence.capture_failed', path: '/contexts/0', message: 'Capture could not start.' }],
			}],
			summary: { total: 1, captured: 0, failed: 1 },
		}), 'Capture failed')
		expect(details.message).toBe('Capture could not start.')
		expect(details.statusCode).toBe(422)
		expect(details.status).toBe('failed')
		expect(details.diagnostics.map(item => item.message)).toEqual([
			'Capture could not start.',
			'Playwright Chromium is not installed.',
		])
		expect(details.message).not.toContain('[POST]')
	})

	it('prefers the server body message and keeps structural diagnostics', () => {
		const details = describeFetchError(fetchError(400, {
			status: 'invalid',
			message: 'Request payload failed structural validation.',
			diagnostics: [{ code: 'transport.malformed_payload', path: '/name', message: 'Required' }],
		}, '[PUT] "/api/flows/x": 400 Bad Request'), 'Save failed')
		expect(details.message).toBe('Request payload failed structural validation.')
		expect(formatFetchError(fetchError(400, {
			message: 'Request payload failed structural validation.',
			diagnostics: [{ message: 'Required' }],
		}), 'Save failed')).toBe('Request payload failed structural validation. Required')
	})

	it('falls back to the provided message for bare transport failures', () => {
		expect(describeFetchError(fetchError(500, undefined, '[GET] "/api/x": 500 Internal Server Error'), 'Load failed').message).toBe('Load failed')
		expect(describeFetchError(new TypeError('Failed to fetch'), 'Load failed').message).toBe('Load failed')
		expect(describeFetchError('nope', 'Load failed').message).toBe('Load failed')
	})

	it('keeps meaningful non-transport error messages', () => {
		expect(describeFetchError(new Error('Selected View is unavailable.'), 'Load failed').message).toBe('Selected View is unavailable.')
	})
})
