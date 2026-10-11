import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { declaredKitDependencies, readDeclaredKitDependencies } from '../src/adapters/kit-dependencies'

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) {
		await chmod(join(root, 'kit'), 0o700).catch(() => undefined)
		await chmod(join(root, 'kit', 'package.json'), 0o600).catch(() => undefined)
		await rm(root, { recursive: true, force: true })
	}
})

async function kitDirectory(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-kit-dependencies-')))
	roots.push(root)
	await mkdir(join(root, 'kit'))
	return join(root, 'kit')
}

/** Root reads every file whatever its mode, so the permission cases only hold for other users. */
const runsAsRoot = process.getuid?.() === 0

describe('readDeclaredKitDependencies', () => {
	it('reads the four dependency members, and none without a package file', async () => {
		const kit = await kitDirectory()
		expect(await readDeclaredKitDependencies(kit)).toEqual(new Set())
		await writeFile(join(kit, 'package.json'), JSON.stringify({ dependencies: { a: '1' }, devDependencies: { b: '1' }, peerDependencies: { c: '1' }, optionalDependencies: { d: '1' }, bundleDependencies: ['e'] }))
		expect(await readDeclaredKitDependencies(kit)).toEqual(new Set(['a', 'b', 'c', 'd']))
		expect(declaredKitDependencies(undefined)).toEqual(new Set())
	})

	it.skipIf(runsAsRoot)('reports an unreadable package file without the host path, keeping the read error as the cause', async () => {
		const kit = await kitDirectory()
		await writeFile(join(kit, 'package.json'), JSON.stringify({ dependencies: { a: '1' } }))
		await chmod(join(kit, 'package.json'), 0o000)
		const error = await readDeclaredKitDependencies(kit).then(() => undefined, (caught: unknown) => caught as Error & { cause?: NodeJS.ErrnoException })
		expect(error?.message).toBe('kit/package.json could not be read.')
		expect(error?.message).not.toContain(kit)
		expect(error?.cause?.code).toBe('EACCES')

		// An unreadable kit directory fails the same way at the lstat.
		await chmod(join(kit, 'package.json'), 0o600)
		await chmod(kit, 0o000)
		const denied = await readDeclaredKitDependencies(kit).then(() => undefined, (caught: unknown) => caught as Error & { cause?: NodeJS.ErrnoException })
		expect(denied?.message).toBe('kit/package.json could not be read.')
		expect(denied?.cause?.code).toBe('EACCES')
	})

	it('refuses a package file that is a directory, without the host path', async () => {
		const kit = await kitDirectory()
		await mkdir(join(kit, 'package.json'))
		await expect(readDeclaredKitDependencies(kit)).rejects.toThrow(/^kit\/package\.json is not a regular file\.$/u)
	})
})
