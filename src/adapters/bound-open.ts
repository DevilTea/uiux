import { constants } from 'node:fs'
import { readlink, type FileHandle } from 'node:fs/promises'

/**
 * How this platform ties an open file to the path it was opened by, which Node's path-based file
 * API cannot do alone (it has no `openat`, `O_BENEATH` or `F_GETPATH`):
 *
 * - `open` (darwin): the open itself refuses a path with a symbolic link in any component
 *   ({@link NO_FOLLOW}), so an open file opened by a path free of links lies at that path.
 * - `fd` (linux): the open follows links in directories, but `/proc/self/fd/<fd>` names where the
 *   open file lies now ({@link openedFilePath}), which the caller checks after the open.
 * - `none` (other platforms, such as win32): neither exists, so only path checks after the open
 *   remain; a local user who swaps a directory for a link around those checks can defeat them.
 */
export type PathBinding = 'open' | 'fd' | 'none'

export const PATH_BINDING: PathBinding = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'fd' : 'none'

/**
 * The open flag that refuses symbolic links. On darwin `O_NOFOLLOW_ANY` (macOS 11 and later,
 * `<sys/fcntl.h>`), which `fs.constants` does not define: an open whose path holds a symbolic link
 * in any component, the last one included, fails with `ELOOP`; darwin refuses it together with
 * `O_NOFOLLOW` (`EINVAL`), so it replaces that flag. Elsewhere `O_NOFOLLOW`, which refuses only a
 * final link (`0` where undefined, as on win32).
 */
export const NO_FOLLOW: number = PATH_BINDING === 'open' ? 0x2000_0000 : (constants.O_NOFOLLOW ?? 0)

/**
 * Where the open file `handle` lies now, by `/proc/self/fd` (linux only): a path without symbolic
 * links, or `undefined` elsewhere and when it cannot be told (no `/proc`). A file removed since it
 * was opened reads as its former path followed by ` (deleted)`.
 */
export async function openedFilePath(handle: FileHandle): Promise<string | undefined> {
	if (PATH_BINDING !== 'fd') return undefined
	return readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined)
}
