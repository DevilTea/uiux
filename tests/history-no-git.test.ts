import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

const repositoryRoot = join(import.meta.dirname, '..')

/** Every source file that implements version history (domain, stores, hooks, their server factory, the recorder and the history API). */
const HISTORY_SOURCES = [
	'src/domain/history',
	'src/persistence/history',
	'src/server/history-stores.ts',
	'src/application/services/history-recorder.ts',
	'src/application/services/history-diff.ts',
	'src/application/services/history-service.ts',
	'src/server/history-http.ts',
	'server/api/history',
]

/**
 * Rule 01a11a5e-0539-7a33-a000-55adde1f72b8: history never runs Git, reads `.git`, writes the
 * user's branches or refs, or records a Git commit. The history code must not even reach for a
 * process runner or a Git library.
 */
const FORBIDDEN = [
	{ pattern: /child_process/u, reason: 'spawns processes' },
	{ pattern: /\bexeca\b|\bzx\b/u, reason: 'spawns processes' },
	{ pattern: /isomorphic-git|simple-git|nodegit|@napi-rs\/git/u, reason: 'uses a Git library' },
	{ pattern: /\bgit\b/u, reason: 'names the git command' },
	{ pattern: /(?:^|['"`/\\])\.git(?:\b|\/)/u, reason: 'touches a .git path' },
	{ pattern: /\brefs\/heads\b|\bHEAD\b/u, reason: 'names Git refs' },
]

async function sourceFiles(path: string): Promise<string[]> {
	const absolute = join(repositoryRoot, path)
	if (absolute.endsWith('.ts')) return [absolute]
	const entries = await readdir(absolute, { withFileTypes: true, recursive: true })
	return entries.filter(entry => entry.isFile() && entry.name.endsWith('.ts')).map(entry => join(entry.parentPath, entry.name))
}

describe('history uses no Git', () => {
	it('keeps every history source free of process runners, Git libraries, git commands and .git paths', async () => {
		const files = (await Promise.all(HISTORY_SOURCES.map(sourceFiles))).flat()
		expect(files.map(file => relative(repositoryRoot, file))).toEqual(expect.arrayContaining([
			'src/domain/history/schema.ts',
			'src/persistence/history/host-store.ts',
			'src/persistence/history/checkpoint-store.ts',
			'src/persistence/history/timeline.ts',
			'src/persistence/history/retention.ts',
			'src/server/history-stores.ts',
			'src/application/services/history-recorder.ts',
			'src/application/services/history-service.ts',
			'src/server/history-http.ts',
			'server/api/history/checkpoints.post.ts',
			'server/api/history/versions.get.ts',
		]))
		const violations: string[] = []
		for (const file of files) {
			const text = await readFile(file, 'utf8')
			for (const { pattern, reason } of FORBIDDEN)
				if (pattern.test(text)) violations.push(`${relative(repositoryRoot, file)} ${reason} (${pattern})`)
		}
		expect(violations).toEqual([])
	})
})
