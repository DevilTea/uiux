export type WidgetTreeNode = Readonly<{
	id: string
	type: string
	slotName?: string
	slotIndex?: number
	depth: number
	children: readonly WidgetTreeNode[]
}>

export type DeriveWidgetTreeResult =
	| Readonly<{ status: 'valid'; root: WidgetTreeNode }>
	| Readonly<{ status: 'invalid'; code: string; reason: string }>

/**
 * Derives a canonical hierarchical widget tree from View.ir.
 * Preserves child slot order and stable widget IDs and types.
 */
export function deriveWidgetTree(ir: unknown): DeriveWidgetTreeResult {
	if (!isRecord(ir))
		return { status: 'invalid', code: 'widget_tree.ir_not_object', reason: 'IR must be a JSON object.' }

	if (typeof ir.id !== 'string' || !ir.id)
		return { status: 'invalid', code: 'widget_tree.missing_id', reason: 'Widget node must have a non-empty string id.' }

	if (typeof ir.type !== 'string' || !ir.type)
		return { status: 'invalid', code: 'widget_tree.missing_type', reason: 'Widget node must have a non-empty string type.' }

	const rootNode = parseWidgetNode(ir, 0)
	if (!rootNode)
		return { status: 'invalid', code: 'widget_tree.unparsable_root', reason: 'Failed to parse root widget node.' }

	return { status: 'valid', root: rootNode }
}

function parseWidgetNode(
	raw: Record<string, unknown>,
	depth: number,
	slotName?: string,
	slotIndex?: number,
): WidgetTreeNode | undefined {
	const id = typeof raw.id === 'string' && raw.id ? raw.id : undefined
	const type = typeof raw.type === 'string' && raw.type ? raw.type : undefined
	if (!id || !type) return undefined

	const children: WidgetTreeNode[] = []
	if (isRecord(raw.slots)) {
		for (const [name, slotContent] of Object.entries(raw.slots)) {
			if (!Array.isArray(slotContent)) continue
			slotContent.forEach((childRaw, index) => {
				if (!isRecord(childRaw)) return
				const child = parseWidgetNode(childRaw, depth + 1, name, index)
				if (child) children.push(child)
			})
		}
	}

	return Object.freeze({
		id,
		type,
		...(slotName !== undefined ? { slotName } : {}),
		...(slotIndex !== undefined ? { slotIndex } : {}),
		depth,
		children: Object.freeze(children),
	})
}

export function flattenWidgetTree(root: WidgetTreeNode): readonly WidgetTreeNode[] {
	const result: WidgetTreeNode[] = [root]
	for (const child of root.children)
		result.push(...flattenWidgetTree(child))
	return Object.freeze(result)
}

export function findWidgetInTree(root: WidgetTreeNode, id: string): WidgetTreeNode | undefined {
	if (root.id === id) return root
	for (const child of root.children) {
		const found = findWidgetInTree(child, id)
		if (found) return found
	}
	return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
