/**
 * The kit build as the application layer sees it (Feature 01a11bb1-8534-7f0f-b8d0-de7efabe31f7):
 * the server's build runner (`src/server/kit-build.ts`) implements it under `uiux dev`. No method
 * takes a command or an argument: only host files decide what a build runs (Rule
 * 01a11bb1-9d17-7205-abee-c2aa7058c107).
 */

/** The build state (Clause 01a11bb1-8856-737f-945c-e44c596f7782). */
export type KitBuildState = 'none' | 'building' | 'ready' | 'failed'

export type KitBuildStatus = Readonly<{
	state: KitBuildState
	/** Why the last run failed, naming no host path. */
	message?: string
}>

export interface KitBuildControl {
	status(): KitBuildStatus
	/**
	 * Stops the running build process, if any, and starts the Workspace's kit build again, reading
	 * its declaration anew (Clause 01a11be8-5b64-72b3-ad18-81994368a1ed). Resolves once the new run
	 * has started (or found nothing to run).
	 */
	restart(): Promise<KitBuildStatus>
	/** The build log (Clause 01a11bb1-891e-7fa5-bf48-4c459fd60d11) with host paths masked. */
	log(): string
}
