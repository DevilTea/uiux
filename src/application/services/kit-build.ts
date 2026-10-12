import type { Diagnostic } from '../../domain/validation'
import { PRODUCT_KIT_RESOURCE_KEY, PRODUCT_KIT_SCHEMA_VERSION } from '../../domain/product-kit/schema'
import type { FileNativePersistence } from '../../persistence'
import type { KitBuildControl, KitBuildStatus } from '../ports/kit-build'

/**
 * The kit build operations of a `schemaVersion` 5 Workspace (Feature 01a11bb1-8534-7f0f-b8d0-de7efabe31f7):
 * its build state (`workspace.read`, Clause 01a11bb1-b3c2-7937-96fb-e139c5e566f5), its build log
 * (`product-kit.source.read`) and `restart_kit_build` (`product-kit.write`, Clauses
 * 01a11be8-5b64-72b3-ad18-81994368a1ed and 01a11bb1-b35a-7e69-bba5-978e3f47c4fa). The keys are the
 * scoped session's. No operation takes a command or an argument (Rule 01a11bb1-9d17-7205-abee-c2aa7058c107).
 */
type Key = typeof PRODUCT_KIT_RESOURCE_KEY

export type KitBuildRead = Readonly<{ key: Key; build: KitBuildStatus }>
export type KitBuildLogRead = Readonly<{ key: Key; log: string }>

export type RestartKitBuildResult =
	| Readonly<{ status: 'restarted'; key: Key; build: KitBuildStatus }>
	/** `kit/package.json` declares no build: nothing was started. */
	| Readonly<{ status: 'no_build'; key: Key; build: KitBuildStatus; message: string }>
	| Readonly<{ status: 'blocked'; key: Key; code: 'workspace.migration_required' | 'kit.build_unavailable'; message: string; diagnostics: readonly Diagnostic[] }>

export type KitBuildService = Readonly<{
	/** The build state, or `undefined` below `schemaVersion` 5, where there is no kit project. */
	readKitBuild(): KitBuildRead | undefined
	readKitBuildLog(): KitBuildLogRead | undefined
	restartKitBuild(): Promise<RestartKitBuildResult>
}>

const KEY: Key = PRODUCT_KIT_RESOURCE_KEY

export function createKitBuildService(persistence: FileNativePersistence, control: KitBuildControl | undefined): KitBuildService {
	const hasKit = () => persistence.layout.productKitPath !== undefined && persistence.layout.codeDir !== undefined

	function blocked(code: 'workspace.migration_required' | 'kit.build_unavailable', message: string): RestartKitBuildResult {
		return { status: 'blocked', key: KEY, code, message, diagnostics: [{ code, path: '/', message }] }
	}

	return Object.freeze({
		readKitBuild: () => hasKit() ? { key: KEY, build: control?.status() ?? { state: 'none' } } : undefined,
		readKitBuildLog: () => hasKit() ? { key: KEY, log: control?.log() ?? '' } : undefined,
		async restartKitBuild(): Promise<RestartKitBuildResult> {
			if (!hasKit())
				return blocked('workspace.migration_required', `The kit build exists from Workspace schemaVersion ${PRODUCT_KIT_SCHEMA_VERSION}. Run: uiux migrate --workspace <dir>`)
			if (!control)
				return blocked('kit.build_unavailable', 'No kit build runs in this process; uiux dev runs it.')
			const build = await control.restart()
			if (build.state === 'none')
				return { status: 'no_build', key: KEY, build, message: 'kit/package.json declares no build (uiux.build), so nothing was started.' }
			return { status: 'restarted', key: KEY, build }
		},
	})
}
