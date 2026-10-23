import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	createPreviewFailure,
	deriveWorkbenchFailure,
	previewFailureCopyKeys,
	recorrelatePreviewFailure,
	RETRY_STALL_GRACE_MS,
	retryStallGraceMs,
	type FailureObservation,
} from '../src/preview/failure-diagnostic'
import {
	PREVIEW_FAILURE_CATEGORIES,
	PREVIEW_FAILURE_REASON_CODES,
	validatePreviewFailureDiagnostic,
} from '../src/preview/protocol/schema'

/**
 * Workbench-derived Preview failure diagnostics (issue #111): which bridge results fail Preview
 * with which reason, what each diagnostic carries (Clause 01a11687-415c-79d5-9978-62683f35e9e2),
 * and where its copy comes from (Rules 01a11687-37a0-77bb-a857-5f7804b7c306 and
 * 01a11687-37e4-76ef-8468-35e2e9d67a4d).
 */

type Catalog = { [key: string]: string | Catalog }
const catalog = (locale: string): Catalog => JSON.parse(readFileSync(join(import.meta.dirname, '..', 'app', 'i18n', 'locales', `${locale}.json`), 'utf8')) as Catalog
const lookup = (root: Catalog, key: string): unknown => key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Catalog)[part] : undefined), root)

const base = { previewSessionId: 'session-a', declaration: false, phase: 'initiating' } as const
const observe = (overrides: Partial<FailureObservation> & Pick<FailureObservation, 'result'>): FailureObservation => ({ ...base, ...overrides })

describe('Workbench-derived Preview failures', () => {
	it('keeps the reason of a capability failure, correlated with the session and the failed generation', () => {
		const derived = deriveWorkbenchFailure(observe({
			result: { status: 'capability-failure', reason: 'capability.unsupported_protocol_version' },
			declaration: true,
			envelopeGenerationId: 'generation-a',
		}))
		expect(derived).toEqual({ effect: 'fail', failure: {
			category: 'capability',
			reason: 'capability.unsupported_protocol_version',
			correlation: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a' },
		} })
	})

	it('reports a conflicting declaration as protocol.capability_conflict, even after the handshake opened', () => {
		const derived = deriveWorkbenchFailure(observe({ result: { status: 'capability-conflict' }, declaration: true, envelopeGenerationId: 'generation-a', phase: 'open' }))
		expect(derived).toMatchObject({ effect: 'fail', failure: { category: 'protocol', reason: 'protocol.capability_conflict', correlation: { runtimeGenerationId: 'generation-a' } } })
	})

	it('reports an undecodable message before the handshake opens as protocol.invalid_message, with the decoder codes as detail', () => {
		const result = { status: 'invalid', diagnostics: [
			{ code: 'protocol.invalid_protocol_version', path: '/payload/protocolVersion', message: 'x' },
			{ code: 'protocol.invalid_protocol_version', path: '/payload/features', message: 'y' },
		] } as const
		expect(deriveWorkbenchFailure(observe({ result, declaration: true }))).toEqual({ effect: 'fail', failure: {
			category: 'protocol',
			reason: 'protocol.invalid_message',
			detail: 'protocol.invalid_protocol_version',
			correlation: { previewSessionId: 'session-a' },
		} })
		// Once open, or once Preview already failed, an invalid message changes nothing here.
		expect(deriveWorkbenchFailure(observe({ result, phase: 'open' }))).toEqual({ effect: 'none' })
		expect(deriveWorkbenchFailure(observe({ result, phase: 'failed' }))).toEqual({ effect: 'none' })
	})

	it('reports a declaration naming a retired generation as identity reuse only while no generation is open', () => {
		const result = { status: 'stale-generation' } as const
		expect(deriveWorkbenchFailure(observe({ result, declaration: true, envelopeGenerationId: 'generation-a' })))
			.toMatchObject({ effect: 'fail', failure: { reason: 'protocol.identity_reuse', correlation: { runtimeGenerationId: 'generation-a' } } })
		// A stale declaration while a generation is open, or after Preview failed, is discarded without a code.
		expect(deriveWorkbenchFailure(observe({ result, declaration: true, envelopeGenerationId: 'generation-a', phase: 'open' }))).toEqual({ effect: 'none' })
		expect(deriveWorkbenchFailure(observe({ result, declaration: true, envelopeGenerationId: 'generation-a', phase: 'failed' }))).toEqual({ effect: 'none' })
		// Other stale traffic never fails Preview.
		expect(deriveWorkbenchFailure(observe({ result, envelopeGenerationId: 'generation-a' }))).toEqual({ effect: 'none' })
		expect(deriveWorkbenchFailure(observe({ result: { status: 'stale-session' }, declaration: true }))).toEqual({ effect: 'none' })
	})

	it('shows the failure that exhausted recovery again under a refused generation', () => {
		expect(deriveWorkbenchFailure(observe({ result: { status: 'generation-refused', generationId: 'generation-c' }, declaration: true }))).toEqual({ effect: 'refused', generationId: 'generation-c' })
		const exhausting = createPreviewFailure('capability', 'capability.unsupported_protocol_version', 'session-a', 'generation-a')
		expect(recorrelatePreviewFailure(exhausting, 'session-a', 'generation-c')).toEqual({
			category: 'capability',
			reason: 'capability.unsupported_protocol_version',
			correlation: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-c' },
		})
	})

	it('derives nothing from accepted or gated traffic', () => {
		expect(deriveWorkbenchFailure(observe({ result: { status: 'gated' } }))).toEqual({ effect: 'none' })
		expect(deriveWorkbenchFailure(observe({ result: { status: 'wrong-direction' }, phase: 'open' }))).toEqual({ effect: 'none' })
	})

	it('writes only valid, display-safe diagnostics', () => {
		const derived = [
			createPreviewFailure('capability', 'capability.missing_required_feature', 'session-a', 'generation-a'),
			createPreviewFailure('protocol', 'protocol.invalid_message', 'session-a', undefined, `bad\u0000value ${'x'.repeat(600)}`),
		]
		for (const failure of derived) expect(validatePreviewFailureDiagnostic(failure)).toMatchObject({ ok: true })
		expect(derived[1]!.detail).not.toMatch(/\p{Cc}/u)
		expect(derived[1]!.detail!.length).toBeLessThanOrEqual(200)
	})
})

describe('Retry Preview stall grace', () => {
	it('uses the product default unless a test sets a positive override', () => {
		expect(retryStallGraceMs({})).toBe(RETRY_STALL_GRACE_MS)
		expect(retryStallGraceMs(undefined)).toBe(RETRY_STALL_GRACE_MS)
		expect(retryStallGraceMs({ __uiuxRetryStallGraceMs: 300 })).toBe(300)
		for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '300'])
			expect(retryStallGraceMs({ __uiuxRetryStallGraceMs: invalid })).toBe(RETRY_STALL_GRACE_MS)
	})
})

describe('Preview failure copy', () => {
	it('takes the title from the category and the body from a recognized reason', () => {
		expect(previewFailureCopyKeys({ category: 'capability', reason: 'capability.unsupported_protocol_version' })).toEqual({
			title: 'previewFailure.capability.title',
			body: 'previewFailure.reasons.capability.unsupported_protocol_version',
			recognized: true,
		})
	})

	it('falls back to the category body for an unknown reason, or one of another category', () => {
		expect(previewFailureCopyKeys({ category: 'runtime', reason: 'runtime.worker_lost' })).toEqual({ title: 'previewFailure.runtime.title', body: 'previewFailure.runtime.body', recognized: false })
		expect(previewFailureCopyKeys({ category: 'runtime', reason: 'protocol.invalid_message' }).recognized).toBe(false)
	})

	it.each(['en-US', 'zh-TW'])('has %s copy for every category and every registry reason', (locale) => {
		const root = catalog(locale)
		for (const category of PREVIEW_FAILURE_CATEGORIES) {
			expect(lookup(root, `previewFailure.${category}.title`), `${category} title`).toEqual(expect.any(String))
			expect(lookup(root, `previewFailure.${category}.body`), `${category} body`).toEqual(expect.any(String))
		}
		for (const reason of PREVIEW_FAILURE_REASON_CODES) {
			const keys = previewFailureCopyKeys({ category: reason.slice(0, reason.indexOf('.')) as never, reason })
			expect(keys.recognized).toBe(true)
			expect(lookup(root, keys.body), reason).toEqual(expect.any(String))
		}
		expect(lookup(root, 'previewFailure.retry')).toEqual(expect.any(String))
	})
})
