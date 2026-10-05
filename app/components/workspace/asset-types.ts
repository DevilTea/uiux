import type { Diagnostic } from '../../composables/workbench-types'

/** Asset resource summaries and reads as the resource routes return them. */
export type AssetSummary = Readonly<{
	kind: 'asset'
	key: string
	revision: string
	diagnosticCount: number
	summary: Readonly<{ name?: string; mediaType?: string; contentFilename?: string }>
}>

export type AssetRead = Readonly<{
	kind: 'asset'
	key: string
	revision: string
	diagnostics: readonly Diagnostic[]
	resource: Readonly<{
		metadata?: Readonly<{ id?: string; name?: string; contentFilename?: string; mediaType?: string }>
		content?: Readonly<{ mediaType?: string; size?: number; digest?: string; contentUrl?: string }>
	}>
}>

/** A View that binds an Asset through `{ "$asset": id }`. */
export type AssetUse = Readonly<{ viewId: string; name: string }>

export type AssetEntry = Readonly<{
	key: string
	revision: string
	name: string
	contentFilename: string
	mediaType: string
	size?: number
	digest?: string
	diagnostics: readonly Diagnostic[]
	usedBy: readonly AssetUse[]
	read?: AssetRead
}>
