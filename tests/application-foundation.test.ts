import { describe, expect, it } from 'vitest'

import type { ResourceRevision, RevisionedResourceRead } from '../src/application/dto/revisions'
import type { MutableResourceRepository } from '../src/application/ports/resources'
import { createFlowService, createViewService } from '../src/application/services/canonical-resources'
import type { FlowResource } from '../src/domain/flows/schema'
import type { ViewResource } from '../src/domain/views/schema'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const STEP_ID = '22222222-2222-4222-8222-222222222222'
const FLOW_ID = '33333333-3333-4333-8333-333333333333'

const noImpact = {
	async analyze() {
		return [] as const
	},
}

function revision(value: string): ResourceRevision {
	return value as ResourceRevision
}

function viewFixture(): ViewResource {
	return {
		id: VIEW_ID,
		name: 'Checkout',
		ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
		variants: {},
		spec: {
			intent: '',
			entryConditions: [],
			interactionRules: [],
			constraints: [],
			accessibility: [],
			references: [],
			decisions: [],
		},
	}
}

function flowFixture(): FlowResource {
	return {
		id: FLOW_ID,
		name: 'Checkout flow',
		entryStepId: STEP_ID,
		steps: {
			[STEP_ID]: {
				target: { viewId: VIEW_ID },
				transitions: [],
			},
		},
	}
}

class FakeRepository<Key, Resource> implements MutableResourceRepository<Key, Resource> {
	commitCalls = 0
	successfulWrites = 0
	forcedConflict?: ResourceRevision

	constructor(
		private readonly key: Key,
		private current: RevisionedResourceRead<Resource>,
		private readonly nextRevision = revision('r-next'),
	) {}

	async read(key: Key): Promise<RevisionedResourceRead<Resource> | undefined> {
		return Object.is(key, this.key) ? this.current : undefined
	}

	async compareAndSwap(input: Readonly<{
		key: Key
		expectedRevision: ResourceRevision
		resource: Resource
	}>): Promise<
		| Readonly<{ ok: true; revision: ResourceRevision }>
		| Readonly<{ ok: false; conflict: Readonly<{ code: 'revision_conflict'; currentRevision: ResourceRevision }> }>
	> {
		this.commitCalls++
		if (this.forcedConflict)
			return { ok: false, conflict: { code: 'revision_conflict', currentRevision: this.forcedConflict } }
		if (input.expectedRevision !== this.current.revision)
			return { ok: false, conflict: { code: 'revision_conflict', currentRevision: this.current.revision } }
		this.current = { resource: input.resource, revision: this.nextRevision }
		this.successfulWrites++
		return { ok: true, revision: this.nextRevision }
	}

	snapshot(): RevisionedResourceRead<Resource> {
		return this.current
	}
}

describe('shared application/domain foundation', () => {
	it('returns a structured stale-revision conflict with exactly zero commit calls', async () => {
		const repository = new FakeRepository(VIEW_ID, { resource: viewFixture(), revision: revision('r2') })
		const service = createViewService({ repository, impact: noImpact })
		let mutationCalls = 0

		const result = await service.mutateView({
			key: VIEW_ID,
			expectedRevision: revision('r1'),
			mutate: current => {
				mutationCalls++
				return { ...current, name: 'Changed' }
			},
			changeSummary: ['name'],
		})

		expect(result).toEqual({ status: 'conflict', key: VIEW_ID, currentRevision: revision('r2') })
		expect(mutationCalls).toBe(0)
		expect(repository.commitCalls).toBe(0)
		expect(repository.successfulWrites).toBe(0)
		expect(repository.snapshot().resource.name).toBe('Checkout')
	})

	it('rejects invalid mutations before commit and preserves the authored value', async () => {
		const repository = new FakeRepository(VIEW_ID, { resource: viewFixture(), revision: revision('r1') })
		const service = createViewService({ repository, impact: noImpact })

		const result = await service.mutateView({
			key: VIEW_ID,
			expectedRevision: revision('r1'),
			mutate: current => ({ ...current, name: '' }),
			changeSummary: ['name'],
		})

		expect(result.status).toBe('invalid')
		expect(repository.commitCalls).toBe(0)
		expect(repository.snapshot().resource).toEqual(viewFixture())
	})

	it('commits a harmless mutation when impact analysis finds nothing without acknowledgement', async () => {
		const repository = new FakeRepository(VIEW_ID, { resource: viewFixture(), revision: revision('r1') })
		let analysisCalls = 0
		const service = createViewService({
			repository,
			impact: {
				async analyze() {
					analysisCalls++
					return []
				},
			},
		})

		const result = await service.mutateView({
			key: VIEW_ID,
			expectedRevision: revision('r1'),
			mutate: current => ({ ...current, name: 'Checkout revised' }),
			changeSummary: ['name'],
		})

		expect(result).toEqual({
			status: 'updated',
			key: VIEW_ID,
			revision: revision('r-next'),
			diagnostics: [],
			changeSummary: ['name'],
		})
		expect(repository.commitCalls).toBe(1)
		expect(repository.successfulWrites).toBe(1)
		expect(analysisCalls).toBe(1)
	})

	it('keeps diagnostic-provider failures before the atomic commit boundary', async () => {
		const repository = new FakeRepository(VIEW_ID, { resource: viewFixture(), revision: revision('r1') })
		const service = createViewService({
			repository,
			impact: noImpact,
			diagnostics: {
				async diagnose() { throw new Error('diagnostics unavailable') },
			},
		})

		await expect(service.mutateView({
			key: VIEW_ID,
			expectedRevision: revision('r1'),
			mutate: current => ({ ...current, name: 'Candidate' }),
			changeSummary: ['name'],
		})).rejects.toThrow('diagnostics unavailable')
		expect(repository.commitCalls).toBe(0)
		expect(repository.snapshot().resource.name).toBe('Checkout')
	})

	it('does not retry or hide a race detected by the repository CAS boundary', async () => {
		const repository = new FakeRepository(VIEW_ID, { resource: viewFixture(), revision: revision('r1') })
		repository.forcedConflict = revision('r2')
		const service = createViewService({ repository, impact: noImpact })

		const result = await service.mutateView({
			key: VIEW_ID,
			expectedRevision: revision('r1'),
			mutate: current => ({ ...current, name: 'Raced' }),
			changeSummary: ['name'],
		})

		expect(result).toEqual({ status: 'conflict', key: VIEW_ID, currentRevision: revision('r2') })
		expect(repository.commitCalls).toBe(1)
		expect(repository.successfulWrites).toBe(0)
		expect(repository.snapshot().resource.name).toBe('Checkout')
	})

	it('rejects changes to immutable canonical resource identity before commit', async () => {
		const repository = new FakeRepository(VIEW_ID, { resource: viewFixture(), revision: revision('r1') })
		const service = createViewService({ repository, impact: noImpact })

		const result = await service.mutateView({
			key: VIEW_ID,
			expectedRevision: revision('r1'),
			mutate: resource => ({ ...resource, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
			changeSummary: ['id'],
		})

		expect(result.status).toBe('invalid')
		expect(result.status === 'invalid' && result.diagnostics.some(item => item.code === 'view.immutable_id_changed')).toBe(true)
		expect(repository.commitCalls).toBe(0)
	})

	it('requires explicit acknowledgement for known destructive reference impact and mutates only the target', async () => {
		const current = { ...viewFixture(), variants: { desktop: { state: {} } } }
		const repository = new FakeRepository(VIEW_ID, { resource: current, revision: revision('r1') })
		const referringRepository = new FakeRepository(FLOW_ID, { resource: flowFixture(), revision: revision('flow-r1') })
		let analysisCalls = 0
		const service = createViewService({
			repository,
			impact: {
				async analyze(input) {
					analysisCalls++
					expect(input.current).toEqual(current)
					expect(input.next.variants).toEqual({ wide: { state: {} } })
					return [{ source: 'flow', detail: 'references desktop' }] as const
				},
			},
		})
		const renameVariant = (resource: ViewResource): ViewResource => ({
			...resource,
			variants: { wide: resource.variants.desktop! },
		})

		const blocked = await service.mutateView({
			key: VIEW_ID,
			expectedRevision: revision('r1'),
			mutate: renameVariant,
			changeSummary: ['variant rename desktop -> wide'],
		})
		expect(blocked.status).toBe('impact_acknowledgement_required')
		expect(blocked.status === 'impact_acknowledgement_required' ? blocked.impacts : []).toEqual([
			{ source: 'flow', detail: 'references desktop' },
		])
		expect(analysisCalls).toBe(1)
		expect(repository.commitCalls).toBe(0)

		const accepted = await service.mutateView({
			key: VIEW_ID,
			expectedRevision: revision('r1'),
			mutate: renameVariant,
			changeSummary: ['variant rename desktop -> wide'],
			acknowledgeImpact: true,
		})
		expect(accepted.status).toBe('updated')
		expect(repository.commitCalls).toBe(1)
		expect(repository.successfulWrites).toBe(1)
		expect(analysisCalls).toBe(2)
		expect(referringRepository.commitCalls).toBe(0)
		expect(referringRepository.snapshot().resource).toEqual(flowFixture())
		expect(repository.snapshot().resource.variants).toEqual({ wide: { state: {} } })
	})

	it('keeps repairably-invalid authored state readable with local and cross-resource diagnostics', async () => {
		const invalid = { ...viewFixture(), name: '' } as ViewResource
		const repository = new FakeRepository(VIEW_ID, { resource: invalid, revision: revision('r-bad') })
		const service = createViewService({
			repository,
			impact: noImpact,
			diagnostics: {
				async diagnose() {
					return [{ code: 'reference.dangling', path: '/spec/references/0', message: 'Target is missing.' }]
				},
			},
		})

		const result = await service.readView(VIEW_ID)
		expect(result?.resource).toBe(invalid)
		expect(result?.revision).toBe(revision('r-bad'))
		expect(result?.diagnostics.some(item => item.code === 'schema.empty_string')).toBe(true)
		expect(result?.diagnostics.some(item => item.code === 'reference.dangling')).toBe(true)
		expect(repository.commitCalls).toBe(0)
	})

	it('uses the same mutation semantics for distinct domain-specific services and transport facades', async () => {
		const viewRepository = new FakeRepository(VIEW_ID, { resource: viewFixture(), revision: revision('view-r1') })
		const flowRepository = new FakeRepository(FLOW_ID, { resource: flowFixture(), revision: revision('flow-r1') })
		const viewService = createViewService({ repository: viewRepository, impact: noImpact })
		const flowService = createFlowService({ repository: flowRepository, impact: noImpact })

		const viewResult = await viewService.mutateView({
			key: VIEW_ID, expectedRevision: revision('stale'), changeSummary: ['name'],
			mutate: current => ({ ...current, name: 'No write' }),
		})
		const flowResult = await flowService.mutateFlow({
			key: FLOW_ID, expectedRevision: revision('stale'), changeSummary: ['name'],
			mutate: current => ({ ...current, name: 'No write' }),
		})
		expect(viewResult.status).toBe('conflict')
		expect(flowResult.status).toBe('conflict')
		expect(viewRepository.commitCalls).toBe(0)
		expect(flowRepository.commitCalls).toBe(0)

		let delegatedCalls = 0
		const sharedUseCase = {
			async mutateView(command: Parameters<typeof viewService.mutateView>[0]) {
				delegatedCalls++
				return viewService.mutateView(command)
			},
		}
		const httpFacade = { mutateView: (command: Parameters<typeof sharedUseCase.mutateView>[0]) => sharedUseCase.mutateView(command) }
		const mcpFacade = { mutateView: (command: Parameters<typeof sharedUseCase.mutateView>[0]) => sharedUseCase.mutateView(command) }
		const transportCommand = {
			key: VIEW_ID, expectedRevision: revision('stale'), changeSummary: ['name'],
			mutate: (current: ViewResource) => ({ ...current, name: 'Still no write' }),
		}
		expect((await httpFacade.mutateView(transportCommand)).status).toBe('conflict')
		expect((await mcpFacade.mutateView(transportCommand)).status).toBe('conflict')
		expect(delegatedCalls).toBe(2)
		expect(viewRepository.commitCalls).toBe(0)
	})
})
