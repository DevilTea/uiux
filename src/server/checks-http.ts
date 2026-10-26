import type { ScopedWorkspaceSession } from '../application/access/scoped-session'

type RecordChecksRunResult = Awaited<ReturnType<ScopedWorkspaceSession['recordChecksRun']>>

/**
 * Clause 01a17671-11bf-7711-887b-121a02602cf4: `POST /api/checks/runs`, the same result as `record_checks_run`:
 * 200 when recorded, 403 without `evidence.capture`, 422 for an input that does not meet Clause
 * 01a17670-d442-7068-8a08-c6e4ab9c09ae, and 500 when the Workspace manifest cannot be read. Nothing is written
 * unless it answers 200.
 */
export async function recordChecksRunForHttp(app: Pick<ScopedWorkspaceSession, 'recordChecksRun'>, body: unknown): Promise<Readonly<{ status: number; body: RecordChecksRunResult }>> {
	const result = await app.recordChecksRun(body)
	switch (result.status) {
		case 'recorded': return { status: 200, body: result }
		case 'blocked': return { status: 403, body: result }
		case 'invalid': return { status: 422, body: result }
		default: return { status: 500, body: result }
	}
}
