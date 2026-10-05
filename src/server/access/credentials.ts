import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Credential format (accepted identity decision 3):
 *
 * `uiux_<t|i|s>_<ws>_<id>_<secret>`, lowercase RFC 4648 base32 (`a-z2-7`), where `<ws>` is the
 * roster's 4-character hint, `<id>` the 10-character public lookup key and `<secret>` 52
 * characters encoding 32 random bytes. Only `sha256:<hex>` of the full string is ever stored.
 */
export type CredentialKind = 'token' | 'invite' | 'session'

const KIND_LETTER: Readonly<Record<CredentialKind, 't' | 'i' | 's'>> = Object.freeze({ token: 't', invite: 'i', session: 's' })
const LETTER_KIND: Readonly<Record<string, CredentialKind>> = Object.freeze({ t: 'token', i: 'invite', s: 'session' })

export const CREDENTIAL_PATTERN = /^uiux_([tis])_([a-z2-7]{4})_([a-z2-7]{10})_([a-z2-7]{52})$/u
/** Global, unanchored form used by log redaction. */
export const CREDENTIAL_SCAN_PATTERN = /uiux_[tis]_[a-z2-7]{4}_[a-z2-7]{10}_[a-z2-7]{52}/gu
export const HINT_PATTERN = /^[a-z2-7]{4}$/u
export const CREDENTIAL_ID_PATTERN = /^[a-z2-7]{10}$/u

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

export function base32(bytes: Uint8Array): string {
	let bits = 0
	let value = 0
	let output = ''
	for (const byte of bytes) {
		value = (value << 8) | byte
		bits += 8
		while (bits >= 5) {
			output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
			bits -= 5
		}
	}
	if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
	return output
}

/** Four random base32 characters: the roster hint (random, so it reveals nothing about the path). */
export function generateHint(): string {
	return base32(randomBytes(3)).slice(0, 4)
}

export function generateCredentialId(): string {
	return base32(randomBytes(7)).slice(0, 10)
}

export type ParsedCredential = Readonly<{ kind: CredentialKind; hint: string; id: string; value: string }>

export type GeneratedCredential = ParsedCredential & Readonly<{ hash: string }>

export function generateCredential(kind: CredentialKind, hint: string, id: string = generateCredentialId()): GeneratedCredential {
	if (!HINT_PATTERN.test(hint)) throw new Error('Roster hint must be 4 base32 characters.')
	if (!CREDENTIAL_ID_PATTERN.test(id)) throw new Error('Credential id must be 10 base32 characters.')
	const secret = base32(randomBytes(32))
	const value = `uiux_${KIND_LETTER[kind]}_${hint}_${id}_${secret}`
	return { kind, hint, id, value, hash: hashCredential(value) }
}

export function parseCredential(value: unknown): ParsedCredential | undefined {
	if (typeof value !== 'string') return undefined
	const match = CREDENTIAL_PATTERN.exec(value)
	if (!match) return undefined
	return { kind: LETTER_KIND[match[1]!]!, hint: match[2]!, id: match[3]!, value }
}

export function hashCredential(value: string): string {
	return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

/** Constant-time comparison of a presented credential against a stored `sha256:<hex>` hash. */
export function credentialMatchesHash(value: string, storedHash: string): boolean {
	const expected = Buffer.from(storedHash, 'utf8')
	const actual = Buffer.from(hashCredential(value), 'utf8')
	if (expected.length !== actual.length) return false
	return timingSafeEqual(expected, actual)
}

/** The roster-scoped browser session cookie name (decision 4). */
export function sessionCookieName(hint: string): string {
	return `uiux_session_${hint}`
}

/**
 * Replaces every credential-shaped string, `Authorization` header value and `uiux_session_*`
 * cookie value with `<redacted>` (decision 3: secrets never appear in logs).
 */
export function redactCredentials(text: string): string {
	return text
		.replace(CREDENTIAL_SCAN_PATTERN, '<redacted>')
		.replace(/(authorization["']?\s*[:=]\s*["']?)(bearer\s+)?[^\s"',;}]+/giu, (_match, prefix: string, scheme: string | undefined) => `${prefix}${scheme ?? ''}<redacted>`)
		.replace(/(uiux_session_[a-z2-7]{4}=)[^\s;"',}]+/gu, '$1<redacted>')
}
