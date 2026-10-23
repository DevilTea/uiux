import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { hostname, uptime } from 'node:os'

/*
 * Boot-time staleness of the host locks and holds (owner ruling 2026-10-23,
 * https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19145490): no process from an
 * earlier boot of this host still runs, so a lock or hold it left is stale whatever pid or bytes it
 * records. This clears a lock whose recorded pid now belongs to another process and an empty or
 * partial lock left by a crash. The persistence lock, the roster lock and the server hold use it.
 *
 * Boot identity belongs to a kernel, so it only applies to a record of this host: a record naming
 * another `hostname` (a Workspace bind-mounted into a container, or shared over NFS) is never stale
 * by boot, and each lock treats it as its own other-host case.
 *
 * For a record of this host, the decision prefers the boot session identifier, which no clock
 * change affects: when both the record and the checking process have one, the record is from
 * another boot exactly when they differ. Otherwise (an empty, partial or older record, a platform
 * without an identifier, or a process that could not read its own) it falls back to comparing the
 * file's modification time with the boot time.
 */

/**
 * How much earlier than the current boot a file's modification time must be before the fallback
 * calls it stale. It absorbs coarse modification times (2 s on FAT, 1 s on HFS+ and ext3), a boot
 * time that some platforms report in whole seconds, and small clock adjustments.
 */
export const BOOT_STALENESS_TOLERANCE_MS = 5_000

/** How long a failed boot identifier read is remembered before the next call reads again. */
export const BOOT_ID_RETRY_COOLDOWN_MS = 60_000

const BOOT_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu

type BootIdSource = Readonly<{
	read: () => Promise<string | undefined>
	/** A monotonic clock in milliseconds, for the retry cooldown. */
	now: () => number
}>

const DEFAULT_SOURCE: BootIdSource = { read: readPlatformBootId, now: () => performance.now() }
let source: BootIdSource = DEFAULT_SOURCE
let known: string | undefined
let pending: Promise<string | undefined> | undefined
let failedAt: number | undefined
/** Bumped by a reset, so a read started before it never lands in the state after it. */
let generation = 0

/**
 * This host's boot session identifier: Linux's `/proc/sys/kernel/random/boot_id`, macOS's
 * `kern.bootsessionuuid` (one `sysctl` run), undefined elsewhere or when it cannot be read. A
 * successful read is kept for the process; a failed one is remembered for
 * {@link BOOT_ID_RETRY_COOLDOWN_MS} and then read again.
 */
export function currentBootId(): Promise<string | undefined> {
	if (known !== undefined) return Promise.resolve(known)
	if (pending) return pending
	if (failedAt !== undefined && source.now() - failedAt < BOOT_ID_RETRY_COOLDOWN_MS) return Promise.resolve(undefined)
	const started = generation
	const reading = source.read().then(normalizeBootId, () => undefined).then((id) => {
		if (started !== generation) return id
		pending = undefined
		if (id === undefined) failedAt = source.now()
		else known = id
		return id
	})
	pending = reading
	return reading
}

/**
 * Test-only: replaces how the boot identifier is read (and the cooldown's clock) and forgets what
 * was read; without an argument it restores the platform reader.
 */
export function resetBootIdForTests(replacement?: Partial<BootIdSource>): void {
	source = { ...DEFAULT_SOURCE, ...replacement }
	generation += 1
	known = undefined
	pending = undefined
	failedAt = undefined
}

function normalizeBootId(value: string | undefined): string | undefined {
	const id = value?.trim().toLowerCase()
	return id && BOOT_ID.test(id) ? id : undefined
}

async function readPlatformBootId(): Promise<string | undefined> {
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
 * Whether a lock record names a host other than this one. A record without a `hostname` (empty,
 * partial or older) does not.
 */
export function recordedOnAnotherHost(record: unknown, currentHost: string = hostname()): boolean {
	if (typeof record !== 'object' || record === null) return false
	const recorded = (record as { hostname?: unknown }).hostname
	return typeof recorded === 'string' && recorded !== currentHost
}

/**
 * Whether a lock or hold record belongs to an earlier boot of this host. `record` is the parsed
 * record, or undefined when its bytes are empty or unreadable; `stats` is the file's, read from the
 * same open file. A record of another host is never from an earlier boot of this one, and a record
 * whose `bootId` equals `currentId` is never stale by boot, whatever its modification time says.
 */
export function isFromEarlierBoot(
	record: unknown,
	stats: Readonly<{ mtimeMs: number }>,
	currentId: string | undefined,
	bootTimeMs?: number,
): boolean {
	if (recordedOnAnotherHost(record)) return false
	const recorded = recordedBootId(record)
	if (recorded !== undefined && currentId !== undefined) return recorded !== currentId
	return predatesCurrentBoot(stats, bootTimeMs)
}

function recordedBootId(record: unknown): string | undefined {
	if (typeof record !== 'object' || record === null) return undefined
	const value = (record as { bootId?: unknown }).bootId
	return typeof value === 'string' && BOOT_ID.test(value) ? value.toLowerCase() : undefined
}
