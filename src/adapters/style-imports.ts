import { registerHooks } from 'node:module'
import { extname } from 'node:path'

/**
 * The font and image file types a stylesheet or a module of the Preview bundle may import: the
 * bundler emits each as a file of the bundle (Rule 01a11bb1-acdc-799f-aed7-c85ddbaf0d28), by media type.
 */
export const BUNDLED_ASSET_TYPES: Readonly<Record<string, string>> = Object.freeze({
	'.woff2': 'font/woff2',
	'.woff': 'font/woff',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.eot': 'application/vnd.ms-fontobject',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
})

let registered = false

/**
 * Lets the server import an Adapter module whose graph imports CSS, fonts or images, as a component
 * library that imports its CSS from JavaScript does: Node cannot load such files as modules, and the
 * server only reads the Adapter's manifest, so a CSS file loads as an empty module and an asset as
 * a module whose default export is its file name. The Preview bundle builds the real files.
 */
export function allowStyleAndAssetImportsOnServer(): void {
	if (registered) return
	registered = true
	registerHooks({
		load(url, context, nextLoad) {
			if (url.startsWith('file:')) {
				const path = new URL(url).pathname
				const extension = extname(path).toLowerCase()
				if (extension === '.css')
					return { format: 'module', source: '', shortCircuit: true }
				if (Object.hasOwn(BUNDLED_ASSET_TYPES, extension))
					return { format: 'module', source: `export default ${JSON.stringify(decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)))};`, shortCircuit: true }
			}
			return nextLoad(url, context)
		},
	})
}
