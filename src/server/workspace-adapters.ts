import { readFile } from 'node:fs/promises'

import {
	NodeAdapterManifestLoader,
	NodeWorkspaceAdapterModuleResolver,
	resolveWorkspaceAdapterSet,
	type AdapterSetResolutionResult,
	type ValidatedAdapterSet,
} from '../adapters/resolution'
import {
	extractProductAdapterManifest,
	productAdapterApiCompatibility,
	productAdapterRegistryInspector,
} from '../adapters/product-integration'
import {
	buildWorkspacePreviewBundle,
	type PreviewBundleResult,
} from './preview-bundler'
import { validateWorkspaceManifest, type WorkspaceManifest } from '../domain/workspace/schema'
import { detectWorkspaceLayout, resolveWorkspacePath, type WorkspaceLayout } from '../persistence/paths'
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from '../product/workspace-schema'

/**
 * The layout of the selected Workspace: the one given (a caller holding a persistence passes
 * `persistence.layout`), otherwise the one detected from where its manifest is.
 */
async function selectedLayout(workspaceRoot: string, layout: WorkspaceLayout | undefined): Promise<WorkspaceLayout> {
	return layout ?? detectWorkspaceLayout(workspaceRoot, CURRENT_WORKSPACE_SCHEMA_VERSION)
}

export async function readRawWorkspaceManifest(workspaceRoot: string, layout: WorkspaceLayout): Promise<WorkspaceManifest | undefined> {
	try {
		const content = await readFile(resolveWorkspacePath(workspaceRoot, layout.manifestPath), 'utf8')
		const parsed = JSON.parse(content)
		const validation = validateWorkspaceManifest(parsed)
		return validation.ok ? validation.value : undefined
	}
	catch {
		return undefined
	}
}

export async function resolveSelectedWorkspaceAdapters(workspaceRoot: string, givenLayout?: WorkspaceLayout): Promise<AdapterSetResolutionResult> {
	const layout = await selectedLayout(workspaceRoot, givenLayout)
	// From schemaVersion 5 the Adapter list lives in the Product Kit file and resolves from `kit/`
	// (Clauses 01a1144e-538e-705f-afdc-841028c410e4 and 01a115cd-d109-76d3-9622-85d0080c60b6), which
	// this build does not resolve yet: fail closed rather than resolve an empty set.
	if (layout.productKitPath) {
		return {
			state: 'invalid',
			diagnostics: [{
				code: 'adapter.resolution_failed',
				path: '/adapters',
				message: `Adapters of a schemaVersion 5 Workspace are listed in ${layout.productKitPath}, which this UIUX build cannot resolve yet.`,
			}],
			summaries: [],
		}
	}
	const manifest = await readRawWorkspaceManifest(workspaceRoot, layout)
	if (!manifest) {
		return {
			state: 'invalid',
			diagnostics: [{
				code: 'workspace.manifest_missing',
				path: '/workspace',
				message: `Could not read valid workspace manifest from ${layout.manifestPath}.`,
			}],
			summaries: [],
		}
	}

	const adapters = manifest.adapters ?? []
	if (adapters.length === 0) {
		const emptySet: ValidatedAdapterSet = Object.freeze({
			entries: Object.freeze([]),
		}) as unknown as ValidatedAdapterSet
		return {
			state: 'valid',
			diagnostics: [],
			summaries: [],
			set: emptySet,
		}
	}

	return resolveWorkspaceAdapterSet({
		workspaceRoot,
		adapters,
		resolver: new NodeWorkspaceAdapterModuleResolver(),
		loader: new NodeAdapterManifestLoader(extractProductAdapterManifest),
		apiCompatibility: productAdapterApiCompatibility,
		registryInspector: productAdapterRegistryInspector,
	})
}

export async function getSelectedWorkspacePreviewBundle(workspaceRoot: string, layout?: WorkspaceLayout): Promise<
	| (PreviewBundleResult & { state: 'valid' })
	| { state: 'invalid'; diagnostics: readonly unknown[] }
> {
	const resolution = await resolveSelectedWorkspaceAdapters(workspaceRoot, layout)
	if (resolution.state === 'invalid') {
		return { state: 'invalid', diagnostics: resolution.diagnostics }
	}
	const bundle = await buildWorkspacePreviewBundle({
		workspaceRoot,
		set: resolution.set,
	})
	return { state: 'valid', ...bundle }
}
