export interface DiagnosticItem {
	code: string
	path: string
	message: string
}

export interface ResolvedCheckItem {
	source: 'View' | 'Workspace'
	code: string
	path: string
	message: string
	resolvedWidgetId?: string
}

/**
 * Resolves a diagnostic item's target widget identity from canonical View IR and known widget IDs.
 *
 * Rules:
 * 1. /ir or /ir/ resolves to 'root' if known.
 * 2. Slot indexed paths (/ir/slots/<slot>/<idx>) resolve to the widget ID at that slot index.
 * 3. Exact matching of known widget IDs in path, #<id>, or "<id>".
 * 4. Otherwise strictly returns undefined (never guesses or arbitrarily rebinds).
 */
export function resolveDiagnosticWidgetTarget(
	diag: DiagnosticItem,
	viewIr: unknown,
	knownWidgetIds: ReadonlySet<string>,
): string | undefined {
	const path = diag.path || ''

	// Case 1: Exact root path
	if (path === '/ir' || path === '/ir/') {
		return knownWidgetIds.has('root') ? 'root' : undefined
	}

	// Case 2: Slot index path like /ir/slots/content/0
	const slotMatch = path.match(/^\/ir\/slots\/([^/]+)\/(\d+)/)
	if (slotMatch && viewIr && typeof viewIr === 'object') {
		const slotName = slotMatch[1]!
		const slotIndex = Number(slotMatch[2])
		const slots = (viewIr as Record<string, unknown>).slots
		if (slots && typeof slots === 'object') {
			const arr = (slots as Record<string, unknown>)[slotName]
			if (Array.isArray(arr) && arr[slotIndex] && typeof arr[slotIndex] === 'object') {
				const id = arr[slotIndex].id
				if (typeof id === 'string' && knownWidgetIds.has(id)) {
					return id
				}
			}
		}
	}

	// Case 3: Path or message explicitly references known widget id
	for (const id of knownWidgetIds) {
		if (id !== 'root' && (path.includes(id) || diag.message.includes(`#${id}`) || diag.message.includes(`"${id}"`))) {
			return id
		}
	}

	// Strictly unresolved; never guess or rebind
	return undefined
}

/**
 * Collates and resolves all diagnostics while preserving exact incoming issue ordering.
 */
export function resolveAllChecks(
	viewDiagnostics: readonly DiagnosticItem[] | undefined,
	workspaceDiagnostics: readonly DiagnosticItem[] | undefined,
	viewIr: unknown,
	knownWidgetIds: ReadonlySet<string>,
): ResolvedCheckItem[] {
	const items: ResolvedCheckItem[] = []

	// Preserve issue ordering from View diagnostics
	for (const d of (viewDiagnostics || [])) {
		items.push({
			source: 'View',
			code: d.code,
			path: d.path,
			message: d.message,
			resolvedWidgetId: resolveDiagnosticWidgetTarget(d, viewIr, knownWidgetIds),
		})
	}

	// Preserve issue ordering from Workspace diagnostics
	for (const d of (workspaceDiagnostics || [])) {
		items.push({
			source: 'Workspace',
			code: d.code,
			path: d.path,
			message: d.message,
			resolvedWidgetId: undefined, // Workspace diagnostics do not bind to View widgets
		})
	}

	return items
}
