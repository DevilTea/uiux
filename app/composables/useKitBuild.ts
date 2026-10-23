import { readonly, shallowRef } from 'vue'

import type { KitBuildStatus } from '../../src/application/ports/kit-build'

/**
 * The kit build state (Clause 01a11bb1-8856-737f-945c-e44c596f7782), as `GET /api/product-kit/build`
 * returns it (`workspace.read`). The change-event stream names no kit build state (Clause
 * 01a114ec-e839-7b11-957c-41c88b692e12), so the Workbench polls it while the shell is mounted. A
 * failed read, such as a member without the key, reads as `none`.
 */
const build = shallowRef<KitBuildStatus>({ state: 'none' })
let timer: ReturnType<typeof setInterval> | undefined
let subscribers = 0
export const KIT_BUILD_POLL_MS = 5000

/**
 * Whether `next` follows a build that settled a new output since `previous`: its `outputVersion` changed
 * (so a build that started and finished between two polls counts), or it left `building` or `failed` for
 * `ready` (a build that has no version).
 */
export function kitBuildSettledOutput(previous: KitBuildStatus | undefined, next: KitBuildStatus): boolean {
	if (!previous || next.state !== 'ready') return false
	if (previous.outputVersion !== undefined && next.outputVersion !== undefined && next.outputVersion !== previous.outputVersion) return true
	return previous.state === 'building' || previous.state === 'failed'
}

async function refresh(): Promise<void> {
	try {
		const read = await $fetch<{ build: KitBuildStatus }>('/api/product-kit/build')
		build.value = read.build
	}
	catch {
		build.value = { state: 'none' }
	}
}

export function useKitBuild() {
	/** Starts (reference-counted) polling; returns the stop function. */
	function watch(): () => void {
		subscribers += 1
		if (subscribers === 1) {
			void refresh()
			timer = setInterval(() => { void refresh() }, KIT_BUILD_POLL_MS)
		}
		let stopped = false
		return () => {
			if (stopped) return
			stopped = true
			subscribers -= 1
			if (subscribers === 0 && timer) {
				clearInterval(timer)
				timer = undefined
			}
		}
	}
	return { build: readonly(build), refresh, watch }
}
