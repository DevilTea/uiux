import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { principalActor } from '../src/application/access/principal'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { canonicalJsonBytes } from '../src/domain/canonical-json'
import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import { evaluateFlowTraceStaleness, FLOW_CHANGED_REASON } from '../src/domain/evidence/staleness'
import { changeAffectsFlowEvidence, changeScopeOfSubmission } from '../src/domain/reviews/change-domains'
import type { FlowResource } from '../src/domain/flows/schema'
import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { createReviewThreadForHttp, submitReadyForReviewForHttp } from '../src/server/authoring-http'
import { AGENT_EDITOR, scoped, testMember } from './support/access'
import { createCurrentWorkspace } from './support/workspace-layout'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const FLOW_ID = '22222222-2222-4222-8222-222222222222'
const STEP_ID = '33333333-3333-4333-8333-333333333333'
const REVIEW_ID = '44444444-4444-4444-8444-444444444444'
const MEI = testMember({ nickname: 'mei', kind: 'human', preset: 'reviewer', credential: 'session' })
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

// Rule 01a11544-6760-7ec2-8430-0f7cc5807259 and Clauses 01a14e30-2e43-75a7-aca8-c8df28915f4e and
// 01a11544-558b-… (currency is enforced for a formal capture, not for any other Evidence kind).
describe('a Review submission that names the Flow change domain and cites a Flow trace (issue #88)', () => {
	it('accepts the citation, maps the change to the Flow Evidence of its Flows, and leaves judging the trace to its freshness', async () => {
		const root = await mkdtemp(join(tmpdir(), 'uiux-flow-trace-review-'))
		roots.push(root)
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		await createCurrentWorkspace(persistence, { i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
		const app = createWorkspaceApplicationSession(persistence)
		const view = await app.createView({ id: VIEW_ID, name: 'Checkout', spec: { intent: 'Pay', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] } })
		if (view.status !== 'created') throw new Error('View fixture failed.')
		const flow: FlowResource = { id: FLOW_ID, name: 'Pay', entryStepId: STEP_ID, steps: { [STEP_ID]: { target: { viewId: VIEW_ID }, transitions: [] } } }
		const flowRevision = await persistence.flows.create(FLOW_ID, flow)

		// A trace of the Flow as an earlier revision of it, so the trace is stale by the time it is cited.
		const capture = `sha256:${'c'.repeat(64)}`
		const trace: FormalEvidenceRecord = {
			schemaVersion: 1,
			kind: 'flow_trace',
			executionContext: { flowId: FLOW_ID, locale: 'en-US', viewportId: 'desktop', themeId: 'light' },
			coverage: { complete: true },
			provenance: { workspaceSchemaVersion: 6, resources: [{ identity: { type: 'flow', id: FLOW_ID }, revision: 'r_earlier' }], versions: { uiux: '0.1.0' } },
			artifactRefs: [],
			evidenceRefs: [{ kind: 'formal_capture', evidence: capture }],
			data: {
				recipe: { actions: [{ type: 'enter', stepId: STEP_ID, expect: { viewId: VIEW_ID } }] },
				steps: [{ stepId: STEP_ID, viewId: VIEW_ID, valid: true, captureRef: capture }],
			},
		}
		const traceDigest = (await persistence.artifacts.put(canonicalJsonBytes(trace))).identity

		const created = await createReviewThreadForHttp(scoped(app, MEI), { id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })
		expect(created.status).toBe(201)
		const submitted = await submitReadyForReviewForHttp(scoped(app, AGENT_EDITOR), REVIEW_ID, {
			expectedRevision: (created.body as { revision: string }).revision,
			actor: principalActor(AGENT_EDITOR),
			changeDomains: ['flow'],
			resources: [{ identity: { type: 'view', id: VIEW_ID }, revision: view.revision }, { identity: { type: 'flow', id: FLOW_ID }, revision: flowRevision }],
			evidenceRefs: [{ kind: 'flow_trace', evidence: traceDigest }],
		})
		// No currency is enforced for a trace: the stale trace is cited, as any non-capture Evidence is.
		expect(submitted.status).toBe(200)

		const read = await app.readPointResource('review', REVIEW_ID)
		if (read?.kind !== 'review') throw new Error('The thread is missing.')
		const submission = read.resource.submissions[0]!
		expect(submission.evidenceRefs).toEqual([{ kind: 'flow_trace', evidence: traceDigest }])
		const scope = changeScopeOfSubmission(submission, VIEW_ID)
		expect(changeAffectsFlowEvidence(scope, FLOW_ID)).toBe(true)
		expect(changeAffectsFlowEvidence(scope, '55555555-5555-4555-8555-555555555555')).toBe(false)

		// Its freshness is judged on its own: the Flow has another revision than the trace recorded.
		expect(evaluateFlowTraceStaleness(trace, {
			allViews: [],
			flows: [{ key: FLOW_ID, revision: flowRevision as string }],
			captures: new Map(),
		})).toEqual({ isStale: true, reason: FLOW_CHANGED_REASON })
	})
})
