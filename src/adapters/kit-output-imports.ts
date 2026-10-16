import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

/** The query parameter that names the kit build output generation a module was imported for. */
export const KIT_OUTPUT_VERSION_PARAMETER = 'v'

/**
 * The `file:` URL, ending in `/`, of each directory whose modules share their importer's version,
 * with the version it was last given (and its CommonJS modules last forgotten for).
 */
const scopes = new Map<string, string>()
let registered = false

/**
 * Lets the kit build output generation `version` import, anew, the modules its Adapter module
 * imports (Rule 01a11bb1-9df8-762d-b5e5-306f9898aae2), so an edit to a file the Adapter imports
 * reaches the server with the next settled output instead of the next restart. A kit module is one
 * whose real path lies in `directory` (the real `kit/`), outside any `node_modules/`.
 *
 * - Node caches an ES module by its URL, so the Adapter module of each generation is imported under
 *   `?v=<version>`; this resolve hook gives each kit module that a kit module loads, by `import`,
 *   `import()` or `require`, a `?v` too: its importer's own, or, for an importer without one (a
 *   CommonJS module, whose URL never carries the query), the version `directory` was last given.
 *   A specifier that already carries a query keeps it.
 * - Node caches a CommonJS module by its file name, whatever the URL: the kit modules leave the
 *   `require` cache once per new version, before it is imported.
 *
 * Installed packages keep one copy per process. One path cannot be versioned in Node 24: an ES
 * module that `require()` loads (require(esm)) is cached by its file URL without the query this hook
 * adds (`importSyncForRequire` in Node's ES module loader), so a kit ES module first loaded that way
 * keeps that copy for the life of the process (Implementation gap on Rule 01a11bb1-9df8).
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
			if (parent === undefined || !inScope(resolved.url)) return resolved
			const parentScope = scopeOf(parent)
			if (parentScope === undefined) return resolved
			const url = new URL(resolved.url)
			if (url.search !== '') return resolved
			const version = new URL(parent).searchParams.get(KIT_OUTPUT_VERSION_PARAMETER) ?? scopes.get(parentScope)!
			url.searchParams.set(KIT_OUTPUT_VERSION_PARAMETER, version)
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
	return scopeOf(url, within) !== undefined
}

/** The scope of `within` that holds `url` outside any `node_modules/`, if any. */
function scopeOf(url: string, within: Iterable<string> = scopes.keys()): string | undefined {
	if (!url.startsWith('file:')) return undefined
	for (const scope of within) {
		if (!url.startsWith(scope)) continue
		const inside = new URL(url).pathname.slice(new URL(scope).pathname.length)
		if (!inside.split('/').includes('node_modules')) return scope
	}
	return undefined
}
