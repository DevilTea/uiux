import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

/** The query parameter that names the kit build output generation a module was imported for. */
export const KIT_OUTPUT_VERSION_PARAMETER = 'v'

/**
 * The `file:` URL, ending in `/`, of each directory whose modules share their importer's version,
 * with the version its CommonJS modules were last forgotten for.
 */
const scopes = new Map<string, string>()
let registered = false

/**
 * Lets the kit build output generation `version` import, anew, the modules its Adapter module
 * imports (Rule 01a11bb1-9df8-762d-b5e5-306f9898aae2), so an edit to a file the Adapter imports
 * reaches the server with the next settled output instead of the next restart.
 *
 * - Node caches an ES module by its URL, so the Adapter module of each generation is imported under
 *   `?v=<version>`; this resolve hook gives every module it imports, directly or through others,
 *   the same `?v=<version>` while both lie in `directory` (the real `kit/`) and outside any
 *   `node_modules/`. A specifier that already carries a query keeps it.
 * - Node caches a CommonJS module by its file name, whatever the URL: those in `directory`, outside
 *   any `node_modules/`, leave the `require` cache once per new version, before it is imported.
 *
 * Installed packages keep one copy per process.
 */
export function shareVersionWithKitImports(directory: string, version: string): void {
	const href = pathToFileURL(directory).href
	const scope = href.endsWith('/') ? href : `${href}/`
	if (scopes.get(scope) !== version) {
		scopes.set(scope, version)
		forgetCommonJsModules(scope)
	}
	if (registered) return
	registered = true
	registerHooks({
		resolve(specifier, context, nextResolve) {
			const resolved = nextResolve(specifier, context)
			const parent = context.parentURL
			if (parent === undefined || !context.conditions?.includes('import')) return resolved
			if (!inScope(parent) || !inScope(resolved.url)) return resolved
			const parentVersion = new URL(parent).searchParams.get(KIT_OUTPUT_VERSION_PARAMETER)
			if (parentVersion === null) return resolved
			const url = new URL(resolved.url)
			if (url.search !== '') return resolved
			url.searchParams.set(KIT_OUTPUT_VERSION_PARAMETER, parentVersion)
			return { ...resolved, url: url.href }
		},
	})
}

function forgetCommonJsModules(scope: string): void {
	const cache = createRequire(import.meta.url).cache
	for (const filename of Object.keys(cache)) {
		if (inScope(pathToFileURL(filename).href, [scope])) delete cache[filename]
	}
}

function inScope(url: string, within: Iterable<string> = scopes.keys()): boolean {
	if (!url.startsWith('file:')) return false
	for (const scope of within) {
		if (!url.startsWith(scope)) continue
		const inside = new URL(url).pathname.slice(new URL(scope).pathname.length)
		if (!inside.split('/').includes('node_modules')) return true
	}
	return false
}
