import { uptime } from 'node:os'

/**
 * How much earlier than the current boot a file's modification time must be before
 * {@link predatesCurrentBoot} calls it stale. It absorbs coarse modification times (2 s on FAT,
 * 1 s on HFS+ and ext3), a boot time that some platforms report in whole seconds, and small clock
 * adjustments, so a file written just after boot is never taken for one written before it.
 */
export const BOOT_STALENESS_TOLERANCE_MS = 5_000

/**
 * This host's current boot as wall-clock milliseconds. `os.uptime()` counts time spent asleep or
 * suspended (libuv reads `/proc/uptime` or `CLOCK_BOOTTIME` on Linux and `kern.boottime` on macOS), so
 * the value does not drift forward while the host sleeps.
 */
export function currentBootTimeMs(): number {
	return Date.now() - uptime() * 1000
}

/**
 * Whether a host lock or hold file was last written before this host's current boot, by more than
 * {@link BOOT_STALENESS_TOLERANCE_MS}. No process from an earlier boot is still running, so such a
 * file is stale whatever it records (owner ruling 2026-10-23,
 * https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19145490): this clears a lock
 * whose recorded pid now belongs to another process and an empty or partial lock left by a crash.
 * The persistence lock, the roster lock and the server hold all use it.
 *
 * A file written after boot is never stale by this rule, as long as the wall clock has not jumped
 * forward by more than the tolerance between that write and the check (a large clock step soon after
 * boot, for example a first NTP sync on a host without a real-time clock, moves the computed boot
 * time with it).
 */
export function predatesCurrentBoot(stats: Readonly<{ mtimeMs: number }>, bootTimeMs: number = currentBootTimeMs()): boolean {
	return stats.mtimeMs < bootTimeMs - BOOT_STALENESS_TOLERANCE_MS
}
