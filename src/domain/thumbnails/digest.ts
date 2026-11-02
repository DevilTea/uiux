import { createHash } from 'node:crypto'
import { canonicalJsonBytes } from '../canonical-json'
import type { JsonValue } from '../validation'

/**
 * The View thumbnail records of Contract 01a19b99-cb2f-76fb-add5-2ede8d0aebdd, as pure functions:
 * the thumbnail input digest (Clause 01a19b99-ccfa-74bb-9671-08ab5d4e2656), the cache file name
 * (Clause 01a19b99-cbd0-7076-b286-a6cee12af0f3) and the image size (Clause 01a19b99-cc6d-7bf7-9f15-5250944e198f).
 * Server-side only: it hashes with `node:crypto`.
 */

/** The width of every thumbnail, in pixels (Clause 01a19b99-cc6d-7bf7-9f15-5250944e198f). */
export const THUMBNAIL_WIDTH = 480

/** Everything a View's thumbnail depends on (Clause 01a19b99-ccfa-74bb-9671-08ab5d4e2656). */
export type ThumbnailInputs = Readonly<{
	/** The View's own render-input digest (Clause 01a14e30-2d4a-7ce9-ad68-58db56f36f47), which keeps its Variants. */
	renderInputDigest: string
	locale: Readonly<{ id: string; revision: string }>
	viewport: Readonly<{ id: string; width: number; height: number }>
	themeId: string
	/** The current Adapter provenance a formal capture records. */
	adapters: JsonValue
	/** The current Product Kit provenance a formal capture records. */
	productKit: JsonValue
	/** The id of each Asset the View binds, with its revision. */
	assets: Readonly<Record<string, string>>
}>

/** `sha256:<hex>` over the canonical JSON of `inputs`, encoded as the render-input digest is. */
export function thumbnailInputDigest(inputs: ThumbnailInputs): string {
	const bytes = canonicalJsonBytes({
		renderInputDigest: inputs.renderInputDigest,
		locale: { id: inputs.locale.id, revision: inputs.locale.revision },
		viewport: { id: inputs.viewport.id, width: inputs.viewport.width, height: inputs.viewport.height },
		themeId: inputs.themeId,
		adapters: inputs.adapters,
		productKit: inputs.productKit,
		assets: { ...inputs.assets },
	})
	return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

const HEX_64 = /^[0-9a-f]{64}$/

/** The 64 hex digits of a thumbnail input digest, which name its cache file. */
export function thumbnailDigestHex(digest: string): string {
	return digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest
}

export function isThumbnailDigestHex(value: string): boolean {
	return HEX_64.test(value)
}

/** The image height for a viewport: 480 times its height divided by its width, rounded half up. */
export function thumbnailHeight(viewport: Readonly<{ width: number; height: number }>): number {
	return Math.floor((THUMBNAIL_WIDTH * viewport.height) / viewport.width + 0.5)
}

/** The `deviceScaleFactor` that makes a viewport screenshot `THUMBNAIL_WIDTH` pixels wide. */
export function thumbnailScaleFactor(viewport: Readonly<{ width: number }>): number {
	return THUMBNAIL_WIDTH / viewport.width
}

/** The pixel size a PNG declares in its header, or `undefined` when `bytes` is not a PNG. */
export function pngSize(bytes: Uint8Array): Readonly<{ width: number; height: number }> | undefined {
	if (bytes.length < 24) return undefined
	const signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
	if (signature.some((byte, index) => bytes[index] !== byte)) return undefined
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	return { width: view.getUint32(16), height: view.getUint32(20) }
}
