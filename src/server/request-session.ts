import type { H3Event } from 'h3'

import { createScopedWorkspaceSession, type ScopedWorkspaceSession } from '../application/access/scoped-session'
import { requestPrincipal } from './access/http'
import { getSelectedWorkspaceServerRuntime } from './selected-workspace'

/** The selected Workspace's application session, scoped to the request's authenticated principal. */
export function requestSession(event: H3Event): ScopedWorkspaceSession {
	const runtime = getSelectedWorkspaceServerRuntime()
	return createScopedWorkspaceSession(runtime.app, requestPrincipal(event), { transport: 'http', leases: runtime.leases })
}
