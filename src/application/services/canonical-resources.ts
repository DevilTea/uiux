// Scheduled for deletion together with resource-mutations.ts when issue #75 lands.
import type { AuthoredAssetResource } from '../../domain/assets/schema'
import { validateAuthoredAssetResource } from '../../domain/assets/schema'
import type { FlowResource } from '../../domain/flows/schema'
import { validateFlowResource } from '../../domain/flows/schema'
import type { ViewResource } from '../../domain/views/schema'
import { validateViewResource } from '../../domain/views/schema'
import type { Diagnostic, ValidationResult } from '../../domain/validation'
import type {
	MutableResourceRepository,
	ReferenceImpactAnalyzer,
	ResourceDiagnosticPort,
	ResourceTransitionValidationPort,
	ResourceValidationPort,
} from '../ports/resources'
import {
	createResourceService,
	type ResourceMutationCommand,
	type ResourceMutationResult,
	type ResourceReadResult,
} from './resource-mutations'

export type ViewKey = string
export type FlowKey = string
export type AssetKey = string

export type ViewApplicationService<Impact> = Readonly<{
	readView(key: ViewKey): Promise<ResourceReadResult<ViewResource> | undefined>
	mutateView(command: ResourceMutationCommand<ViewKey, ViewResource>): Promise<ResourceMutationResult<ViewKey, Impact>>
}>
export type FlowApplicationService<Impact> = Readonly<{
	readFlow(key: FlowKey): Promise<ResourceReadResult<FlowResource> | undefined>
	mutateFlow(command: ResourceMutationCommand<FlowKey, FlowResource>): Promise<ResourceMutationResult<FlowKey, Impact>>
}>
export type AssetApplicationService<Impact> = Readonly<{
	readAsset(key: AssetKey): Promise<ResourceReadResult<AuthoredAssetResource> | undefined>
	mutateAsset(command: ResourceMutationCommand<AssetKey, AuthoredAssetResource>): Promise<ResourceMutationResult<AssetKey, Impact>>
}>

function validationPort<Resource>(validate: (resource: Resource) => ValidationResult<Resource>): ResourceValidationPort<Resource> {
	return { validate(resource) { const result = validate(resource); return result.ok ? [] : result.diagnostics } }
}

function immutableIdTransition<Resource extends Readonly<{ id: string }>>(code: string, label: string): ResourceTransitionValidationPort<Resource> {
	return {
		validate({ current, next }) {
			const diagnostics: Diagnostic[] = []
			if (current.id !== next.id) diagnostics.push({ code, path: '/id', message: `${label} id is immutable.` })
			return diagnostics
		},
	}
}

export function createViewService<Impact>(input: Readonly<{
	repository: MutableResourceRepository<ViewKey, ViewResource>
	diagnostics?: ResourceDiagnosticPort<ViewKey, ViewResource>
	impact: ReferenceImpactAnalyzer<ViewKey, ViewResource, Impact>
}>): ViewApplicationService<Impact> {
	const service = createResourceService<ViewKey, ViewResource, Impact>({
		...input,
		validation: validationPort(resource => validateViewResource(resource)),
		transitionValidation: immutableIdTransition('view.immutable_id_changed', 'View'),
	})
	return { readView: service.read, mutateView: service.mutate }
}

export function createFlowService<Impact>(input: Readonly<{
	repository: MutableResourceRepository<FlowKey, FlowResource>
	diagnostics?: ResourceDiagnosticPort<FlowKey, FlowResource>
	impact: ReferenceImpactAnalyzer<FlowKey, FlowResource, Impact>
}>): FlowApplicationService<Impact> {
	const service = createResourceService<FlowKey, FlowResource, Impact>({
		...input,
		validation: validationPort(resource => validateFlowResource(resource)),
		transitionValidation: immutableIdTransition('flow.immutable_id_changed', 'Flow'),
	})
	return { readFlow: service.read, mutateFlow: service.mutate }
}

export function createAssetService<Impact>(input: Readonly<{
	repository: MutableResourceRepository<AssetKey, AuthoredAssetResource>
	diagnostics?: ResourceDiagnosticPort<AssetKey, AuthoredAssetResource>
	impact: ReferenceImpactAnalyzer<AssetKey, AuthoredAssetResource, Impact>
}>): AssetApplicationService<Impact> {
	const service = createResourceService<AssetKey, AuthoredAssetResource, Impact>({
		...input,
		validation: validationPort(resource => validateAuthoredAssetResource(resource)),
		transitionValidation: {
			validate({ current, next }) {
				return current.metadata.id === next.metadata.id
					? []
					: [{ code: 'asset.immutable_id_changed', path: '/metadata/id', message: 'Asset id is immutable.' }]
			},
		},
	})
	return { readAsset: service.read, mutateAsset: service.mutate }
}
