import {
	validateUuid,
	Validator,
	type Diagnostic,
	type ValidationResult,
} from '../validation'

export type AuthoredAsset = Readonly<{
	id: string
	name: string
	contentFilename: string
	mediaType: string
}>
export type AuthoredAssetResource = Readonly<{
	metadata: AuthoredAsset
	content: Uint8Array
}>
export type AssetBinding = Readonly<{ $asset: string }>
export type AssetCapability = Readonly<{
	acceptedMediaTypes?: readonly string[]
	acceptedCategories?: readonly string[]
}>

export function decodeStrictBase64(base64: unknown, path = '/contentBase64'): { ok: true; bytes: Uint8Array } | { ok: false; diagnostics: readonly Diagnostic[] } {
	if (typeof base64 !== 'string')
		return { ok: false, diagnostics: [{ code: 'asset.invalid_base64', path, message: 'Asset contentBase64 must be a string.' }] }
	if (base64.length === 0)
		return { ok: false, diagnostics: [{ code: 'asset.invalid_base64', path, message: 'Asset contentBase64 must not be empty.' }] }
	if (base64.length % 4 !== 0)
		return { ok: false, diagnostics: [{ code: 'asset.invalid_base64', path, message: 'Asset contentBase64 length must be a multiple of 4.' }] }
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/u.test(base64))
		return { ok: false, diagnostics: [{ code: 'asset.invalid_base64', path, message: 'Asset contentBase64 contains invalid base64 characters, whitespace, or misplaced padding.' }] }
	const buf = Buffer.from(base64, 'base64')
	if (buf.length === 0)
		return { ok: false, diagnostics: [{ code: 'asset.invalid_base64', path, message: 'Asset contentBase64 decoded to zero bytes.' }] }
	if (buf.toString('base64') !== base64)
		return { ok: false, diagnostics: [{ code: 'asset.invalid_base64', path, message: 'Asset contentBase64 is not canonical RFC 4648 base64 (contains non-canonical unused bits).' }] }
	return { ok: true, bytes: Uint8Array.from(buf) }
}

export function validateAssetMetadata(input: unknown, directoryId?: string): ValidationResult<AuthoredAsset> {
	const v = new Validator()
	const asset = v.object(input, '')
	if (!asset) return v.finish<AuthoredAsset>(input)
	const idIsUuid = validateUuid(asset.id, '/id', v, 'Asset id')
	if (directoryId !== undefined) {
		validateUuid(directoryId, '/directoryId', v, 'Asset directory id')
		if (idIsUuid && directoryId !== asset.id)
			v.issue('identity.directory_id_mismatch', '/id', 'Asset directory UUID must exactly match asset.json id.')
	}
	v.string(asset.name, '/name', true)
	const contentFilename = v.string(asset.contentFilename, '/contentFilename', true)
	if (contentFilename !== undefined && (contentFilename === '.' || contentFilename === '..' || contentFilename === 'asset.json' || contentFilename.includes('/') || contentFilename.includes('\\') || [...contentFilename].some(character => character.charCodeAt(0) === 0)))
		v.issue('asset.invalid_content_filename', '/contentFilename', 'Canonical source content must be a single filename inside the asset directory.')
	const mediaType = v.string(asset.mediaType, '/mediaType', true)
	if (mediaType !== undefined && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(mediaType))
		v.issue('asset.invalid_media_type', '/mediaType', 'Declared mediaType must use the type/subtype form.')
	return v.finish<AuthoredAsset>(input)
}

export function validateAuthoredAssetResource(input: unknown): ValidationResult<AuthoredAssetResource> {
	const diagnostics: Diagnostic[] = []
	if (typeof input !== 'object' || input === null || Array.isArray(input))
		return { ok: false, diagnostics: [{ code: 'schema.expected_object', path: '', message: 'Expected an authored Asset resource object.' }] }
	const candidate = input as { metadata?: unknown; content?: unknown }
	const metadata = validateAssetMetadata(candidate.metadata)
	if (!metadata.ok) diagnostics.push(...metadata.diagnostics.map(item => ({ ...item, path: `/metadata${item.path}` })))
	if (!(candidate.content instanceof Uint8Array))
		diagnostics.push({ code: 'asset.invalid_content_bytes', path: '/content', message: 'Authored Asset source content must be byte data.' })
	if (metadata.ok && candidate.content instanceof Uint8Array)
		diagnostics.push(...validateAssetContentMetadata(metadata.value, metadata.value.contentFilename, candidate.content).diagnostics.map(item => ({ ...item, path: `/metadata${item.path}` })))
	if (diagnostics.length > 0) return { ok: false, diagnostics }
	return { ok: true, value: input as AuthoredAssetResource, diagnostics: [] }
}

/** The directory contains metadata plus exactly the one filename named by asset.json. */
export function validateAssetContentFiles(asset: AuthoredAsset, contentFilenames: readonly string[]): ValidationResult<readonly string[]> {
	const v = new Validator()
	if (contentFilenames.length !== 1)
		v.issue('asset.invalid_content_file_count', '/contentFiles', 'An authored asset directory contains exactly one canonical source-content file.')
	if (contentFilenames.length === 1 && contentFilenames[0] !== asset.contentFilename)
		v.issue('asset.content_filename_mismatch', '/contentFilename', 'The listed source-content filename must match asset.json.')
	return v.finish<readonly string[]>(contentFilenames)
}

/** Validate byte signatures and known extensions without guessing unknown formats. */
export function validateAssetContentMetadata(asset: AuthoredAsset, filename: string, bytes: Uint8Array): ValidationResult<AuthoredAsset> {
	const v = new Validator()
	const declared = mediaTypeEssence(asset.mediaType)
	const fromSignature = detectSignatureMediaType(bytes)
	const fromExtension = extensionMediaType(filename)
	if (fromSignature && fromSignature !== declared)
		v.issue('asset.signature_media_type_mismatch', '/mediaType', `Declared media type ${declared} does not match detected content ${fromSignature}.`)
	if (fromExtension && fromExtension !== declared)
		v.issue('asset.extension_media_type_mismatch', '/contentFilename', `Declared media type ${declared} does not match the known filename media type ${fromExtension}.`)
	if (fromSignature && fromExtension && fromSignature !== fromExtension)
		v.issue('asset.signature_extension_mismatch', '/contentFilename', 'Detected content type does not match the canonical filename extension.')
	return v.finish<AuthoredAsset>(asset)
}

export function validateAssetBinding(input: unknown, path = ''): ValidationResult<AssetBinding> {
	const v = new Validator()
	const binding = v.object(input, path)
	if (!binding) return v.finish<AssetBinding>(input)
	if (Object.keys(binding).length !== 1 || !Object.hasOwn(binding, '$asset'))
		v.issue('asset.invalid_binding_shape', path, 'An authored asset binding contains only the $asset key.')
	validateUuid(binding.$asset, `${path}/$asset`, v, 'Asset reference')
	return v.finish<AssetBinding>(input)
}

export function validateAssetBindingCompatibility(
	mediaType: string,
	category: string | undefined,
	capability: AssetCapability | undefined,
	path = '',
): ValidationResult<void> {
	const v = new Validator()
	if (!capability) {
		v.issue('asset.field_not_capable', path, 'Only Adapter Catalog fields explicitly marked asset-capable accept $asset bindings.')
		return v.finish<void>(undefined)
	}
	const mediaTypes = capability.acceptedMediaTypes ?? []
	const categories = capability.acceptedCategories ?? []
	if (!mediaTypes.includes(mediaType) && (category === undefined || !categories.includes(category)))
		v.issue('asset.incompatible_media_type', path, 'Asset media type/category is outside this Catalog field’s accepted set.')
	return v.finish<void>(undefined)
}

function mediaTypeEssence(mediaType: string): string {
	return mediaType.split(';', 1)[0]!.trim().toLowerCase()
}

function extensionMediaType(filename: string): string | undefined {
	const extension = filename.split('.').at(-1)?.toLowerCase()
	return ({
		png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
		svg: 'image/svg+xml', pdf: 'application/pdf', json: 'application/json', txt: 'text/plain',
	} as Record<string, string>)[extension ?? '']
}

function detectSignatureMediaType(bytes: Uint8Array): string | undefined {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
	if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif'
	if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'
	if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp'
	const prefix = ascii(bytes, 0, Math.min(bytes.length, 1024)).replace(/^\uFEFF/u, '').trimStart()
	if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[^]*?-->\s*)*<svg\b/iu.test(prefix)) return 'image/svg+xml'
	return undefined
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
	return signature.every((value, index) => bytes[index] === value)
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
	return new TextDecoder().decode(bytes.subarray(start, start + length))
}
