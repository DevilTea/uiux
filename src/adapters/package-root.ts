import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * UIUX's own package root: `UIUX_PACKAGE_ROOT` when set (the CLI sets it), else the nearest
 * directory upward from this module whose `package.json` names `@deviltea/uiux`, else the current
 * directory.
 */
export function resolvePackageRoot(): string {
	if (process.env.UIUX_PACKAGE_ROOT) {
		return resolve(process.env.UIUX_PACKAGE_ROOT)
	}
	let dir = dirname(fileURLToPath(import.meta.url))
	while (true) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }
			if (pkg.name === '@deviltea/uiux') {
				return dir
			}
		}
		catch {
			// keep searching
		}
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return process.cwd()
}
