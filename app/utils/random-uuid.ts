/**
 * A random version 4 UUID, also without a secure context (Rule 01a12500-b84a-7d4e-a52d-5c7e13d78fd0):
 * `crypto.randomUUID()` exists only in secure contexts, so a plain-HTTP network origin falls back
 * to `crypto.getRandomValues()`, which every context has.
 */
export function randomUuid(): string {
	const cryptoApi = globalThis.crypto
	if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
	const bytes = new Uint8Array(16)
	cryptoApi.getRandomValues(bytes)
	bytes[6] = (bytes[6]! & 0x0f) | 0x40
	bytes[8] = (bytes[8]! & 0x3f) | 0x80
	const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
