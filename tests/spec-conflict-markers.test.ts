import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `spec workspace validate` parses the front matter and Gherkin of `.spec/` but not the Markdown
 * bodies, so a merge that leaves a Git conflict marker in a body passes it. This guards the bodies
 * (and every other `.spec/` file) against a stray `<<<<<<<`, `=======` or `>>>>>>>` line.
 */
const SPEC_ROOT = join(import.meta.dirname, '..', '.spec')
const CONFLICT_MARKER = /^(?:<{7}|={7}|>{7})(?: |$)/

function specFiles(directory: string): string[] {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name)
		return statSync(path).isDirectory() ? specFiles(path) : [path]
	})
}

describe('.spec/ files', () => {
	it('contain no Git conflict markers', () => {
		const found = specFiles(SPEC_ROOT).flatMap(file => readFileSync(file, 'utf8')
			.split('\n')
			.flatMap((line, index) => CONFLICT_MARKER.test(line) ? [`${relative(SPEC_ROOT, file)}:${index + 1}`] : []))
		expect(found).toEqual([])
	})
})
