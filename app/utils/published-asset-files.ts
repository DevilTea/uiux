/**
 * How a static publication offers one Asset file. A static host picks a file's `Content-Type`
 * from its extension, so a published Asset file that a host serves as HTML, XHTML, SVG or any XML
 * type opens as a document on the published site's own origin. The viewer offers those files from
 * `data:` URLs instead of their raw file:
 *
 * - `svg`: shown as an image from `data:image/svg+xml` (an `<img>` never runs SVG script) and
 *   downloaded from `data:application/octet-stream`;
 * - `document`: not shown; downloaded from `data:application/octet-stream`;
 * - `file`: raster images and every other type keep their static file.
 */
export type PublishedAssetKind = 'svg' | 'document' | 'file'

const SVG_MEDIA_TYPE = 'image/svg+xml'
const DOCUMENT_MEDIA_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/xml', 'application/xml', 'text/xsl', 'text/mathml'])
const SVG_EXTENSIONS = new Set(['svg', 'svgz'])

/**
 * File extensions that common static hosts serve as `text/html`, `application/xhtml+xml`,
 * `text/xml`, `application/xml`, `text/mathml` or a `+xml` type. Derived from mime-db 1.54.0, the
 * extension table of most Node-based and CDN static hosts; nginx's default `mime.types` maps a
 * subset of these (html htm shtml xhtml xml rss atom mml kml xspf) to the same types. Browsers
 * render any XML type as an XML document, where XHTML-namespace elements run script.
 */
const DOCUMENT_EXTENSIONS = new Set(`
	1km ac aml atom atomcat atomdeleted atomsvc bdo bmml ccxml cdfx cdxml cpl csl dae davmount dbk
	dcmp dd2 ddf dtb dwd emma emotionml es3 et3 fdt fo gml gpx grxml hal held htm html ink inkml irp
	its kml lasxml lbe lgr link66 lostxml mads maei mathml meta4 metalink mets mml mods mpd mpf mpkg
	mpp mrcx mscml musd musicxml mxml ncx obgx omdoc opf osfpvg osm owl pls provx pskcxml rapd rdf
	relo res rif rl rld rng rs rsat rsd rsheet rss rusd sbml sdkd sdkm senmlx sensmlx shf shtml sls
	smi smil sru srx ssdl ssml stpx swidtag td tei teicorpus tfi ttml uo uoml uvt uvvt vxml wadl wbs
	wif wsdl wspolicy x3d x3dz xaml xav xca xcs xdcf xdf xdm xdp xdssc xel xenc xer xht xhtm xhtml
	xhvml xlf xml xns xop xpl xsd xsf xsl xslt xsm xspf xul xvm xvml yin zaz zmm
`.trim().split(/\s+/u))

function mediaTypeEssence(mediaType: string): string {
	return mediaType.split(';')[0]!.trim().toLowerCase()
}

function extensionOf(filename: string): string {
	const dot = filename.lastIndexOf('.')
	return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase()
}

/** Classifies a published Asset file by its declared media type and its file extension. */
export function publishedAssetKind(file: Readonly<{ filename: string; mediaType: string }>): PublishedAssetKind {
	const mediaType = mediaTypeEssence(file.mediaType)
	const extension = extensionOf(file.filename)
	if (mediaType === SVG_MEDIA_TYPE || SVG_EXTENSIONS.has(extension)) return 'svg'
	if (DOCUMENT_MEDIA_TYPES.has(mediaType) || mediaType.endsWith('+xml') || DOCUMENT_EXTENSIONS.has(extension)) return 'document'
	return 'file'
}
