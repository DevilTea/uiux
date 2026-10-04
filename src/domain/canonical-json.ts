/**
 * Canonical JSON serialization ensuring deterministic byte output across all platforms.
 * Keys are ordered lexicographically; numbers, strings, and booleans follow strict JSON format;
 * output terminates with a single trailing newline.
 */
export function canonicalJsonStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value)
	}
	if (Array.isArray(value)) {
		return `[${value.map(item => canonicalJsonStringify(item)).join(',')}]`
	}
	const obj = value as Record<string, unknown>
	const keys = Object.keys(obj).sort()
	const members = keys
		.filter(key => obj[key] !== undefined)
		.map(key => `${JSON.stringify(key)}:${canonicalJsonStringify(obj[key])}`)
	return `{${members.join(',')}}`
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
	return Buffer.from(`${canonicalJsonStringify(value)}\n`, 'utf8')
}
