import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { uptime } from 'node:os'

/*
 * Boot-time staleness of the host locks and holds (owner ruling 2026-10-23,
 * https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19145490): no process from an
 * earlier boot of this host still runs, so a lock or hold it left is stale whatever pid or bytes it
 * records. This clears a lock whose recorded pid now belongs to another process and an empty or
 * partial lock left by a crash. The persistence lock, the roster lock and the server hold use it.
 *
 * The decision prefers the host's boot session identifier, which no clock change affects: a record
 * that carries one is from another boot exactly when it differs from the current one. Only a record
 * without one (empty, partial, written by an older build, or on a platform without an identifier),
 * or a process that cannot read the current one, falls back to comparing the file's modification
 * time with the boot time.
 */

/**
 * How much earlier than the current boot a file's modification time must be before the fallback
 * calls it stale. It absorbs coarse modification times (2 s on FAT, 1 s on HFS+ and ext3), a boot
 * time that some platforms report in whole seconds, and small clock adjustments.
 */
export const BOOT_STALENESS_TOLERANCE_MS = 5_000

const BOOT_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu

let bootIdOnce: Promise<string | undefined> | undefined

/**
 * This host's boot session identifier, read once per process and cached: Linux's
 * `/proc/sys/kernel/random/boot_id`, macOS's `kern.bootsessionuuid` (one `sysctl` run), undefined
 * elsewhere or when it cannot be read.
 */
export function currentBootId(): Promise<string | undefined> {
	bootIdOnce ??= readBootId().then(value => {
		const id = value?.trim().toLowerCase()
		return id && BOOT_ID.test(id) ? id : undefined
	}, () => undefined)
	return bootIdOnce
}

async function readBootId(): Promise<string | undefined> {
	if (process.platform === 'linux') return readFile('/proc/sys/kernel/random/boot_id', 'utf8')
	if (process.platform === 'darwin') {
		return new Promise(resolveId => {
			execFile('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 2_000 }, (error, stdout) => {
				resolveId(error ? undefined : stdout)
			})
		})
	}
	return undefined
}

/**
 * This host's current boot as wall-clock milliseconds. `os.uptime()` counts time spent asleep or
 * suspended (libuv reads `/proc/uptime` or `CLOCK_BOOTTIME` on Linux and `kern.boottime` on macOS), so
 * the value does not drift forward while the host sleeps; a wall-clock step moves it, though.
 */
export function currentBootTimeMs(): number {
	return Date.now() - uptime() * 1000
}

/**
 * The fallback: whether a file was last written before this host's current boot, by more than
 * {@link BOOT_STALENESS_TOLERANCE_MS}. A file written after boot is never stale by it unless the
 * wall clock has since jumped forward by more than the tolerance, which is why a recorded boot
 * identifier takes precedence.
 */
export function predatesCurrentBoot(stats: Readonly<{ mtimeMs: number }>, bootTimeMs: number = currentBootTimeMs()): boolean {
	return stats.mtimeMs < bootTimeMs - BOOT_STALENESS_TOLERANCE_MS
}

/**
 * Whether a lock or hold record belongs to an earlier boot of this host. `record` is the parsed
 * record, or undefined when its bytes are empty or unreadable; `stats` is the file's, read from the
 * same open file. A record whose `bootId` equals `currentId` is never stale by boot, whatever its
 * modification time says.
 */
export function isFromEarlierBoot(
	record: unknown,
	stats: Readonly<{ mtimeMs: number }>,
	currentId: string | undefined,
	bootTimeMs?: number,
): boolean {
	const recorded = recordedBootId(record)
	if (recorded !== undefined && currentId !== undefined) return recorded !== currentId
	return predatesCurrentBoot(stats, bootTimeMs)
}

function recordedBootId(record: unknown): string | undefined {
	if (typeof record !== 'object' || record === null) return undefined
	const value = (record as { bootId?: unknown }).bootId
	return typeof value === 'string' && BOOT_ID.test(value) ? value.toLowerCase() : undefined
}
