import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Every test run gets a private `UIUX_HOME`, so no test (or server a test spawns, which inherits
 * `process.env`) can ever read or write the developer's real `~/.uiux` access rosters.
 */
export default function setup(): () => void {
	const home = mkdtempSync(join(tmpdir(), 'uiux-test-home-'))
	process.env.UIUX_HOME = home
	return () => rmSync(home, { recursive: true, force: true })
}
