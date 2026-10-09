import { lstat, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { FileNativePersistence } from '../persistence/file-native'
import { artifactRelativePath } from '../persistence/paths'
import { readActiveServerHold } from '../persistence/server-hold'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../product/workspace-schema'
import { generateHint } from '../server/access/credentials'
import {
	AccessError,
	addMember,
	copyRoster,
	createInvite,
	createToken,
	findMemberByNickname,
	isSessionActive,
	isTokenActive,
	removeMember,
	revokeSessions,
	revokeToken,
	setMember,
	summarizeMembers,
	type AccessFile,
} from '../server/access/roster'
import { AccessStore, assertHomeOutsideWorkspace, copyHostHistory, planHostHistoryCopy, realFuturePath, resolveUiuxHome, rosterExists, workspaceRealRoot, writeNewRoster, type HostHistoryCopyResult } from '../server/access/store'

/**
 * `uiux member | token | invite | session | access copy` (accepted identity decision 9). Every
 * command takes a required `--workspace <dir>` and acts only on that Workspace's host-local roster
 * under `$UIUX_HOME/workspaces/<sha256(realpath)>/access.json`. They work while a server runs: the
 * server re-reads the store on its next request.
 */
export const ACCESS_COMMANDS = ['member', 'token', 'invite', 'session', 'access'] as const

export type AccessCommandOptions = Readonly<{
	argv: readonly string[]
	cwd?: string
	env?: Readonly<Record<string, string | undefined>>
	stdout?: (line: string) => void
	stderr?: (line: string) => void
	now?: () => Date
}>

export const ACCESS_HELP = `Access commands (each takes --workspace <dir>; the roster lives in $UIUX_HOME, default ~/.uiux):
  member add <nick> --role <owner|editor|reviewer|viewer> [--kind human|agent]
  member list
  member set <nick> [--role <role>] [--nickname <new>]
  member remove <nick>
  token create --member <nick> [--label <text>] [--expires <days>|never] [--lan]
  token list [--member <nick>] [--all]
  token revoke <token-id>
  invite create --member <nick> [--origin <url>] [--expires <hours>]
  session list
  session revoke <session-id> | --member <nick>
  access copy --from <old-dir> [--replace]   (roster and host history, once; copy before uiux migrate:
                                             --replace discards the target's roster and own host history)`

class UsageError extends Error {}

type Parsed = Readonly<{ positionals: string[]; values: Map<string, string>; flags: Set<string> }>

function parse(args: readonly string[], valueOptions: readonly string[], flagOptions: readonly string[]): Parsed {
	const positionals: string[] = []
	const values = new Map<string, string>()
	const flags = new Set<string>()
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!
		if (arg.startsWith('--')) {
			const name = arg.slice(2)
			if (flagOptions.includes(name)) {
				if (flags.has(name)) throw new UsageError(`--${name} was given twice.`)
				flags.add(name)
				continue
			}
			if (!valueOptions.includes(name)) throw new UsageError(`Unknown option ${arg}.`)
			const value = args[index + 1]
			if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} requires a value.`)
			if (values.has(name)) throw new UsageError(`${arg} was given twice.`)
			values.set(name, value)
			index += 1
			continue
		}
		positionals.push(arg)
	}
	return { positionals, values, flags }
}

function table(rows: readonly (readonly string[])[]): string[] {
	const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => row[column]!.length)))
	return rows.map(row => `  ${row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column]!)).join('  ')}`.trimEnd())
}

const day = (value: string | null) => value ? value.slice(0, 10) : 'never'
const when = (value: string | null) => value ? value.replace('T', ' ').slice(0, 16) : '-'

export async function runAccessCommand(options: AccessCommandOptions): Promise<number> {
	const out = options.stdout ?? (line => console.log(line))
	const err = options.stderr ?? (line => console.error(line))
	const cwd = options.cwd ?? process.cwd()
	const env = options.env ?? process.env
	const now = options.now ?? (() => new Date())
	const [command, sub, ...rest] = options.argv
	try {
		if (!command || !(ACCESS_COMMANDS as readonly string[]).includes(command)) throw new UsageError(`Unknown access command ${JSON.stringify(command ?? '')}.`)
		const home = resolveUiuxHome(env)
		const spec = commandSpec(command, sub)
		if (!spec) throw new UsageError(`Unknown command: uiux ${[command, sub].filter(Boolean).join(' ')}.`)
		const parsed = parse(rest, ['workspace', ...spec.values], spec.flags)
		const workspaceArg = parsed.values.get('workspace')
		if (!workspaceArg) throw new UsageError(`uiux ${command} ${sub} requires --workspace <dir>.`)
		if (spec.positionals >= 0 && parsed.positionals.length !== spec.positionals)
			throw new UsageError(`uiux ${command} ${sub} takes ${spec.positionals === 0 ? 'no positional arguments' : `exactly ${spec.positionals} positional argument${spec.positionals > 1 ? 's' : ''}`}.`)
		const workspaceRoot = await requireWorkspace(resolve(cwd, workspaceArg))
		const context: Context = { home, workspaceRoot, parsed, out, err, now, cwd }
		return await spec.run(context)
	}
	catch (error) {
		if (error instanceof UsageError) {
			err(`uiux: ${error.message}`)
			err(ACCESS_HELP)
			return 2
		}
		if (error instanceof AccessError) {
			err(`uiux: ${error.message}`)
			return error.code === 'access.workspace_invalid' || error.code === 'access.home_inside_workspace' ? 2 : 1
		}
		throw error
	}
}

type Context = Readonly<{
	home: string
	workspaceRoot: string
	parsed: Parsed
	out: (line: string) => void
	err: (line: string) => void
	now: () => Date
	cwd: string
}>

type CommandSpec = Readonly<{ positionals: number; values: readonly string[]; flags: readonly string[]; run: (context: Context) => Promise<number> }>

async function requireWorkspace(root: string): Promise<string> {
	try {
		if (!(await stat(root)).isDirectory()) throw new Error('not a directory')
		await stat(join(root, '.uiux', 'workspace.json'))
	}
	catch {
		throw new AccessError('access.workspace_invalid', `${root} is not an initialized UIUX Workspace (no .uiux/workspace.json). Run uiux init --workspace <dir> first.`)
	}
	return workspaceRealRoot(root)
}

async function openStore(context: Context, create: boolean): Promise<AccessStore | undefined> {
	return AccessStore.open({ workspaceRoot: context.workspaceRoot, home: context.home, create })
}

async function requireStore(context: Context): Promise<AccessStore> {
	return (await openStore(context, true))!
}

function header(context: Context, file: AccessFile): void {
	context.out(`Roster ${file.hint} for ${file.workspaceRoot}`)
}

function parseExpiryDays(raw: string | undefined): number | null | undefined {
	if (raw === undefined) return undefined
	if (raw === 'never') return null
	if (!/^\d+$/u.test(raw)) throw new UsageError('--expires takes a whole number of days or never.')
	return Number(raw)
}

function parseHours(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined
	if (!/^\d+$/u.test(raw)) throw new UsageError('--expires takes a whole number of hours.')
	return Number(raw)
}

function commandSpec(command: string, sub: string | undefined): CommandSpec | undefined {
	switch (`${command} ${sub ?? ''}`) {
		case 'member add': return {
			positionals: 1, values: ['role', 'kind'], flags: [],
			async run(context) {
				const role = context.parsed.values.get('role')
				if (!role) throw new UsageError('uiux member add requires --role <owner|editor|reviewer|viewer>.')
				const store = await requireStore(context)
				const member = await store.update(file => addMember(file, { nickname: context.parsed.positionals[0]!, role, kind: context.parsed.values.get('kind') ?? 'human' }, context.now()))
				context.out(`Added ${member.kind} member ${member.nickname} (${member.role}) to roster ${store.data.hint} for ${store.data.workspaceRoot}.`)
				if (member.kind === 'agent') context.out(`  Next: uiux token create --workspace ${store.data.workspaceRoot} --member ${member.nickname}`)
				else context.out(`  Next: uiux invite create --workspace ${store.data.workspaceRoot} --member ${member.nickname}`)
				return 0
			},
		}
		case 'member list': return {
			positionals: 0, values: [], flags: [],
			async run(context) {
				const store = await openStore(context, false)
				if (!store) {
					context.out(`No roster yet for ${context.workspaceRoot}. uiux dev creates one on first start, or add a member with uiux member add.`)
					return 0
				}
				const file = store.data
				header(context, file)
				if (file.members.length === 0) {
					context.out('  (no members)')
					return 0
				}
				const members = summarizeMembers(file, context.now().getTime())
				context.out(table([['NICKNAME', 'KIND', 'ROLE', 'TOKENS', 'SESSIONS'], ...members.map(member => [member.nickname, member.kind, member.role, String(member.activeTokens), String(member.activeSessions)])]).join('\n'))
				return 0
			},
		}
		case 'member set': return {
			positionals: 1, values: ['role', 'nickname'], flags: [],
			async run(context) {
				const role = context.parsed.values.get('role')
				const nickname = context.parsed.values.get('nickname')
				if (role === undefined && nickname === undefined) throw new UsageError('uiux member set needs --role <role> and/or --nickname <new>. The kind is immutable.')
				const store = await requireStore(context)
				const member = await store.update(file => setMember(file, context.parsed.positionals[0]!, { ...(role !== undefined ? { role } : {}), ...(nickname !== undefined ? { nickname } : {}) }))
				context.out(`Updated ${member.nickname}: ${member.kind}, ${member.role}.`)
				return 0
			},
		}
		case 'member remove': return {
			positionals: 1, values: [], flags: [],
			async run(context) {
				const store = await requireStore(context)
				const member = await store.update(file => removeMember(file, context.parsed.positionals[0]!))
				context.out(`Removed ${member.nickname} and its tokens, invites and sessions. A running server drops its edit leases on its next request.`)
				return 0
			},
		}
		case 'token create': return {
			positionals: 0, values: ['member', 'label', 'expires'], flags: ['lan'],
			async run(context) {
				const nickname = context.parsed.values.get('member')
				if (!nickname) throw new UsageError('uiux token create requires --member <nick>.')
				const expiresInDays = parseExpiryDays(context.parsed.values.get('expires'))
				const lan = context.parsed.flags.has('lan')
				const store = await requireStore(context)
				const issued = await store.update(file => createToken(file, {
					nickname,
					...(context.parsed.values.has('label') ? { label: context.parsed.values.get('label') } : {}),
					...(expiresInDays !== undefined ? { expiresInDays } : {}),
					lan,
				}, context.now()))
				const member = store.data.members.find(item => item.id === issued.entry.memberId)!
				context.out(`Created token ${issued.entry.id} for ${member.nickname} (${member.kind}, ${member.role}; expires ${day(issued.entry.expiresAt)}; ${lan ? 'LAN-enabled' : 'loopback only'}).`)
				context.out(issued.credential)
				context.out('Store it in an environment variable such as UIUX_MCP_TOKEN, never commit it. It is shown only once.')
				if (lan) {
					context.err('Warning: LAN tokens cross the network in clear text on a plain-HTTP LAN listener; anyone on the network can capture and reuse them. This version of UIUX ships no LAN listener, so the token works on loopback like any other.')
				}
				return 0
			},
		}
		case 'token list': return {
			positionals: 0, values: ['member'], flags: ['all'],
			async run(context) {
				const store = await openStore(context, false)
				if (!store) {
					context.out(`No roster yet for ${context.workspaceRoot}.`)
					return 0
				}
				const file = store.data
				const filter = context.parsed.values.get('member')
				const member = filter ? findMemberByNickname(file, filter) : undefined
				if (filter && !member) throw new AccessError('access.member_not_found', `No member named ${JSON.stringify(filter)} in this Workspace's roster.`)
				const nowMs = context.now().getTime()
				const tokens = file.tokens.filter(token => (!member || token.memberId === member.id) && (context.parsed.flags.has('all') || isTokenActive(token, nowMs)))
				header(context, file)
				if (tokens.length === 0) {
					context.out('  (no tokens)')
					return 0
				}
				const nick = (id: string) => file.members.find(item => item.id === id)?.nickname ?? '(removed)'
				const state = (token: typeof tokens[number]) => token.revokedAt ? 'revoked' : isTokenActive(token, nowMs) ? 'active' : 'expired'
				context.out(table([
					['ID', 'MEMBER', 'LABEL', 'LAN', 'CREATED', 'EXPIRES', 'LAST USED', 'STATE'],
					...tokens.map(token => [token.id, nick(token.memberId), token.label || '-', token.lan ? 'yes' : 'no', day(token.createdAt), day(token.expiresAt), when(token.lastUsedAt), state(token)]),
				]).join('\n'))
				return 0
			},
		}
		case 'token revoke': return {
			positionals: 1, values: [], flags: [],
			async run(context) {
				const store = await requireStore(context)
				const token = await store.update(file => revokeToken(file, context.parsed.positionals[0]!, context.now()))
				context.out(`Revoked token ${token.id}. A running server refuses it on its next request.`)
				return 0
			},
		}
		case 'invite create': return {
			positionals: 0, values: ['member', 'origin', 'expires'], flags: [],
			async run(context) {
				const nickname = context.parsed.values.get('member')
				if (!nickname) throw new UsageError('uiux invite create requires --member <nick>.')
				let origin = 'http://127.0.0.1:3000'
				const rawOrigin = context.parsed.values.get('origin')
				if (rawOrigin !== undefined) {
					try { origin = new URL(rawOrigin).origin }
					catch { throw new UsageError('--origin must be a URL such as http://127.0.0.1:3000.') }
				}
				const hours = parseHours(context.parsed.values.get('expires'))
				const store = await requireStore(context)
				const issued = await store.update(file => createInvite(file, { nickname, ...(hours !== undefined ? { expiresInHours: hours } : {}) }, context.now()))
				context.out(`Sign-in link for ${nickname} (single use, expires ${when(issued.entry.expiresAt)} UTC):`)
				context.out(`  ${origin}/login#${issued.credential}`)
				return 0
			},
		}
		case 'session list': return {
			positionals: 0, values: [], flags: [],
			async run(context) {
				const store = await openStore(context, false)
				if (!store) {
					context.out(`No roster yet for ${context.workspaceRoot}.`)
					return 0
				}
				const file = store.data
				const nowMs = context.now().getTime()
				const sessions = file.sessions.filter(session => isSessionActive(session, nowMs))
				header(context, file)
				if (sessions.length === 0) {
					context.out('  (no sessions)')
					return 0
				}
				const nick = (id: string) => file.members.find(item => item.id === id)?.nickname ?? '(removed)'
				context.out(table([
					['ID', 'MEMBER', 'LISTENER', 'CREATED', 'LAST SEEN', 'EXPIRES', 'USER AGENT'],
					...sessions.map(session => [session.id, nick(session.memberId), session.listener, when(session.createdAt), when(session.lastSeenAt), day(session.expiresAt), session.userAgent.slice(0, 60) || '-']),
				]).join('\n'))
				return 0
			},
		}
		case 'session revoke': return {
			positionals: -1, values: ['member'], flags: [],
			run: runSessionRevoke,
		}
		case 'access copy': return {
			positionals: 0, values: ['from'], flags: ['replace'],
			async run(context) {
				const from = context.parsed.values.get('from')
				if (!from) throw new UsageError('uiux access copy requires --from <old-dir>.')
				const fromPath = resolve(context.cwd, from)
				// The old directory may already be gone; fall back to its nearest existing ancestor's real path.
				const sourceRoot = realFuturePath(fromPath)
				if (sourceRoot === context.workspaceRoot) throw new AccessError('access.roster_exists', 'The source and target are the same Workspace.')
				const source = await AccessStore.readRoster(context.home, sourceRoot)
				if (!source) throw new AccessError('access.roster_missing', `No roster recorded for ${sourceRoot} under ${context.home}.`)
				const replace = context.parsed.flags.has('replace')
				// Clause 01a1144e-56bd-7988-8d2a-87b23954ca49: the host history comes along, once. Every
				// refusal is checked first, and the history is copied before the roster is written, so a
				// refused or failed copy leaves the target unchanged.
				assertHomeOutsideWorkspace(context.home, context.workspaceRoot)
				if (!replace && await rosterExists(context.home, context.workspaceRoot))
					throw new AccessError('access.roster_exists', `Workspace ${context.workspaceRoot} already has a roster. Pass --replace to discard it (and its host history).`)
				const history = await planHostHistoryCopy(context.home, sourceRoot, context.workspaceRoot)
				let copied: HostHistoryCopyResult | undefined
				if (history.sourceExists) {
					if (history.targetExists && !replace)
						throw new AccessError('access.roster_exists', `Workspace ${context.workspaceRoot} already has host history (${history.target.dir}). Pass --replace to discard it.`)
					// A running server keeps the target's history state in memory; replacing it underneath would corrupt it.
					await refuseWhileServed(context.workspaceRoot)
					// Under the target Workspace's persistence lock, which every writer of its history holds,
					// and where possible the source's, so no source writer or prune runs mid-copy.
					const persistence = new FileNativePersistence({ root: context.workspaceRoot, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
					try {
						copied = await persistence.withLock(() => withSourceLock(sourceRoot, context.err, () => copyHostHistory(history, {
							replace,
							// A server may have started since the check above.
							beforeSwap: () => refuseWhileServed(context.workspaceRoot),
							blobAvailableElsewhere: digest => isRegularFile(join(context.workspaceRoot, artifactRelativePath(digest))),
						})))
					}
					catch (error) {
						if (error instanceof AccessError) throw error
						throw new AccessError('access.store_invalid', `Could not copy the host history from ${history.source.dir}: ${error instanceof Error ? error.message : String(error)}. Nothing was copied.`)
					}
				}
				let written: Awaited<ReturnType<typeof writeNewRoster>>
				try {
					written = await writeNewRoster({
						workspaceRoot: context.workspaceRoot,
						home: context.home,
						replace,
						file: realRoot => copyRoster(source, { workspaceRoot: realRoot, hint: generateHint() }),
					})
				}
				catch (error) {
					if (!copied) throw error
					// Whatever failed, the host history is already in place: only a rerun with --replace finishes the copy.
					const hint = 'The host history was copied, but the roster was not; run uiux access copy again with --replace.'
					if (error instanceof AccessError) throw new AccessError(error.code, `${error.message} ${hint}`)
					throw new AccessError('access.store_invalid', `Could not write the roster: ${error instanceof Error ? error.message : String(error)}. ${hint}`)
				}
				context.out(`Copied ${source.members.length} member(s) and ${source.tokens.length} token(s) from roster ${source.hint} (${sourceRoot}) to roster ${written.file.hint} (${written.file.workspaceRoot}).`)
				if (copied) {
					context.out(`Copied the host history (${copied.files} file(s)) from ${history.source.dir} to ${history.target.dir}.`)
					if (history.targetExists)
						context.out(`--replace discarded the target's own host history: ${copied.discardedVersions} version(s), such as the system version of a uiux migrate run there.`)
					if (copied.missingBlobs.length > 0)
						context.err(`uiux: warning: ${copied.missingBlobs.length} blob(s) that copied versions name are missing from the source host history too; those versions cannot be compared or restored.`)
				}
				else {
					context.out(`No host history recorded for ${sourceRoot}; none copied.`)
				}
				context.out('Existing tokens keep working here; browsers sign in again (invites and sessions are not copied).')
				context.out('This is a one-time copy: revoking a token in one roster does not revoke it in the other, and later history is recorded separately.')
				context.out(`Source roster: ${source.workspaceRoot} — delete it by hand when it is stale.`)
				return 0
			},
		}
		default: return undefined
	}
}

async function refuseWhileServed(workspaceRoot: string): Promise<void> {
	const hold = await readActiveServerHold(workspaceRoot)
	if (hold)
		throw new AccessError('access.lock_busy', `A UIUX server (pid ${hold.pid} on ${hold.hostname}) is serving ${workspaceRoot}. Stop that server, then run uiux access copy again to copy the host history.`)
}

async function isRegularFile(path: string): Promise<boolean> {
	return lstat(path).then(stats => stats.isFile(), () => false)
}

/**
 * Runs `operation` under the source Workspace's persistence lock when the source is still a
 * Workspace, so its server cannot record or prune host history meanwhile. Best effort: the old
 * directory may be gone, and a lock that cannot be taken (a busy or unusable source) only warns,
 * since the copy checks its own consistency before it replaces anything.
 */
async function withSourceLock<Result>(sourceRoot: string, warn: (line: string) => void, operation: () => Promise<Result>): Promise<Result> {
	if (!(await lstat(join(sourceRoot, '.uiux')).then(stats => stats.isDirectory(), () => false))) return operation()
	// Not read-only for the source: taking its persistence lock writes the lock file under the source's
	// `.uiux/` (removed on release), and acquiring the lock runs the source's pending-transaction
	// recovery, which can change its files to settle a multi-file write it left interrupted.
	let entered = false
	try {
		return await new FileNativePersistence({ root: sourceRoot, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }).withLock(async () => {
			entered = true
			return operation()
		})
	}
	catch (error) {
		if (entered) throw error
		warn(`uiux: warning: could not lock the source Workspace ${sourceRoot} (${error instanceof Error ? error.message : String(error)}); copying its host history without the lock.`)
		return operation()
	}
}

/** `session revoke` takes either one positional session id or `--member <nick>`. */
async function runSessionRevoke(context: Context): Promise<number> {
	const member = context.parsed.values.get('member')
	const ids = context.parsed.positionals
	if ((member === undefined) === (ids.length === 0) || ids.length > 1)
		throw new UsageError('uiux session revoke takes exactly one of <session-id> or --member <nick>.')
	const store = await requireStore(context)
	const removed = await store.update(file => revokeSessions(file, member !== undefined ? { nickname: member } : { sessionId: ids[0]! }))
	context.out(`Revoked ${removed.length} session(s). Those browsers return to the sign-in page on their next request.`)
	return 0
}
