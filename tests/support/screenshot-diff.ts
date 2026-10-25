import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'

/** Where a screenshot mismatch writes its PNGs; CI uploads it on failure. */
export const SCREENSHOT_DIFF_DIR = join(import.meta.dirname, '..', '..', 'test-results', 'screenshot-diff')

type Raster = { width: number, height: number, channels: number, data: Buffer }

function decodePng(png: Uint8Array): Raster {
	const bytes = Buffer.from(png)
	let offset = 8
	let width = 0
	let height = 0
	let channels = 4
	const parts: Buffer[] = []
	while (offset < bytes.length) {
		const length = bytes.readUInt32BE(offset)
		const type = bytes.toString('ascii', offset + 4, offset + 8)
		const chunk = bytes.subarray(offset + 8, offset + 8 + length)
		if (type === 'IHDR') {
			width = chunk.readUInt32BE(0)
			height = chunk.readUInt32BE(4)
			channels = chunk[9] === 6 ? 4 : chunk[9] === 2 ? 3 : 1
		}
		if (type === 'IDAT') parts.push(chunk)
		offset += 12 + length
	}
	const raw = inflateSync(Buffer.concat(parts))
	const stride = width * channels
	const data = Buffer.alloc(height * stride)
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)]!
		for (let x = 0; x < stride; x++) {
			const value = raw[y * (stride + 1) + 1 + x]!
			const left = x >= channels ? data[y * stride + x - channels]! : 0
			const up = y ? data[(y - 1) * stride + x]! : 0
			const upLeft = x >= channels && y ? data[(y - 1) * stride + x - channels]! : 0
			const estimate = left + up - upLeft
			const dLeft = Math.abs(estimate - left)
			const dUp = Math.abs(estimate - up)
			const dUpLeft = Math.abs(estimate - upLeft)
			const paeth = dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft
			const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth
			data[y * stride + x] = (value + predictor) & 255
		}
	}
	return { width, height, channels, data }
}

function crc32(buffer: Buffer): number {
	let crc = ~0
	for (const byte of buffer) {
		crc ^= byte
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1))
	}
	return ~crc >>> 0
}

function encodeGrayPng(width: number, height: number, pixels: Uint8Array): Buffer {
	const rows = Buffer.alloc(height * (width + 1))
	for (let y = 0; y < height; y++) Buffer.from(pixels.buffer, pixels.byteOffset + y * width, width).copy(rows, y * (width + 1) + 1)
	const chunk = (type: string, body: Buffer) => {
		const head = Buffer.alloc(4)
		head.writeUInt32BE(body.length)
		const crc = Buffer.alloc(4)
		crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), body])))
		return Buffer.concat([head, Buffer.from(type), body, crc])
	}
	const header = Buffer.alloc(13)
	header.writeUInt32BE(width, 0)
	header.writeUInt32BE(height, 4)
	header[8] = 8
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

export type ScreenshotDiff = Readonly<{ identical: boolean, pixels: number, boundingBox: readonly [number, number, number, number] | null, sizes: readonly [string, string] }>

/** Compares two PNGs by decoded pixels; when they differ, writes both and a white-on-black diff under `SCREENSHOT_DIFF_DIR`. */
export async function diffScreenshots(label: string, a: Uint8Array, b: Uint8Array): Promise<ScreenshotDiff> {
	const equalBytes = Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0
	if (equalBytes) return { identical: true, pixels: 0, boundingBox: null, sizes: ['same', 'same'] }
	const left = decodePng(a)
	const right = decodePng(b)
	const sizes = [`${left.width}x${left.height}`, `${right.width}x${right.height}`] as const
	let pixels = 0
	let box: [number, number, number, number] | null = null
	let mask = new Uint8Array(0)
	if (sizes[0] === sizes[1] && left.channels === right.channels) {
		mask = new Uint8Array(left.width * left.height)
		for (let index = 0; index < mask.length; index++) {
			let differs = false
			for (let channel = 0; channel < left.channels; channel++) {
				if (left.data[index * left.channels + channel] !== right.data[index * left.channels + channel]) differs = true
			}
			if (!differs) continue
			pixels += 1
			mask[index] = 255
			const x = index % left.width
			const y = Math.floor(index / left.width)
			box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y]
		}
	}
	const safe = label.replace(/\W+/g, '-')
	await mkdir(SCREENSHOT_DIFF_DIR, { recursive: true })
	await writeFile(join(SCREENSHOT_DIFF_DIR, `${safe}-a.png`), a)
	await writeFile(join(SCREENSHOT_DIFF_DIR, `${safe}-b.png`), b)
	if (mask.length > 0) await writeFile(join(SCREENSHOT_DIFF_DIR, `${safe}-diff.png`), encodeGrayPng(left.width, left.height, mask))
	return { identical: false, pixels, boundingBox: box, sizes }
}

/** A failure message for two screenshots whose bytes differ: decoded size, differing pixel count and bounding box. */
export function describeScreenshotDiff(diff: ScreenshotDiff): string {
	return `screenshot bytes differ: sizes ${diff.sizes.join(' vs ')}, ${diff.pixels} differing pixels, bbox ${JSON.stringify(diff.boundingBox)} (PNG-encoding-only when 0 pixels); files in ${SCREENSHOT_DIFF_DIR}`
}

type CaptureIdentity = Readonly<{ screenshotDigest: string, evidenceDigest: string }>

/** Throws, with the pixel diff in the message, when two captures of one context do not share a screenshot digest. */
export async function assertSameScreenshot(label: string, read: (digest: string) => Promise<Uint8Array | undefined>, first: CaptureIdentity, second: CaptureIdentity): Promise<void> {
	if (first.screenshotDigest === second.screenshotDigest) return
	const a = await read(first.screenshotDigest)
	const b = await read(second.screenshotDigest)
	if (!a || !b) throw new Error(`${label}: a screenshot is missing from the artifact store`)
	throw new Error(`${label}: ${describeScreenshotDiff(await diffScreenshots(label, a, b))}`)
}
