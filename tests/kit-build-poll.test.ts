import { describe, expect, it } from 'vitest'

import { kitBuildSettledOutput } from '../app/composables/useKitBuild'

/**
 * Whether the Workbench re-reads View diagnostics after a kit build poll (issue #323; Discussion #241
 * owner ruling 2026-10-23): on a build leaving `building` or `failed` for `ready`, and on a change of
 * the settled output's `outputVersion`, so a build that starts and finishes between two polls counts.
 */
describe('kitBuildSettledOutput', () => {
	it('follows a build that left building or failed for ready', () => {
		expect(kitBuildSettledOutput({ state: 'building' }, { state: 'ready' })).toBe(true)
		expect(kitBuildSettledOutput({ state: 'failed', message: 'x' }, { state: 'ready' })).toBe(true)
	})

	it('follows a build that started and finished between two polls: ready twice, with a new output version', () => {
		expect(kitBuildSettledOutput({ state: 'ready', outputVersion: '1.1' }, { state: 'ready', outputVersion: '1.2' })).toBe(true)
	})

	it('ignores an unchanged output, the first read, and states that are not ready', () => {
		expect(kitBuildSettledOutput({ state: 'ready', outputVersion: '1.1' }, { state: 'ready', outputVersion: '1.1' })).toBe(false)
		expect(kitBuildSettledOutput({ state: 'ready' }, { state: 'ready' })).toBe(false)
		expect(kitBuildSettledOutput({ state: 'none' }, { state: 'ready', outputVersion: '1.0' })).toBe(false)
		expect(kitBuildSettledOutput(undefined, { state: 'ready', outputVersion: '1.0' })).toBe(false)
		expect(kitBuildSettledOutput({ state: 'ready', outputVersion: '1.1' }, { state: 'building', outputVersion: '1.1' })).toBe(false)
		expect(kitBuildSettledOutput({ state: 'ready', outputVersion: '1.1' }, { state: 'failed', outputVersion: '1.1' })).toBe(false)
	})
})
