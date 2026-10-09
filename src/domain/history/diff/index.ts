import type { JsonValue } from '../../validation'
import { HISTORY_RESOURCE_KINDS } from '../constants'
import { diffAsset, type AssetDiff, type AssetFiles } from './asset'
import { diffFlow, type FlowDiff } from './flow'
import { compareCodeUnits, diffJson, type JsonPointerChange } from './json-pointer'
import { diffLocale, type LocaleDiff } from './locale'
import { diffWorkspaceSettings, type WorkspaceSettingsDiff } from './settings'
import { diffView, type ViewDiff } from './view'

export * from './asset'
export * from './flow'
export * from './json-pointer'
export * from './locale'
export * from './settings'
export * from './view'

/** One file of a resource on one side of a comparison: its digest and, when read, its bytes. */
export type ResourceFile = Readonly<{ digest: string; bytes?: Uint8Array }>

/** A resource's files on one side, by Workspace-relative path; `undefined` when it is absent there. */
export type ResourceFiles = ReadonlyMap<string, ResourceFile>

/** The JSON-pointer structural diff (Rule 01a11a5e-1134-755c-a740-a619a7943fe0). */
export type StructuralDiff = Readonly<{ type: 'structural'; changes: readonly JsonPointerChange[] }>

/** Files that are not JSON, compared by digest only. */
export type OpaqueDiff = Readonly<{ type: 'opaque'; files: readonly Readonly<{ path: string; before?: string; after?: string }>[] }>

/**
 * A resource kind this build does not know (the kind set is open, seam 3): it is listed with its
 * revision status only, and no diff of its content is made.
 */
export type UnsupportedKindDiff = Readonly<{ type: 'unsupported_kind' }>

export type ResourceDiff = ViewDiff | FlowDiff | LocaleDiff | WorkspaceSettingsDiff | AssetDiff | StructuralDiff | OpaqueDiff | UnsupportedKindDiff

/** True for a kind this build can diff at all (Clause 01a11a5e-1fc4-7bf0-a402-61c345f454c2's list). */
export function isDiffableResourceKind(kind: string): boolean {
	return (HISTORY_RESOURCE_KINDS as readonly string[]).includes(kind)
}

/**
 * The semantic diff of one resource between two sides (Rule 01a11a5e-0ddc-7d9d-83b9-5366d0ac44dd),
 * from the files of each side, already upgraded to one schema version by the caller. A View, a
 * Flow, a Locale, the Workspace settings and an Asset get their semantic diff; any other known kind,
 * and a known kind whose file is JSON of another shape, gets the structural diff; files that are not
 * JSON are compared by digest; an unknown kind gets no diff.
 */
export function diffResource(kind: string, before: ResourceFiles | undefined, after: ResourceFiles | undefined): ResourceDiff {
	if (!isDiffableResourceKind(kind)) return { type: 'unsupported_kind' }
	if (kind === 'asset') return diffAsset(assetFiles(before), assetFiles(after))
	const left = decodeSingleJson(before)
	const right = decodeSingleJson(after)
	if (!left.ok || !right.ok) return opaque(before, after)
	const objects = (left.value === undefined || isObject(left.value)) && (right.value === undefined || isObject(right.value))
	if (objects) {
		switch (kind) {
			case 'view': return diffView(left.value, right.value)
			case 'flow': return diffFlow(left.value, right.value)
			case 'locale': return diffLocale(left.value, right.value)
			case 'workspace': return diffWorkspaceSettings(left.value, right.value)
		}
	}
	if (kind === 'workspace') return diffWorkspaceSettings(left.value, right.value)
	return { type: 'structural', changes: diffJson(left.value, right.value) }
}

function isObject(value: JsonValue): boolean {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type Decoded = Readonly<{ ok: true; value: JsonValue | undefined } | { ok: false }>

/** The JSON value of a one-file resource; not ok when the side has several files or unreadable bytes. */
function decodeSingleJson(files: ResourceFiles | undefined): Decoded {
	if (!files || files.size === 0) return { ok: true, value: undefined }
	if (files.size !== 1) return { ok: false }
	const bytes = [...files.values()][0]!.bytes
	if (!bytes) return { ok: false }
	try { return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as JsonValue } }
	catch { return { ok: false } }
}

function opaque(before: ResourceFiles | undefined, after: ResourceFiles | undefined): OpaqueDiff {
	const paths = [...new Set([...(before?.keys() ?? []), ...(after?.keys() ?? [])])].sort(compareCodeUnits)
	const files: { path: string; before?: string; after?: string }[] = []
	for (const path of paths) {
		const was = before?.get(path)?.digest
		const now = after?.get(path)?.digest
		if (was !== now) files.push({ path, ...(was === undefined ? {} : { before: was }), ...(now === undefined ? {} : { after: now }) })
	}
	return { type: 'opaque', files }
}

function assetFiles(files: ResourceFiles | undefined): AssetFiles | undefined {
	if (!files) return undefined
	return new Map([...files].map(([path, file]) => [path.slice(path.lastIndexOf('/') + 1), file]))
}
