import { lstat, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { resolve } from 'node:path'

import { isCatalogKey, isHumanOnlyKey, keysOfPreset, PERMISSION_KEYS } from '../application/access/keys'
import { memberLabel, memberLabelName, type LabelPreset } from '../application/access/labels'
import { isMemberKind, type MemberKind } from '../application/access/principal'
import { FileNativePersistence } from '../persistence/file-native'
import { detectWorkspaceLayout, layoutForSchemaVersion, resolveLayoutDirectory, resolveWorkspacePath, type WorkspaceLayout } from '../persistence/paths'
import type { WorkspaceSchemaPolicy } from '../persistence/schema-policy'
import { checkWorkspaceSelection, isRelocatedSourceOf, selectWorkspace } from '../persistence/workspace-selection'
import { readActiveServerHold } from '../persistence/server-hold'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../product/workspace-schema'
import { generateHint } from '../server/access/credentials'
import { readWorkspaceAccessPresets } from '../server/access/workspace-presets'
import { DEFAULT_LOOPBACK_BIND_HOST, isLoopbackHostname, resolveListenPort } from '../server/network-access'
import {
	AccessError,
	addMember,
	copyRoster,
	createInvite,
	createToken,
	findMemberByNickname,
	isSessionActive,
	isTokenActive,
	normalizeKeys,
	removeMember,
	requireMember,
	revokeSessions,
	revokeToken,
	setMember,
	summarizeMembers,
	type AccessFile,
	type StoredMember,
} from '../server/access/roster'
import { AccessStore, assertHomeOutsideWorkspace, assertReplacementKeepsManager, copyHostHistory, planHostHistoryCopy, realFuturePath, resolveUiuxHome, rosterExists, workspaceRealRoot, writeNewRoster, type HostHistoryCopyResult } from '../server/access/store'

/**
 * `uiux member | token | invite | session | access copy` (accepted identity decision 9). Every
 * command takes an optional `--workspace <dir>` (otherwise the Workspace is discovered from the
 * current directory) and acts only on the selected Workspace's host-local roster
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
	/** Test seam: the Workspace schema policy of the entry checks (UIUX's own by default). */
	schemaPolicy?: WorkspaceSchemaPolicy
}>

export const ACCESS_HELP = `Access commands (each takes [--workspace <dir>], otherwise the Workspace is discovered from the
current directory; the roster lives in $UIUX_HOME, default ~/.uiux):
  member add <nick> (--preset <name> | --keys <k,...> | --all-keys) [--kind human|agent]
  member set <nick> [--preset <name>] [--grant <k,...>] [--revoke <k,...>] [--nickname <new>]
                                             (--preset copies an Access preset's keys: Viewer, Reviewer,
                                             Editor or Owner; --all-keys gives every key. An Agent never
                                             gets humanOnly keys such as members.manage. Keys are
                                             comma-separated, such as views.write,flows.write)
  member list [--keys]                       (ACCESS: the preset label or Custom; KEYS: the key count,
                                             or with --keys the keys)
  member remove <nick>
  token create --member <nick> [--label <text>] [--expires <days>|never]
  token list [--member <nick>] [--all]
  token revoke <token-id>
  invite create --member <nick> [--origin <url>] [--expires <hours>]
                                             (--origin defaults to the loopback origin on the server's port)
  session list
  session revoke <session-id> | --member <nick>
  access copy --from <old-dir> [--replace]   (roster and host history, once; after uiux migrate moves a
                                             Workspace into <old-dir>/.uiux/, copy --from <old-dir> before
                                             the first uiux dev there; --replace discards the target's
                                             roster and own host history)`

class UsageError extends Error {}

type Parsed = Readonly<{ positionals: string[]; values: Map<string, string>; flags: Set<string> }>

function parse(args: readonly string[], valueOptions: readonly string[], flagOptions: readonly string[], removedOptions: Readonly<Record<string, string>> = {}): Parsed {
	const positionals: string[] = []
	const values = new Map<string, string>()
	const flags = new Set<string>()
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!
		if (arg.startsWith('--')) {
			const name = arg.slice(2)
			// A removed option is named however it is given, `--role editor` or `--role=editor`.
			const bare = name.split('=', 1)[0]!
			if (Object.hasOwn(removedOptions, bare)) throw new UsageError(removedOptions[bare]!)
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
/**
 * The Workspace's Access presets at this moment (`readWorkspaceAccessPresets`): the presets file
 * from `schemaVersion` 6, the built-in presets below it (Rule 01a11c09-cb79-744e-bbf6-ec38d6f159ba).
 */
function workspacePresets(context: Context): Promise<readonly LabelPreset[]> {
	return readWorkspaceAccessPresets(context.workspaceRoot)
}

/** A member's label among the Workspace's presets: the preset's name, or `Custom`. */
const access = (member: StoredMember, presets: readonly LabelPreset[]) => memberLabelName(memberLabel(member, presets))
const keyCount = (keys: readonly string[]) => `${keys.length} key${keys.length === 1 ? '' : 's'}`
const accessSummary = (member: StoredMember, presets: readonly LabelPreset[]) => `${access(member, presets)}, ${keyCount(member.keys)}`

/**
 * `--preset <name>` (Rule 01a11c09-ccc6-705c-96c6-9f4ba7a2ad58): the Workspace's preset of that
 * name at this moment, ignoring case as preset names are unique ignoring case; otherwise the
 * command fails naming the available presets. While a presets file broken on disk holds two
 * presets with one name, the first in file order is taken.
 */
function resolvePreset(name: string, presets: readonly LabelPreset[]): LabelPreset {
	const preset = presets.find(item => item.name.toLowerCase() === name.toLowerCase())
	if (preset) return preset
	throw new AccessError('access.preset_not_found', presets.length > 0
		? `No Access preset named ${JSON.stringify(name)}. The presets are ${presets.map(item => item.name).join(', ')}.`
		: `No Access preset named ${JSON.stringify(name)}: this Workspace has no presets. Give keys with --keys <k,...> or --all-keys.`)
}

/** A comma-separated key list (`--keys`, `--grant`, `--revoke`), each a permission key name. */
function keyListOption(raw: string): string[] {
	return normalizeKeys(raw.split(',').map(key => key.trim()).filter(key => key.length > 0))
}

/**
 * The note printed when a preset (Rule 01a11c74-26ef-7894-9b2c-2714f487aeb8) or `--all-keys`
 * (Clause 01a1144e-5660-7944-8946-079fe3065a47) gives an Agent its keys without the `humanOnly`
 * ones, naming the keys left out.
 */
function droppedKeysNote(source: string, keys: readonly string[], kind: MemberKind): string | undefined {
	const applied = keysOfPreset(kind, keys)
	const dropped = keys.filter(key => isCatalogKey(key) && !applied.includes(key))
	if (dropped.length === 0) return undefined
	return `  ${source} without ${dropped.join(', ')}: an Agent cannot hold humanOnly keys.`
}

/**
 * The notes printed after applying a preset: the `humanOnly` keys an Agent did not get, and the
 * preset's keys this UIUX version does not know, which are never applied (owner ruling of
 * 2026-10-11 on PR #189).
 */
function presetNotes(preset: LabelPreset, kind: MemberKind): string[] {
	const unknown = preset.keys.filter(key => !isCatalogKey(key))
	return [
		droppedKeysNote(`Applied the ${preset.name} preset`, preset.keys, kind),
		unknown.length > 0 ? `  The ${preset.name} preset holds ${unknown.join(', ')}, unknown to this UIUX version; ${unknown.length > 1 ? 'they were' : 'it was'} not applied.` : undefined,
	].filter((note): note is string => note !== undefined)
}

const ROLE_REMOVED = '--role was removed; give an Access preset with --preset <name>, such as --preset Editor.'

const when = (value: string | null) => value ? value.replace('T', ' ').slice(0, 16) : '-'

export async function runAccessCommand(options: AccessCommandOptions): Promise<number> {
	const out = options.stdout ?? (line => console.log(line))
	const err = options.stderr ?? (line => console.error(line))
	const cwd = options.cwd ?? process.cwd()
	const env = options.env ?? process.env
	const now = options.now ?? (() => new Date())
	const schemaPolicy = options.schemaPolicy ?? PRODUCT_WORKSPACE_SCHEMA_POLICY
	const [command, sub, ...rest] = options.argv
	try {
		if (!command || !(ACCESS_COMMANDS as readonly string[]).includes(command)) throw new UsageError(`Unknown access command ${JSON.stringify(command ?? '')}.`)
		const home = resolveUiuxHome(env)
		const spec = commandSpec(command, sub)
		if (!spec) throw new UsageError(`Unknown command: uiux ${[command, sub].filter(Boolean).join(' ')}.`)
		const parsed = parse(rest, ['workspace', ...spec.values], spec.flags, spec.removed)
		const workspaceArg = parsed.values.get('workspace')
		if (spec.positionals >= 0 && parsed.positionals.length !== spec.positionals)
			throw new UsageError(`uiux ${command} ${sub} takes ${spec.positionals === 0 ? 'no positional arguments' : `exactly ${spec.positionals} positional argument${spec.positionals > 1 ? 's' : ''}`}.`)
		const workspaceRoot = await requireWorkspace(workspaceArg, cwd, schemaPolicy)
		const context: Context = { home, workspaceRoot, parsed, out, err, now, cwd, env, schemaPolicy }
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
	env: Readonly<Record<string, string | undefined>>
	schemaPolicy: WorkspaceSchemaPolicy
}>

type CommandSpec = Readonly<{
	positionals: number
	values: readonly string[]
	flags: readonly string[]
	/** Options a command no longer takes, each with the usage error that names its replacement. */
	removed?: Readonly<Record<string, string>>
	run: (context: Context) => Promise<number>
}>

/**
 * The selected Workspace's real root: `--workspace <dir>` or the discovered Workspace
 * (`selectWorkspace`), after the shared entry check, before any lock, store or Workspace file is
 * touched. A directory without a manifest is refused, so a typo never creates a stray roster
 * (Clause 01a1144e-5632-75ed-baa5-03bb2d36de47).
 */
async function requireWorkspace(workspace: string | undefined, cwd: string, schemaPolicy: WorkspaceSchemaPolicy): Promise<string> {
	const selection = selectWorkspace({ ...(workspace === undefined ? {} : { workspace }), cwd }, schemaPolicy)
	if (!selection.ok) {
		if (selection.reason === 'not_found' || selection.reason === 'not_a_directory')
			throw new AccessError('access.workspace_invalid', `${resolve(cwd, workspace ?? '.')} is not an initialized UIUX Workspace (no ${layoutForSchemaVersion(CURRENT_WORKSPACE_SCHEMA_VERSION).manifestPath}). Run uiux init first.`)
		throw new AccessError('access.workspace_invalid', selection.message)
	}
	const manifestPath = selection.layout.manifestPath
	try {
		await stat(resolveWorkspacePath(selection.root, manifestPath))
	}
	catch {
		throw new AccessError('access.workspace_invalid', `${selection.root} is not an initialized UIUX Workspace (no ${manifestPath}). Run uiux init first.`)
	}
	return workspaceRealRoot(selection.root)
}

/** The layout of the Workspace at `root`, detected from where its manifest is. */
function workspaceLayout(root: string): Promise<WorkspaceLayout> {
	return detectWorkspaceLayout(root, CURRENT_WORKSPACE_SCHEMA_VERSION)
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
			positionals: 1, values: ['preset', 'keys', 'kind'], flags: ['all-keys'], removed: { role: ROLE_REMOVED },
			async run(context) {
				const { values, flags } = context.parsed
				const presetName = values.get('preset')
				const keyList = values.get('keys')
				if ([presetName !== undefined, keyList !== undefined, flags.has('all-keys')].filter(Boolean).length !== 1)
					throw new UsageError('uiux member add needs exactly one of --preset <name>, --keys <k,...> or --all-keys.')
				const kind = values.get('kind') ?? 'human'
				// An invalid kind is refused by addMember; meanwhile it is treated as human, which drops no key.
				const memberKind = isMemberKind(kind) ? kind : 'human'
				// Resolved before the store is opened, so a refused preset or key list writes nothing.
				const presets = await workspacePresets(context)
				const preset = presetName !== undefined ? resolvePreset(presetName, presets) : undefined
				const keys = preset
					? keysOfPreset(memberKind, preset.keys)
					: flags.has('all-keys')
						// Clause 01a1144e-5660-7944-8946-079fe3065a47: every catalog key, without the humanOnly keys for an Agent.
						? keysOfPreset(memberKind, PERMISSION_KEYS)
						: keyListOption(keyList!)
				const store = await requireStore(context)
				const member = await store.update(file => addMember(file, { nickname: context.parsed.positionals[0]!, keys, kind }, context.now()))
				context.out(`Added ${member.kind} member ${member.nickname} (${accessSummary(member, presets)}) to roster ${store.data.hint} for ${store.data.workspaceRoot}.`)
				const notes = preset
					? presetNotes(preset, member.kind)
					: [flags.has('all-keys') ? droppedKeysNote('Gave every catalog key', PERMISSION_KEYS, member.kind) : undefined].filter(note => note !== undefined)
				for (const note of notes) context.out(note)
				if (member.kind === 'agent') context.out(`  Next: uiux token create --workspace ${store.data.workspaceRoot} --member ${member.nickname}`)
				else context.out(`  Next: uiux invite create --workspace ${store.data.workspaceRoot} --member ${member.nickname}`)
				return 0
			},
		}
		case 'member list': return {
			positionals: 0, values: [], flags: ['keys'],
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
				// Clause 01a11c09-acaf-7fd0-a180-116c667961b4: the label in ACCESS, the key count in KEYS, or
				// with --keys the key set, last so a long set does not widen the other columns. A key unknown
				// to this UIUX version is kept but grants nothing (Rule 01a11c09-b7ec-786f-9723-eda32404d421).
				const keysCell = (keys: readonly string[]) => context.parsed.flags.has('keys')
					? keys.map(key => isCatalogKey(key) ? key : `${key} (unknown)`).join(', ') || '(none)'
					: String(keys.length)
				const presets = await workspacePresets(context)
				const members = summarizeMembers(file, context.now().getTime())
				context.out(table([
					['NICKNAME', 'KIND', 'ACCESS', 'TOKENS', 'SESSIONS', 'KEYS'],
					...members.map((member, index) => [member.nickname, member.kind, access(file.members[index]!, presets), String(member.activeTokens), String(member.activeSessions), keysCell(file.members[index]!.keys)]),
				]).join('\n'))
				return 0
			},
		}
		case 'member set': return {
			positionals: 1, values: ['preset', 'grant', 'revoke', 'nickname'], flags: [], removed: { role: ROLE_REMOVED },
			async run(context) {
				const { values } = context.parsed
				const presetName = values.get('preset')
				const grantList = values.get('grant')
				const revokeList = values.get('revoke')
				const nickname = values.get('nickname')
				if (presetName === undefined && grantList === undefined && revokeList === undefined && nickname === undefined)
					throw new UsageError('uiux member set needs --preset <name>, --grant <k,...>, --revoke <k,...> and/or --nickname <new>. The kind is immutable.')
				const grant = grantList !== undefined ? keyListOption(grantList) : []
				const revoke = revokeList !== undefined ? keyListOption(revokeList) : []
				const both = grant.filter(key => revoke.includes(key))
				if (both.length > 0) throw new UsageError(`--grant and --revoke both name ${both.join(', ')}.`)
				const presets = await workspacePresets(context)
				const preset = presetName !== undefined ? resolvePreset(presetName, presets) : undefined
				const changesKeys = preset !== undefined || grantList !== undefined || revokeList !== undefined
				let notHeld: string[] = []
				let notGranted: string[] = []
				const store = await requireStore(context)
				// The keys are computed from the roster read under the store's lock, so a concurrent writer's change is not lost.
				const member = await store.update((file) => {
					const current = requireMember(file, context.parsed.positionals[0]!)
					if (!changesKeys) return setMember(file, current.nickname, { ...(nickname !== undefined ? { nickname } : {}) })
					// A preset replaces the member's known keys with its own (Rule 01a11c09-b8c6-741e-b3b7-97f4840985c5)
					// and keeps the keys this version does not know (Rule 01a11c09-b7ec-786f-9723-eda32404d421; owner
					// ruling of 2026-10-11 on PR #189); --grant and --revoke then adjust it.
					const base = preset
						? [...keysOfPreset(current.kind, preset.keys), ...current.keys.filter(key => !isCatalogKey(key))]
						: current.keys
					const absent = revoke.filter(key => !base.includes(key))
					// A humanOnly key is never granted to an Agent, so revoking one changes nothing.
					notGranted = current.kind === 'agent' ? absent.filter(isHumanOnlyKey) : []
					notHeld = absent.filter(key => !notGranted.includes(key))
					const keys = [...base.filter(key => !revoke.includes(key)), ...grant]
					return setMember(file, current.nickname, { keys, ...(nickname !== undefined ? { nickname } : {}) })
				})
				if (notHeld.length > 0) context.err(`uiux: warning: ${member.nickname} did not hold ${notHeld.join(', ')}; nothing to revoke there.`)
				if (notGranted.length > 0)
					context.err(`uiux: warning: ${notGranted.join(', ')} ${notGranted.length > 1 ? 'are humanOnly keys' : 'is a humanOnly key'}, not granted to an Agent such as ${member.nickname}; nothing to revoke there.`)
				context.out(`Updated ${member.nickname}: ${member.kind}, ${accessSummary(member, presets)}.`)
				for (const note of preset ? presetNotes(preset, member.kind) : []) context.out(note)
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
			positionals: 0, values: ['member', 'label', 'expires'], flags: [],
			async run(context) {
				const nickname = context.parsed.values.get('member')
				if (!nickname) throw new UsageError('uiux token create requires --member <nick>.')
				const expiresInDays = parseExpiryDays(context.parsed.values.get('expires'))
				const store = await requireStore(context)
				const issued = await store.update(file => createToken(file, {
					nickname,
					...(context.parsed.values.has('label') ? { label: context.parsed.values.get('label') } : {}),
					...(expiresInDays !== undefined ? { expiresInDays } : {}),
				}, context.now()))
				const member = store.data.members.find(item => item.id === issued.entry.memberId)!
				context.out(`Created token ${issued.entry.id} for ${member.nickname} (${member.kind}, ${access(member, await workspacePresets(context))}; expires ${day(issued.entry.expiresAt)}).`)
				context.out(issued.credential)
				context.out('Store it in an environment variable such as UIUX_MCP_TOKEN, never commit it. It is shown only once.')
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
					['ID', 'MEMBER', 'LABEL', 'CREATED', 'EXPIRES', 'LAST USED', 'STATE'],
					...tokens.map(token => [token.id, nick(token.memberId), token.label || '-', day(token.createdAt), day(token.expiresAt), when(token.lastUsedAt), state(token)]),
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
				let origin: string
				const rawOrigin = context.parsed.values.get('origin')
				if (rawOrigin !== undefined) {
					try { origin = new URL(rawOrigin).origin }
					catch { throw new UsageError('--origin must be a URL such as http://127.0.0.1:3000.') }
				}
				else {
					origin = await defaultInviteOrigin(context)
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
					['ID', 'MEMBER', 'ORIGIN', 'CREATED', 'LAST SEEN', 'EXPIRES', 'USER AGENT'],
					// A session written before configured origins existed names its listener instead.
					...sessions.map(session => [session.id, nick(session.memberId), session.origin ?? session.listener ?? '-', when(session.createdAt), when(session.lastSeenAt), day(session.expiresAt), session.userAgent.slice(0, 60) || '-']),
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
				// The source gets the same entry check as the target before its lock is ever taken. Its one
				// exception is the old root of a Workspace uiux migrate relocated into the target.
				const sourceSelection = checkWorkspaceSelection(sourceRoot, context.schemaPolicy)
				const relocatedSource = !sourceSelection.ok && isRelocatedSourceOf(sourceRoot, context.workspaceRoot, context.schemaPolicy)
				if (!sourceSelection.ok && !relocatedSource) throw new AccessError('access.workspace_invalid', `The source ${sourceSelection.message}`)
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
				// A replacement keeps the target's last human manager (owner ruling 2 of 2026-10-11).
				if (replace) await assertReplacementKeepsManager(context.home, context.workspaceRoot, source)
				const history = await planHostHistoryCopy(context.home, sourceRoot, context.workspaceRoot)
				let copied: HostHistoryCopyResult | undefined
				if (history.sourceExists) {
					if (history.targetExists && !replace)
						throw new AccessError('access.roster_exists', `Workspace ${context.workspaceRoot} already has host history (${history.target.dir}). Pass --replace to discard it.`)
					// A running server keeps the target's history state in memory; replacing it underneath would corrupt it.
					await refuseWhileServed(context.workspaceRoot)
					// Under the target Workspace's persistence lock, which every writer of its history holds,
					// and where possible the source's, so no source writer or prune runs mid-copy.
					const persistence = new FileNativePersistence({ root: context.workspaceRoot, schemaPolicy: context.schemaPolicy })
					// A relocated source's lock file is the target's own, which this command already holds.
					const underSourceLock = <Result>(operation: () => Promise<Result>) => relocatedSource ? operation() : withSourceLock(sourceRoot, context.err, operation)
					try {
						copied = await persistence.withLock(() => underSourceLock(() => copyHostHistory(history, {
							replace,
							// A server may have started since the check above.
							beforeSwap: () => refuseWhileServed(context.workspaceRoot),
							blobAvailableElsewhere: digest => isRegularFile(resolveWorkspacePath(context.workspaceRoot, persistence.layout.artifactRelativePath(digest))),
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
						onManagerCheckSkipped: reason => context.err(`uiux: warning: the roster being replaced is damaged (${reason}); --replace repairs it without checking that a human member keeps members.manage.`),
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

/**
 * The default `invite create` origin (Clause 01a1144e-568f-7f4b-9d37-0aa746286a3f): the loopback
 * origin on the server's port. A server running on this host for the Workspace records its loopback
 * origin in its hold; otherwise the port is the one `uiux dev` would use (`NITRO_PORT`, `PORT`, 3000).
 */
async function defaultInviteOrigin(context: Context): Promise<string> {
	const hold = await workspaceLayout(context.workspaceRoot).then(layout => readActiveServerHold(context.workspaceRoot, layout)).catch(() => undefined)
	if (hold?.origin && hold.hostname === hostname()) {
		try {
			const recorded = new URL(hold.origin)
			if (recorded.protocol === 'http:' && isLoopbackHostname(recorded.hostname)) return recorded.origin
		}
		catch { /* fall back to the configured port */ }
	}
	return `http://${DEFAULT_LOOPBACK_BIND_HOST}:${resolveListenPort(context.env)}`
}

async function refuseWhileServed(workspaceRoot: string): Promise<void> {
	const hold = await readActiveServerHold(workspaceRoot, await workspaceLayout(workspaceRoot))
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
	const layout = await workspaceLayout(sourceRoot).catch(() => undefined)
	if (!layout || !(await lstat(resolveLayoutDirectory(sourceRoot, layout.metadataDir)).then(stats => stats.isDirectory(), () => false))) return operation()
	// Not read-only for the source: taking its persistence lock writes the lock file under the source's
	// metadata directory (removed on release), and acquiring the lock runs the source's pending-transaction
	// recovery, which can change its files to settle a multi-file write it left interrupted.
	let entered = false
	try {
		return await new FileNativePersistence({ root: sourceRoot, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY, layout }).withLock(async () => {
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
