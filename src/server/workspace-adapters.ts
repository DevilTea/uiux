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
import { LEGACY_LAYOUT, resolveWorkspacePath, type WorkspaceLayout } from '../persistence/paths'

export async function readRawWorkspaceManifest(workspaceRoot: string, layout: WorkspaceLayout = LEGACY_LAYOUT): Promise<WorkspaceManifest | undefined> {
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

export async function resolveSelectedWorkspaceAdapters(workspaceRoot: string, layout: WorkspaceLayout = LEGACY_LAYOUT): Promise<AdapterSetResolutionResult> {
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

export async function getSelectedWorkspacePreviewBundle(workspaceRoot: string): Promise<
	| (PreviewBundleResult & { state: 'valid' })
	| { state: 'invalid'; diagnostics: readonly unknown[] }
> {
	const resolution = await resolveSelectedWorkspaceAdapters(workspaceRoot)
	if (resolution.state === 'invalid') {
		return { state: 'invalid', diagnostics: resolution.diagnostics }
	}
	const bundle = await buildWorkspacePreviewBundle({
		workspaceRoot,
		set: resolution.set,
	})
	return { state: 'valid', ...bundle }
}
