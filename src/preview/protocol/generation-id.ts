/**
 * A fresh, opaque runtime generation ID (Clause 01a1161c-4119-712d-8785-7d8155c0ceee): the runtime
 * mints one for every Preview document load and runtime restart, and the Workbench never allocates
 * it. Nothing in the Preview URL fixes it, so a reloaded document is always a new generation and
 * never revives a retired one (Clause 01a1161c-4339-7614-ba65-6f21e37cd1a0, issue #102).
 *
 * `getRandomValues` rather than `randomUUID`: UIUX serves plain HTTP, and a Workbench opened on a
 * LAN origin is not a secure context, where `randomUUID` does not exist.
 */
export function createRuntimeGenerationId(random: Pick<Crypto, 'getRandomValues'> = globalThis.crypto): string {
	const bytes = random.getRandomValues(new Uint8Array(16))
	return `gen-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
}
