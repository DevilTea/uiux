import { appendResponseHeader, setResponseHeader, type H3Event } from 'h3'

/**
 * Content-Security-Policy for stored bytes served inline (Asset content, artifacts, version blobs).
 * Opened as a top-level document, such content gets an opaque origin and runs no script; inline
 * styles and `data:` images and fonts still render, so an SVG looks the same as it does in `<img>`.
 */
export const STORED_CONTENT_SECURITY_POLICY = 'sandbox; default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:'

/**
 * Media types shown by a browser viewer that a sandboxed document cannot host (Chrome's PDF viewer
 * refuses sandboxed documents). They run no script on the serving origin, and `nosniff` keeps a
 * mislabeled body from being read as another type.
 */
const UNSANDBOXED_MEDIA_TYPES = new Set(['application/pdf'])

/** The sandboxing header for stored bytes of `mediaType`, or nothing for a type that cannot be sandboxed. */
export function storedContentSecurityHeaders(mediaType: string): Readonly<Record<string, string>> {
	const essence = mediaType.split(';', 1)[0]!.trim().toLowerCase()
	return UNSANDBOXED_MEDIA_TYPES.has(essence) ? {} : { 'Content-Security-Policy': STORED_CONTENT_SECURITY_POLICY }
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
