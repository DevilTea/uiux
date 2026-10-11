import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { runMigrateCommand } from '../src/cli/migrate'
import { readActiveServerHold } from '../src/persistence/server-hold'
import { V5_TEST_SCHEMA_POLICY } from './support/workspace-layout'

vi.mock('../src/persistence/server-hold', async importOriginal => ({
	...await importOriginal<typeof import('../src/persistence/server-hold')>(),
	readActiveServerHold: vi.fn(),
}))

const roots: string[] = []
afterEach(async () => {
	vi.mocked(readActiveServerHold).mockReset()
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('uiux migrate and a server that starts after the first check', () => {
	it('re-checks the server hold under the migration\'s lock and refuses before the Checkpoint or any move', async () => {
		const parent = await realpath(await mkdtemp(join(tmpdir(), 'uiux-migrate-late-hold-')))
		roots.push(parent)
		await mkdir(join(parent, '.uiux'))
		await mkdir(join(parent, 'views'))
		const manifest = JSON.stringify({ schemaVersion: 4, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
		await writeFile(join(parent, '.uiux', 'workspace.json'), manifest)
		// The first check finds no server; the one under the lock finds the server that started meanwhile.
		vi.mocked(readActiveServerHold)
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce({ pid: 4242, hostname: hostname(), startedAt: '2026-10-11T00:00:00.000Z', token: 'late' })
		const errors: string[] = []
		const home = join(parent, 'home')
		expect(await runMigrateCommand({ workspaceRoot: parent, dryRun: false, home, schemaPolicy: V5_TEST_SCHEMA_POLICY, stdout: () => undefined, stderr: line => errors.push(line) })).toBe(1)
		expect(errors.join('\n')).toContain('a UIUX server (pid 4242')
		expect(vi.mocked(readActiveServerHold)).toHaveBeenCalledTimes(2)
		expect(await readFile(join(parent, '.uiux', 'workspace.json'), 'utf8')).toBe(manifest)
		expect((await readdir(parent)).sort()).toEqual(['.uiux', 'views'])
		expect((await readdir(join(parent, '.uiux'))).filter(name => !name.startsWith('.persistence'))).toEqual(['workspace.json'])
	})
})
