import { randomUUID } from 'node:crypto'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

import { keysForRole } from '../../src/application/access/keys'
import { createLeaseManager, type LeaseManager } from '../../src/application/access/leases'
import type { AccessRole, MemberKind, MemberPrincipal } from '../../src/application/access/principal'
import { createScopedWorkspaceSession, type AccessTransport, type ScopedSessionOptions, type ScopedWorkspaceSession } from '../../src/application/access/scoped-session'
import type { WorkspaceApplicationSession } from '../../src/application/services/workspace-session'
import { createUiuxMcpHttpHandler, principalAuthInfo } from '../../src/mcp/server'
import { addMember, createToken, findMemberByNickname } from '../../src/server/access/roster'
import { AccessStore } from '../../src/server/access/store'

/**
 * Tests inject a principal (accepted identity migration plan): in-process HTTP helpers get a
 * scoped session and the MCP handler gets `authInfo`, exactly as the live routes pass them.
 * `role` is sugar: unless `keys` is given, the member holds the keys the live server derives from
 * that role (the built-in preset of that `id`, with no `humanOnly` key for an Agent).
 */
export function testMember(overrides: Partial<Omit<MemberPrincipal, 'type'>> = {}): MemberPrincipal {
	const kind: MemberKind = overrides.kind ?? 'human'
	const role = overrides.role ?? (kind === 'agent' ? 'editor' : 'owner')
	return {
		type: 'member',
		memberId: overrides.memberId ?? randomUUID(),
		nickname: overrides.nickname ?? (kind === 'agent' ? 'claude' : 'owner'),
		kind,
		role,
		keys: overrides.keys ?? keysForRole(kind, role),
		credential: overrides.credential ?? (kind === 'agent' ? 'token' : 'session'),
		credentialId: overrides.credentialId ?? 'aaaaaaaaaa',
	}
}

/** The Workbench default: a human Owner on a cookie session. */
export const HUMAN_OWNER = testMember({ nickname: 'owner', kind: 'human', role: 'owner', credential: 'session' })
/** The usual agent: an Editor with a bearer token. */
export const AGENT_EDITOR = testMember({ nickname: 'claude', kind: 'agent', role: 'editor', credential: 'token' })

export function scoped(
	app: WorkspaceApplicationSession,
	principal: MemberPrincipal = HUMAN_OWNER,
	options: Readonly<{ leases?: LeaseManager; transport?: AccessTransport; history?: ScopedSessionOptions['history'] }> = {},
): ScopedWorkspaceSession {
	return createScopedWorkspaceSession(app, principal, { transport: options.transport ?? 'http', leases: options.leases ?? createLeaseManager(), ...(options.history ? { history: options.history } : {}) })
}

/** An MCP client connected in-process to the stateless handler as `principal`. */
export async function connectMcp(
	app: WorkspaceApplicationSession,
	principal: MemberPrincipal = AGENT_EDITOR,
	options: Readonly<{ leases?: LeaseManager; history?: ScopedSessionOptions['history'] }> = {},
) {
	const handler = createUiuxMcpHttpHandler(app, { leases: options.leases ?? createLeaseManager(), ...(options.history ? { history: options.history } : {}) })
	const client = new Client({ name: 'uiux-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } })
	const transport = new StreamableHTTPClientTransport(new URL('http://uiux.test/mcp'), {
		fetch: async (input, init) => handler.fetch(new Request(input, init), { authInfo: principalAuthInfo(principal) }),
	})
	await client.connect(transport)
	return {
		client,
		handler,
		async close() {
			await client.close()
			await handler.close()
		},
	}
}

/**
 * Provisions a member and a bearer token in a Workspace's host-local roster under the test
 * `UIUX_HOME`, before (or while) a server for that Workspace runs.
 */
export async function provisionToken(
	workspaceRoot: string,
	member: Readonly<{ nickname?: string; kind?: MemberKind; role?: AccessRole }> = {},
): Promise<string> {
	const store = (await AccessStore.open({ workspaceRoot, create: true }))!
	const nickname = member.nickname ?? (member.kind === 'agent' ? 'claude' : 'tester')
	if (!findMemberByNickname(store.data, nickname))
		await store.update(file => addMember(file, { nickname, role: member.role ?? (member.kind === 'agent' ? 'editor' : 'owner'), kind: member.kind ?? 'human' }))
	const issued = await store.update(file => createToken(file, { nickname, label: 'test' }))
	return issued.credential
}

export function bearer(token: string): Record<string, string> {
	return { authorization: `Bearer ${token}` }
}

/** Exchanges a token for a Workbench session cookie (`name=value`). */
export async function sessionCookieFor(origin: string, token: string): Promise<{ name: string; value: string }> {
	const response = await fetch(`${origin}/api/session/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ credential: token }),
	})
	if (!response.ok) throw new Error(`Sign-in failed: ${response.status} ${await response.text()}`)
	const setCookie = response.headers.get('set-cookie') ?? ''
	const pair = setCookie.split(';', 1)[0] ?? ''
	const index = pair.indexOf('=')
	return { name: pair.slice(0, index), value: pair.slice(index + 1) }
}
