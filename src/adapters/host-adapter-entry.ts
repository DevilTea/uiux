import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolve as resolveImport } from 'import-meta-resolve'

/**
 * The public Adapter authoring entry (Clause 01a11a5a-462c-7f59-af78-6d01787a275f). The host supplies
 * it from UIUX's own package, as it supplies `@deviltea/widget-core` to the Preview bundle (Discussion
 * #241 owner decision 2 during review of #251): an Adapter's kit never needs `@deviltea/uiux` installed.
 */
export const ADAPTER_ENTRY_SPECIFIER = '@deviltea/uiux/adapter'

/** The `file:` URL of the entry's runtime module in UIUX's package at `packageRoot`, through its `exports` map. */
export function hostAdapterEntryUrl(packageRoot: string): string {
	return resolveImport(ADAPTER_ENTRY_SPECIFIER, pathToFileURL(join(packageRoot, 'package.json')).href)
}

let registered = false

/**
 * Lets the server import an Adapter module that imports `@deviltea/uiux/adapter` from a kit that cannot
 * resolve it itself (one with its own `kit/package.json`, or a third-party Adapter installed in the kit):
 * Node's loader resolves the import, for every importer, to the entry of UIUX's package at `packageRoot`,
 * the module the Preview bundle aliases. The first call fixes the package.
 */
export function supplyAdapterEntryOnServer(packageRoot: string): void {
	if (registered) return
	registered = true
	const url = hostAdapterEntryUrl(packageRoot)
	registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === ADAPTER_ENTRY_SPECIFIER) return { url, format: 'module', shortCircuit: true }
			return nextResolve(specifier, context)
		},
	})
}
