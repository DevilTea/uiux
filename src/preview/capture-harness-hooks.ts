import type { Diagnostic } from '../domain/validation'

/**
 * The hooks the Preview page installs on `window` in formal capture harness mode only
 * (`?harness=formal`), never in a Workbench frame. The Product Kit live-versus-fresh check (Rule
 * 01a11bb1-a7bf-74ae-9639-b39f246fa117) loads the base state, writes a Variant's State into the
 * mounted Runtime in place through `applyVariantStateLive`, and captures once it has rendered.
 */
export const CAPTURE_HARNESS_GLOBAL = '__UIUX_CAPTURE_HARNESS__'

export type CaptureHarnessHooks = Readonly<{
	/** Resolves after the write has rendered (a Vue tick and two animation frames), with its diagnostics. */
	applyVariantStateLive(variantName: string): Promise<readonly Diagnostic[]>
}>
