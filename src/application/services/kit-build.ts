import type { Diagnostic } from '../../domain/validation'
import { PRODUCT_KIT_RESOURCE_KEY } from '../../domain/product-kit/schema'
import type { KitBuildControl, KitBuildStatus } from '../ports/kit-build'

/**
 * The kit build operations of a Workspace (Feature 01a11bb1-8534-7f0f-b8d0-de7efabe31f7):
 * its build state (`workspace.read`, Clause 01a11bb1-b3c2-7937-96fb-e139c5e566f5), its build log
 * (`product-kit.source.read`) and `restart_kit_build` (`product-kit.write`, Clauses
 * 01a11be8-5b64-72b3-ad18-81994368a1ed and 01a11bb1-b35a-7e69-bba5-978e3f47c4fa), refused with
 * `kit.build_restart_throttled` within the minimum interval after the previous restart (Clause
 * 01a12f9a-ef7c-7d41-86ac-2f2b3f1acd8a). The keys are the
 * scoped session's. No operation takes a command or an argument (Rule 01a11bb1-9d17-7205-abee-c2aa7058c107).
 */
type Key = typeof PRODUCT_KIT_RESOURCE_KEY
type RestartBlockedCode = 'kit.build_unavailable' | 'kit.build_restart_throttled'

export type KitBuildRead = Readonly<{ key: Key; build: KitBuildStatus }>
export type KitBuildLogRead = Readonly<{ key: Key; log: string }>

export type RestartKitBuildResult =
	| Readonly<{ status: 'restarted'; key: Key; build: KitBuildStatus }>
	/** `kit/package.json` declares no build: nothing was started. */
	| Readonly<{ status: 'no_build'; key: Key; build: KitBuildStatus; message: string }>
	| Readonly<{ status: 'blocked'; key: Key; code: RestartBlockedCode; message: string; diagnostics: readonly Diagnostic[] }>

export type KitBuildService = Readonly<{
	readKitBuild(): KitBuildRead
	readKitBuildLog(): KitBuildLogRead
	restartKitBuild(): Promise<RestartKitBuildResult>
}>

const KEY: Key = PRODUCT_KIT_RESOURCE_KEY

export function createKitBuildService(control: KitBuildControl | undefined): KitBuildService {
	function blocked(code: RestartBlockedCode, message: string): RestartKitBuildResult {
		return { status: 'blocked', key: KEY, code, message, diagnostics: [{ code, path: '/', message }] }
	}

	return Object.freeze({
		readKitBuild: () => ({ key: KEY, build: control?.status() ?? { state: 'none' } }),
		readKitBuildLog: () => ({ key: KEY, log: control?.log() ?? '' }),
		async restartKitBuild(): Promise<RestartKitBuildResult> {
			if (!control)
				return blocked('kit.build_unavailable', 'No kit build runs in this process; uiux dev runs it.')
			const restarted = await control.restart()
			if (restarted.outcome === 'throttled')
				return blocked('kit.build_restart_throttled', `The kit build was restarted moments ago; restarts are at least 2 s apart. Try again in ${Math.ceil(restarted.retryAfterMs / 1000)} s.`)
			if (restarted.outcome === 'stopped')
				return blocked('kit.build_unavailable', 'The kit build was stopped, as the server stops, so the restart started nothing.')
			const build = restarted.build
			if (build.state === 'none')
				return { status: 'no_build', key: KEY, build, message: 'kit/package.json declares no build (uiux.build), so nothing was started.' }
			return { status: 'restarted', key: KEY, build }
		},
	})
}
