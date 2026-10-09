import type { JsonValue } from '../../validation'
import { asRecord, asString, compareCodeUnits, diffJson, type JsonPointerChange } from './json-pointer'

/** One file of an Asset directory: its content digest and, when it was read, its bytes. */
export type AssetFile = Readonly<{ digest: string; bytes?: Uint8Array }>

/** An Asset's files by filename inside its directory (`asset.json` and the content file). */
export type AssetFiles = ReadonlyMap<string, AssetFile>

export type AssetImageRef = Readonly<{ digest: string; mediaType: string }>

/**
 * The semantic diff of an Asset (Rule 01a11a5e-10df-795e-8fbc-a99de09694a5): the metadata changes
 * (`asset.json`, relative pointers), the content digest change and, when either side's media type
 * is an image, the before and after images as content digests. Fetching an image by digest is the
 * reader's concern. Files the metadata does not explain (an unreadable `asset.json`, a stray file)
 * are listed by digest in `files`.
 */
export type AssetDiff = Readonly<{
	type: 'asset'
	metadata?: readonly JsonPointerChange[]
	content?: Readonly<{ before?: string; after?: string }>
	image?: Readonly<{ before?: AssetImageRef; after?: AssetImageRef }>
	files?: readonly Readonly<{ name: string; before?: string; after?: string }>[]
}>

const METADATA_FILE = 'asset.json'

export function diffAsset(before: AssetFiles | undefined, after: AssetFiles | undefined): AssetDiff {
	const left = describe(before)
	const right = describe(after)
	const metadata = left.metadata !== undefined || right.metadata !== undefined ? diffJson(left.metadata, right.metadata) : []
	const content = left.content?.digest === right.content?.digest
		? undefined
		: { ...(left.content ? { before: left.content.digest } : {}), ...(right.content ? { after: right.content.digest } : {}) }
	const beforeImage = imageRef(left)
	const afterImage = imageRef(right)
	const explained = (side: Described, name: string) => (name === METADATA_FILE && side.metadata !== undefined) || name === side.content?.name
	const files: { name: string; before?: string; after?: string }[] = []
	for (const name of [...new Set([...(before?.keys() ?? []), ...(after?.keys() ?? [])])].sort(compareCodeUnits)) {
		const was = before?.get(name)?.digest
		const now = after?.get(name)?.digest
		if (was === now) continue
		if ((was === undefined || explained(left, name)) && (now === undefined || explained(right, name))) continue
		files.push({ name, ...(was === undefined ? {} : { before: was }), ...(now === undefined ? {} : { after: now }) })
	}
	return {
		type: 'asset',
		...(metadata.length > 0 ? { metadata } : {}),
		...(content ? { content } : {}),
		...((beforeImage || afterImage) && (content || metadata.length > 0) ? { image: { ...(beforeImage ? { before: beforeImage } : {}), ...(afterImage ? { after: afterImage } : {}) } } : {}),
		...(files.length > 0 ? { files } : {}),
	}
}

type Described = Readonly<{
	metadata?: JsonValue
	mediaType?: string
	content?: Readonly<{ name: string; digest: string }>
}>

function describe(files: AssetFiles | undefined): Described {
	if (!files) return {}
	const metadataBytes = files.get(METADATA_FILE)?.bytes
	let metadata: JsonValue | undefined
	if (metadataBytes) {
		try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes)) as JsonValue }
		catch { metadata = undefined }
	}
	const record = asRecord(metadata)
	const contentName = asString(record?.contentFilename)
	const contentFile = contentName === undefined || contentName === METADATA_FILE ? undefined : files.get(contentName)
	const mediaType = asString(record?.mediaType)
	return {
		...(metadata === undefined ? {} : { metadata }),
		...(mediaType === undefined ? {} : { mediaType }),
		...(contentName !== undefined && contentFile ? { content: { name: contentName, digest: contentFile.digest } } : {}),
	}
}

function imageRef(side: Described): AssetImageRef | undefined {
	return side.content && side.mediaType?.toLowerCase().startsWith('image/') ? { digest: side.content.digest, mediaType: side.mediaType } : undefined
}
