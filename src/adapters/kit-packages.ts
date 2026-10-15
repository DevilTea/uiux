import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isRecord } from '../domain/validation'
import { bareSpecifierPackageName } from './kit-dependencies'
import { containedRealPath, type KitProject } from './kit-registry'

/**
 * An external package of the kit project as Node module resolution finds it inside the Workspace:
 * `resolved` with the version its `package.json` names, if any, and `linked` when the lookup went
 * through a symbolic link, or `missing`.
 */
export type KitPackage = Readonly<{ package: string; status: 'resolved'; version?: string; linked: boolean } | { package: string; status: 'missing' }>

/**
 * An external package as Node module resolution finds it inside the Workspace: the first
 * `node_modules/<name>/package.json` in `kit/` or the Workspace root. `linked` marks a package
 * directory reached through a symbolic link (Clause 01a11bb1-8b6e-7185-b0ac-cb84c3fcc24a).
 *
 * A link on the way (`node_modules` itself, a scope directory or the package directory) whose
 * target lies outside the Workspace, or does not resolve, ends the lookup there: the package is
 * reported as `resolved` and `linked` with no version, whether or not anything exists behind the
 * link, so nothing outside the Workspace is read or told apart.
 */
export async function resolveKitPackage(project: KitProject, name: string): Promise<KitPackage> {
	if (!project.directory) return { package: name, status: 'missing' }
	const segments = name.split('/')
	for (const directory of [project.directory, project.realRoot]) {
		const layers = await packageLinkLayers(project, directory, segments)
		if (layers === 'outside') return { package: name, status: 'resolved', linked: true }
		if (layers === 'absent') continue
		const linked = layers === 'linked'
		const real = await containedRealPath(project.realRoot, join(directory, 'node_modules', ...segments))
		if (real === undefined) continue
		const manifestPath = await containedRealPath(project.realRoot, join(real, 'package.json'))
		const manifest = manifestPath === undefined ? undefined : await readFile(manifestPath, 'utf8').catch(() => undefined)
		if (manifest === undefined) continue
		let version: string | undefined
		try {
			const parsed: unknown = JSON.parse(manifest)
			if (isRecord(parsed) && typeof parsed.version === 'string') version = parsed.version
		}
		catch { /* an unreadable package.json names no version */ }
		return { package: name, status: 'resolved', ...(version ? { version } : {}), linked }
	}
	return { package: name, status: 'missing' }
}

/**
 * The layers on the way to `<directory>/node_modules/<segments>` (`node_modules` itself, a scope
 * directory, the package directory): `outside` when one is a link whose target lies outside the
 * Workspace or does not resolve (the lookup ends there), else `absent` when one is missing, else
 * `linked` or `plain` by whether one is a link.
 */
async function packageLinkLayers(project: KitProject, directory: string, segments: readonly string[]): Promise<'outside' | 'absent' | 'linked' | 'plain'> {
	let linked = false
	for (let index = 0; index <= segments.length; index++) {
		const path = join(directory, 'node_modules', ...segments.slice(0, index))
		const info = await lstat(path).catch(() => undefined)
		if (!info) return 'absent'
		if (info.isSymbolicLink()) {
			linked = true
			if (await containedRealPath(project.realRoot, path) === undefined) return 'outside'
		}
	}
	return linked ? 'linked' : 'plain'
}

/**
 * Whether Node module resolution of the bare Adapter specifier `specifier` from `kit/` meets an
 * outside or dangling link on the way to its package (as `resolveKitPackage` looks it up) before it
 * finds the package inside the Workspace.
 */
export async function bareAdapterLeavesWorkspace(project: KitProject, specifier: string): Promise<boolean> {
	const name = bareSpecifierPackageName(specifier)
	if (!project.directory || name === undefined) return false
	const segments = name.split('/')
	for (const directory of [project.directory, project.realRoot]) {
		const layers = await packageLinkLayers(project, directory, segments)
		if (layers === 'outside') return true
		if (layers !== 'absent' && await containedRealPath(project.realRoot, join(directory, 'node_modules', ...segments, 'package.json')) !== undefined) return false
	}
	return false
}
