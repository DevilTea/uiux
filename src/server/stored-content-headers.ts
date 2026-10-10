import { appendResponseHeader, setResponseHeader, type H3Event } from 'h3'

import { detectSignatureMediaType } from '../domain/assets/schema'

/**
 * Content-Security-Policy for stored bytes served inline (Asset content, artifacts, version blobs).
 * Opened as a top-level document, such content gets an opaque origin and runs no script; inline
 * styles and `data:` images and fonts still render, so an SVG looks the same as it does in `<img>`.
 */
export const STORED_CONTENT_SECURITY_POLICY = 'sandbox; default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:'

/**
 * The sandboxing header for stored `bytes` served as `mediaType`. The one exception is a PDF, which a
 * browser shows in a viewer that refuses sandboxed documents and that runs no script on the serving
 * origin: it is left unsandboxed only when it is declared PDF and its bytes carry the PDF signature,
 * so other bytes merely labeled PDF stay sandboxed.
 */
export function storedContentSecurityHeaders(mediaType: string, bytes: Uint8Array): Readonly<Record<string, string>> {
	const essence = mediaType.split(';', 1)[0]!.trim().toLowerCase()
	const pdf = essence === 'application/pdf' && detectSignatureMediaType(bytes) === 'application/pdf'
	return pdf ? {} : { 'Content-Security-Policy': STORED_CONTENT_SECURITY_POLICY }
}

/**
 * Writes a byte route's headers. A Content-Security-Policy is added as a second policy rather than
 * replacing the baseline one every response carries (`frame-ancestors 'self'`, set by the loopback
 * guard); a browser enforces both.
 */
export function setStoredContentHeaders(event: H3Event, headers: Readonly<Record<string, string>>): void {
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === 'content-security-policy') appendResponseHeader(event, name, value)
		else setResponseHeader(event, name, value)
	}
}
