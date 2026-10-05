import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Reports whether the volume holding `directory` distinguishes file names that
 * differ only by letter case. Default macOS (APFS/HFS+) and Windows volumes are
 * case-insensitive; typical Linux CI volumes are case-sensitive.
 */
export async function isCaseSensitiveDirectory(directory: string): Promise<boolean> {
	const probeRoot = await mkdtemp(join(directory, 'uiux-case-probe-'))
	try {
		await writeFile(join(probeRoot, 'case-probe'), '')
		try {
			await stat(join(probeRoot, 'CASE-PROBE'))
			return false
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
			throw error
		}
	}
	finally {
		await rm(probeRoot, { recursive: true, force: true })
	}
}
