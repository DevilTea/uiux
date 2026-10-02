import { validateDigest, Validator, type ValidationResult } from '../validation'

export type ArtifactIdentity = string
export type ArtifactReference = Readonly<{ artifact: ArtifactIdentity }>

export function validateArtifactIdentity(value: unknown, path = ''): ValidationResult<ArtifactIdentity> {
	const v = new Validator()
	validateDigest(value, path, v)
	return v.finish<ArtifactIdentity>(value)
}

export function validateArtifactReference(input: unknown, path = ''): ValidationResult<ArtifactReference> {
	const v = new Validator()
	const reference = v.object(input, path)
	if (!reference) return v.finish<ArtifactReference>(input)
	validateDigest(reference.artifact, `${path}/artifact`, v)
	return v.finish<ArtifactReference>(input)
}

/** Logical identity stays sha256:<hex>; physical sharding is a storage detail. */
export function artifactStoreRelativePath(identity: ArtifactIdentity): string {
	const hex = identity.slice('sha256:'.length)
	return `.uiux/artifacts/sha256/${hex.slice(0, 2)}/${hex}`
}

export type ArtifactByteSource = BufferSource | Uint8Array<ArrayBufferLike>

/** Content identity is computed from bytes; this helper does not choose serialization. */
export async function sha256Identity(bytes: ArtifactByteSource): Promise<ArtifactIdentity> {
	const digest = await globalThis.crypto.subtle.digest('SHA-256', ownedBytes(bytes))
	const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
	return `sha256:${hex}`
}

export async function artifactBytesMatch(identity: ArtifactIdentity, bytes: ArtifactByteSource): Promise<boolean> {
	const validation = validateArtifactIdentity(identity)
	if (!validation.ok) return false
	return await sha256Identity(bytes) === identity
}

function ownedBytes(bytes: ArtifactByteSource): Uint8Array<ArrayBuffer> {
	if (bytes instanceof ArrayBuffer)
		return new Uint8Array(bytes.slice(0))
	return Uint8Array.from(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}
