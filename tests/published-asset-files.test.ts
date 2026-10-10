import { describe, expect, it } from 'vitest'
import { publishedAssetKind } from '../app/utils/published-asset-files'

const kind = (filename: string, mediaType: string) => publishedAssetKind({ filename, mediaType })

describe('publishedAssetKind', () => {
	it('treats a file served as SVG, by media type or extension, as svg', () => {
		expect(kind('icon.svg', 'image/svg+xml')).toBe('svg')
		expect(kind('icon.SVGZ', 'application/octet-stream')).toBe('svg')
		expect(kind('icon.bin', 'Image/SVG+XML; charset=utf-8')).toBe('svg')
	})

	it('treats a file served as HTML, XHTML or any XML type as a document', () => {
		for (const filename of ['page.html', 'page.HTM', 'page.shtml', 'page.xhtml', 'page.xht', 'data.xml', 'style.xsl', 'style.xslt', 'feed.rss', 'feed.atom', 'math.mml', 'map.kml'])
			expect(kind(filename, 'application/octet-stream'), filename).toBe('document')
		for (const mediaType of ['text/html', 'application/xhtml+xml', 'text/xml', 'application/xml', 'application/rss+xml', 'application/vnd.example+xml; charset=utf-8'])
			expect(kind('content.bin', mediaType), mediaType).toBe('document')
		// The extension decides what a static host serves, whatever the declared media type.
		expect(kind('photo.html', 'image/png')).toBe('document')
	})

	it('keeps raster images and other files on their static file', () => {
		for (const [filename, mediaType] of [['a.png', 'image/png'], ['a.jpg', 'image/jpeg'], ['a.gif', 'image/gif'], ['a.webp', 'image/webp'], ['a.avif', 'image/avif'], ['a.pdf', 'application/pdf'], ['a.json', 'application/json'], ['a.txt', 'text/plain'], ['a.mhtml', 'message/rfc822'], ['README', '']] as const)
			expect(kind(filename, mediaType), filename).toBe('file')
	})
})
