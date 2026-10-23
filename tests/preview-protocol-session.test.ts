import { describe, expect, it } from 'vitest'

import { createPreviewSessionId } from '../src/preview/protocol/generation-id'
import { PreviewProtocolSession, PreviewSessionRegistry } from '../src/preview/protocol/session'

const compatible = { ok: true } as const
const unsupported = { ok: false, reason: 'capability.unsupported_protocol_version' } as const

describe('Preview protocol session/generation lineage', () => {
	it('opens geometry traffic only after the matching generation observes ACK', () => {
		const session = new PreviewProtocolSession('session-a')
		expect(session.beginGeneration('generation-a', 'initial')).toMatchObject({ status: 'admitted' })
		expect(session.classifyGeometryTraffic('session-a', 'generation-a')).toBe('gated')
		expect(session.receiveCapabilityDeclaration('generation-a', { protocolVersion: 1, features: ['geometry'] }, compatible)).toEqual({ status: 'ack-required', generationId: 'generation-a' })
		expect(session.classifyGeometryTraffic('session-a', 'generation-a')).toBe('gated')
		expect(session.observeCapabilityAcknowledgement('generation-a')).toEqual({ status: 'opened', generationId: 'generation-a' })
		expect(session.classifyGeometryTraffic('session-a', 'generation-a')).toBe('open')
		expect(session.observeCapabilityAcknowledgement('generation-a')).toEqual({ status: 'already-open', generationId: 'generation-a' })
	})

	it('pins the first declaration before ACK, treats identical retransmission as idempotent, and rejects same-generation change', () => {
		const session = new PreviewProtocolSession('session-a')
		session.beginGeneration('generation-a', 'initial')
		const declaration = { features: ['geometry', 'contour'], protocolVersion: 1 }
		expect(session.receiveCapabilityDeclaration('generation-a', declaration, compatible).status).toBe('ack-required')
		declaration.features.push('mutated-after-send')
		expect(session.receiveCapabilityDeclaration('generation-a', { protocolVersion: 1, features: ['geometry', 'contour'] }, compatible).status).toBe('ack-required')
		expect(session.receiveCapabilityDeclaration('generation-a', { protocolVersion: 1, features: ['contour', 'geometry'] }, compatible).status).toBe('ack-required')
		expect(session.receiveCapabilityDeclaration('generation-a', { protocolVersion: 1, features: ['geometry'] }, compatible)).toEqual({ status: 'capability-conflict', generationId: 'generation-a' })
		const snapshot = session.snapshot()
		expect(snapshot).toMatchObject({ recoveryNeeded: true, recoveryExhausted: false })
		expect('currentGenerationId' in snapshot).toBe(false)
	})

	it('keeps an open gate open when an identical declaration is retransmitted and requires the same ACK again', () => {
		const session = new PreviewProtocolSession('session-a')
		session.beginGeneration('generation-a', 'initial')
		const declaration = { protocolVersion: 1, features: ['geometry'] }
		session.receiveCapabilityDeclaration('generation-a', declaration, compatible)
		session.observeCapabilityAcknowledgement('generation-a')

		expect(session.receiveCapabilityDeclaration('generation-a', declaration, compatible)).toEqual({ status: 'ack-required', generationId: 'generation-a' })
		expect(session.classifyGeometryTraffic('session-a', 'generation-a')).toBe('open')
		expect(session.observeCapabilityAcknowledgement('generation-a')).toEqual({ status: 'already-open', generationId: 'generation-a' })
	})

	it('keeps ACK/pending state unchanged across pure reconnect and requires a fresh generation after reload/restart', () => {
		const session = new PreviewProtocolSession('session-a')
		session.beginGeneration('generation-a', 'initial')
		session.receiveCapabilityDeclaration('generation-a', { protocolVersion: 1, features: [] }, compatible)
		session.onPureTransportReconnect()
		expect(session.snapshot().currentGenerationPhase).toBe('awaiting-ack')
		session.observeCapabilityAcknowledgement('generation-a')
		session.onPureTransportReconnect()
		expect(session.classifyGeometryTraffic('session-a', 'generation-a')).toBe('open')

		expect(session.replaceGenerationForLifecycle('generation-b', 'reload')).toMatchObject({ status: 'admitted' })
		expect(session.classifyGeometryTraffic('session-a', 'generation-a')).toBe('stale-generation')
		expect(session.classifyGeometryTraffic('session-a', 'generation-b')).toBe('gated')
		expect(session.beginGeneration('generation-a', 'restart')).toEqual({ status: 'identity_reuse', generationId: 'generation-a' })
	})

	it('discards late ACK/declaration traffic from retired or non-current generations without reviving them', () => {
		const session = new PreviewProtocolSession('session-a')
		session.beginGeneration('generation-a', 'initial')
		session.receiveCapabilityDeclaration('generation-a', { protocolVersion: 1, features: [] }, compatible)
		session.replaceGenerationForLifecycle('generation-b', 'restart')
		expect(session.observeCapabilityAcknowledgement('generation-a')).toEqual({ status: 'stale', generationId: 'generation-a' })
		expect(session.receiveCapabilityDeclaration('generation-a', { protocolVersion: 1, features: [] }, compatible)).toEqual({ status: 'stale', generationId: 'generation-a' })
		expect(session.snapshot().currentGenerationId).toBe('generation-b')
	})

	it('allows one automatic fresh-generation recovery after protocol-invalid handshake, then exhausts until explicit retry authorization', () => {
		const session = protocolInvalidSession()
		expect(session.snapshot()).toMatchObject({ recoveryNeeded: true, recoveryExhausted: false, automaticRecoveryUsed: false })

		expect(session.beginGeneration('generation-b', 'automatic-recovery')).toMatchObject({ status: 'admitted' })
		session.receiveCapabilityDeclaration('generation-b', { protocolVersion: 1, features: [] }, compatible)
		expect(session.receiveCapabilityDeclaration('generation-b', { protocolVersion: 2, features: [] }, compatible).status).toBe('capability-conflict')
		expect(session.snapshot()).toMatchObject({ recoveryNeeded: false, recoveryExhausted: true, automaticRecoveryUsed: true })

		expect(session.beginGeneration('generation-c', 'restart')).toEqual({ status: 'unauthorized', generationId: 'generation-c' })
		expect(session.snapshot().retiredGenerationIds).toContain('generation-c')
		expect(session.authorizeRetry()).toBe('authorized')
		expect(session.authorizeRetry()).toBe('coalesced')
		expect(session.beginGeneration('generation-d', 'explicit-retry')).toMatchObject({ status: 'admitted' })
		expect(session.authorizeRetry()).toBe('ignored-active-bootstrap')
		expect(session.receiveCapabilityDeclaration('generation-d', { protocolVersion: 1, features: [] }, compatible).status).toBe('ack-required')
		expect(session.observeCapabilityAcknowledgement('generation-d').status).toBe('opened')
		expect(session.snapshot()).toMatchObject({ recoveryExhausted: false, automaticRecoveryUsed: false, retryAuthorizationPending: false })
	})

	it('charges lifecycle replacement against the automatic recovery budget instead of bypassing it', () => {
		const session = protocolInvalidSession()

		expect(session.replaceGenerationForLifecycle('generation-b', 'reload')).toMatchObject({ status: 'admitted' })
		expect(session.snapshot()).toMatchObject({ automaticRecoveryUsed: true, recoveryNeeded: false })
		session.receiveCapabilityDeclaration('generation-b', { protocolVersion: 1, features: [] }, compatible)
		expect(session.receiveCapabilityDeclaration('generation-b', { protocolVersion: 2, features: [] }, compatible).status).toBe('capability-conflict')
		expect(session.snapshot()).toMatchObject({ recoveryExhausted: true, automaticRecoveryUsed: true })

		expect(session.replaceGenerationForLifecycle('generation-c', 'restart')).toEqual({ status: 'unauthorized', generationId: 'generation-c' })
		expect(session.snapshot().retiredGenerationIds).toContain('generation-c')
	})

	it('does not refund an admitted recovery attempt when reload/restart replaces it before ACK', () => {
		const automatic = protocolInvalidSession('session-auto')
		automatic.beginGeneration('generation-b', 'automatic-recovery')
		expect(automatic.replaceGenerationForLifecycle('generation-c', 'reload')).toEqual({ status: 'unauthorized', generationId: 'generation-c' })
		expect(automatic.snapshot()).toMatchObject({ recoveryExhausted: true, automaticRecoveryUsed: true })
		expect(automatic.snapshot().retiredGenerationIds).toEqual(expect.arrayContaining(['generation-b', 'generation-c']))

		const explicit = exhaustedSession()
		expect(explicit.authorizeRetry()).toBe('authorized')
		expect(explicit.beginGeneration('generation-c', 'explicit-retry').status).toBe('admitted')
		expect(explicit.replaceGenerationForLifecycle('generation-d', 'restart')).toEqual({ status: 'unauthorized', generationId: 'generation-d' })
		expect(explicit.snapshot()).toMatchObject({ recoveryExhausted: true, retryAuthorizationPending: false })
	})

	it('consumes explicit retry at bootstrap admission and returns to exhausted if that attempt fails', () => {
		const session = exhaustedSession()
		expect(session.authorizeRetry()).toBe('authorized')
		expect(session.beginGeneration('generation-c', 'explicit-retry')).toMatchObject({ status: 'admitted' })
		expect(session.snapshot().retryAuthorizationPending).toBe(false)
		expect(session.receiveCapabilityDeclaration('generation-c', { protocolVersion: 99, features: [] }, unsupported).status).toBe('capability-failure')
		expect(session.snapshot().recoveryExhausted).toBe(true)
		expect(session.beginGeneration('generation-d', 'automatic-recovery')).toEqual({ status: 'unauthorized', generationId: 'generation-d' })
	})

	it('resets the automatic recovery budget only after a recovery generation successfully observes ACK', () => {
		const session = protocolInvalidSession()
		session.beginGeneration('generation-b', 'automatic-recovery')
		expect(session.snapshot().automaticRecoveryUsed).toBe(true)
		session.receiveCapabilityDeclaration('generation-b', { protocolVersion: 1, features: [] }, compatible)
		expect(session.snapshot().automaticRecoveryUsed).toBe(true)
		expect(session.observeCapabilityAcknowledgement('generation-b').status).toBe('opened')
		expect(session.snapshot()).toMatchObject({ automaticRecoveryUsed: false, recoveryExhausted: false })

		session.replaceGenerationForLifecycle('generation-c', 'restart')
		session.receiveCapabilityDeclaration('generation-c', { protocolVersion: 1, features: [] }, compatible)
		session.receiveCapabilityDeclaration('generation-c', { protocolVersion: 2, features: [] }, compatible)
		expect(session.snapshot()).toMatchObject({ recoveryNeeded: true, automaticRecoveryUsed: false })
		expect(session.beginGeneration('generation-d', 'automatic-recovery').status).toBe('admitted')
	})

	it('does not spend automatic recovery on an incompatible capability declaration and requires explicit authorization', () => {
		const session = new PreviewProtocolSession('session-a')
		session.beginGeneration('generation-a', 'initial')
		expect(session.receiveCapabilityDeclaration('generation-a', { protocolVersion: 99, features: [] }, unsupported).status).toBe('capability-failure')
		expect(session.snapshot()).toMatchObject({
			recoveryNeeded: false,
			recoveryExhausted: true,
			automaticRecoveryUsed: false,
		})
		expect(session.beginGeneration('generation-b', 'automatic-recovery')).toEqual({ status: 'unauthorized', generationId: 'generation-b' })
		expect(session.authorizeRetry()).toBe('authorized')
	})

	it('supports retry revocation before admission and never accumulates retry credit', () => {
		const session = exhaustedSession()
		expect(session.authorizeRetry()).toBe('authorized')
		expect(session.authorizeRetry()).toBe('coalesced')
		expect(session.revokeRetry()).toBe('revoked')
		expect(session.revokeRetry()).toBe('none')
		expect(session.beginGeneration('generation-c', 'explicit-retry')).toEqual({ status: 'unauthorized', generationId: 'generation-c' })
		expect(session.snapshot().retiredGenerationIds).toContain('generation-c')
	})

	it('admits a declared generation as the explicit retry only while an authorization is pending (issue #111)', () => {
		const session = new PreviewProtocolSession('session-a')
		session.admitDeclaredGeneration('generation-a')
		session.receiveCapabilityDeclaration('generation-a', { protocolVersion: 99, features: [] }, unsupported)
		// Without an authorization, a declared generation is a reload and is refused while exhausted.
		expect(session.admitDeclaredGeneration('generation-b')).toEqual({ status: 'unauthorized', generationId: 'generation-b' })
		expect(session.authorizeRetry()).toBe('authorized')
		expect(session.admitDeclaredGeneration('generation-c')).toEqual({ status: 'admitted', generationId: 'generation-c', cause: 'explicit-retry' })
		expect(session.snapshot()).toMatchObject({ retryAuthorizationPending: false, currentGenerationPhase: 'bootstrap' })
		// During that handshake a trigger creates nothing.
		expect(session.authorizeRetry()).toBe('ignored-active-bootstrap')
		// A revoked authorization admits nothing either.
		session.receiveCapabilityDeclaration('generation-c', { protocolVersion: 99, features: [] }, unsupported)
		expect(session.authorizeRetry()).toBe('authorized')
		expect(session.revokeRetry()).toBe('revoked')
		expect(session.admitDeclaredGeneration('generation-d').status).toBe('unauthorized')
	})

	it('starts the one automatic recovery attempt on request and admits the next declared generation as it (issue #101)', () => {
		const session = protocolInvalidSession()
		expect(session.beginAutomaticRecovery()).toBe('started')
		expect(session.snapshot()).toMatchObject({ automaticRecoveryUsed: true, automaticRecoveryPending: true, recoveryNeeded: false })
		// The allowance is spent once: a second start is not eligible.
		expect(session.beginAutomaticRecovery()).toBe('not-eligible')
		expect(session.admitDeclaredGeneration('generation-b')).toEqual({ status: 'admitted', generationId: 'generation-b', cause: 'automatic-recovery' })
		expect(session.snapshot()).toMatchObject({ automaticRecoveryPending: false })
		// That attempt fails as well: recovery is exhausted until an explicit retry.
		session.receiveCapabilityDeclaration('generation-b', { protocolVersion: 1, features: [] }, compatible)
		session.receiveCapabilityDeclaration('generation-b', { protocolVersion: 2, features: [] }, compatible)
		expect(session.snapshot()).toMatchObject({ recoveryExhausted: true, recoveryNeeded: false })
		expect(session.beginAutomaticRecovery()).toBe('not-eligible')
		expect(session.admitDeclaredGeneration('generation-c').status).toBe('unauthorized')
	})

	it('renews the automatic allowance when the attempt completes its handshake', () => {
		const session = protocolInvalidSession()
		session.beginAutomaticRecovery()
		session.admitDeclaredGeneration('generation-b')
		session.receiveCapabilityDeclaration('generation-b', { protocolVersion: 1, features: [] }, compatible)
		expect(session.observeCapabilityAcknowledgement('generation-b').status).toBe('opened')
		expect(session.snapshot()).toMatchObject({ automaticRecoveryUsed: false, automaticRecoveryPending: false, recoveryExhausted: false })
	})

	it('counts a protocol-invalid document with no admitted generation against the allowance', () => {
		const session = new PreviewProtocolSession('session-a')
		// The first document sends an undecodable message before any generation of it is admitted.
		session.failRequestedDocument()
		expect(session.snapshot()).toMatchObject({ recoveryNeeded: true })
		expect(session.beginAutomaticRecovery()).toBe('started')
		// The recovery document fails the same way: no generation was admitted, and recovery is exhausted.
		session.failRequestedDocument()
		expect(session.snapshot()).toMatchObject({ recoveryExhausted: true, automaticRecoveryPending: false })
		expect(session.admitDeclaredGeneration('generation-a').status).toBe('unauthorized')
		// Further findings while exhausted change nothing; an explicit retry is still possible.
		session.failRequestedDocument()
		expect(session.authorizeRetry()).toBe('authorized')
		expect(session.admitDeclaredGeneration('generation-b')).toMatchObject({ status: 'admitted', cause: 'explicit-retry' })
	})

	it('fails an admitted generation as protocol-invalid when the Workbench finds its document invalid', () => {
		const session = new PreviewProtocolSession('session-a')
		session.admitDeclaredGeneration('generation-a')
		session.failRequestedDocument()
		expect(session.snapshot()).toMatchObject({ recoveryNeeded: true, retiredGenerationIds: ['generation-a'] })
		expect('currentGenerationId' in session.snapshot()).toBe(false)
	})

	it('turns a retry trigger during a stalled automatic attempt into an explicit retry', () => {
		const session = protocolInvalidSession()
		session.beginAutomaticRecovery()
		// The attempt's document never declared; Retry Preview abandons it for an explicit retry.
		expect(session.authorizeRetry()).toBe('authorized')
		expect(session.snapshot()).toMatchObject({ automaticRecoveryPending: false, recoveryExhausted: true, retryAuthorizationPending: true })
		expect(session.authorizeRetry()).toBe('coalesced')
		expect(session.admitDeclaredGeneration('generation-b')).toEqual({ status: 'admitted', generationId: 'generation-b', cause: 'explicit-retry' })
	})

	it('treats ACK-before-declaration as protocol-invalid and retires that generation', () => {
		const session = new PreviewProtocolSession('session-a')
		session.beginGeneration('generation-a', 'initial')
		expect(session.observeCapabilityAcknowledgement('generation-a')).toEqual({ status: 'protocol-invalid', generationId: 'generation-a' })
		const snapshot = session.snapshot()
		expect(snapshot).toMatchObject({ recoveryNeeded: true })
		expect('currentGenerationId' in snapshot).toBe(false)
		expect(session.beginGeneration('generation-a', 'automatic-recovery')).toEqual({ status: 'identity_reuse', generationId: 'generation-a' })
	})

	it('rejects retired generation ID reuse without reviving or replacing the current generation', () => {
		const session = new PreviewProtocolSession('session-a')
		session.beginGeneration('generation-a', 'initial')
		session.receiveCapabilityDeclaration('generation-a', { protocolVersion: 1, features: [] }, compatible)
		session.observeCapabilityAcknowledgement('generation-a')
		session.replaceGenerationForLifecycle('generation-b', 'restart')

		expect(session.beginGeneration('generation-a', 'restart')).toEqual({ status: 'identity_reuse', generationId: 'generation-a' })
		expect(session.snapshot().currentGenerationId).toBe('generation-b')
		expect(session.classifyGeometryTraffic('session-a', 'generation-a')).toBe('stale-generation')
	})

	it('applies session identity before generation freshness and prevents process-local session ID reuse', () => {
		const registry = new PreviewSessionRegistry()
		const opened = registry.open('session-a')
		expect(opened.status).toBe('opened')
		if (opened.status !== 'opened') return
		opened.session.beginGeneration('generation-a', 'initial')
		expect(opened.session.classifyGeometryTraffic('other-session', 'generation-a')).toBe('stale-session')
		expect(opened.session.classifyGeometryTraffic('session-a', 'other-generation')).toBe('stale-generation')
		expect(registry.open('session-a')).toEqual({ status: 'identity_reuse', previewSessionId: 'session-a' })
		registry.close('session-a')
		expect(registry.open('session-a')).toEqual({ status: 'identity_reuse', previewSessionId: 'session-a' })
		const other = registry.open('session-b')
		expect(other.status).toBe('opened')
	})

	it('discards a minted session ID that is active or retired and mints another before the session begins (issue #101)', () => {
		const registry = new PreviewSessionRegistry()
		const first = registry.openFresh(() => 'session-a')
		registry.close(first.previewSessionId)
		const candidates = ['session-a', 'session-a', 'session-b']
		const minted: string[] = []
		const next = registry.openFresh(() => {
			const candidate = candidates.shift()!
			minted.push(candidate)
			return candidate
		})
		expect(minted).toEqual(['session-a', 'session-a', 'session-b'])
		expect(next.previewSessionId).toBe('session-b')
		expect(registry.get('session-b')).toBe(next)
		expect(registry.get('session-a')).toBeUndefined()
		// A minter that only repeats a used ID never activates it.
		expect(() => registry.openFresh(() => 'session-b')).toThrow(/never used/)
	})

	it('mints opaque random session IDs', () => {
		const ids = new Set(Array.from({ length: 64 }, () => createPreviewSessionId()))
		expect(ids.size).toBe(64)
		for (const id of ids) expect(id).toMatch(/^session-[0-9a-f]{32}$/)
		expect(createPreviewSessionId('version-frame')).toMatch(/^version-frame-[0-9a-f]{32}$/)
	})
})

function protocolInvalidSession(previewSessionId = 'session-a'): PreviewProtocolSession {
	const session = new PreviewProtocolSession(previewSessionId)
	session.beginGeneration('generation-a', 'initial')
	session.receiveCapabilityDeclaration('generation-a', { protocolVersion: 1, features: [] }, compatible)
	session.receiveCapabilityDeclaration('generation-a', { protocolVersion: 2, features: [] }, compatible)
	return session
}

function exhaustedSession(): PreviewProtocolSession {
	const session = protocolInvalidSession()
	session.beginGeneration('generation-b', 'automatic-recovery')
	session.receiveCapabilityDeclaration('generation-b', { protocolVersion: 1, features: [] }, compatible)
	session.receiveCapabilityDeclaration('generation-b', { protocolVersion: 2, features: [] }, compatible)
	return session
}
