import type { Contour, ContourCommand, WidgetRect } from './protocol/schema'

type Bounds = Readonly<{ left: number; top: number; right: number; bottom: number }>
type GridEdge = Readonly<{ from: number; to: number }>

/**
 * Exact subtraction for the axis-aligned rectangular subset of the Preview visibility problem.
 *
 * This is intentionally narrower than the complete Part 4 occlusion baseline. Callers may use it
 * only when both the target and every proven-zero occluder are known to be axis-aligned rectangles;
 * rounded/basic-shape/transformed geometry must stay on another exact path or fail closed.
 *
 * Returned contours describe every disconnected surviving piece. Interior holes are deliberately
 * omitted: for each connected piece only its outermost boundary is returned, matching the canonical
 * Preview contour representation.
 *
 * An undefined result means the inputs cannot be represented safely in this exact subset. An empty
 * array means the target has no surviving positive-area piece.
 */
export function subtractAxisAlignedRectangularOcclusion(
	target: WidgetRect,
	occluders: readonly WidgetRect[],
): readonly Contour[] | undefined {
	const targetBounds = rectBounds(target)
	if (!targetBounds) return undefined
	if (target.width === 0 || target.height === 0) return Object.freeze([])

	const intersections: Bounds[] = []
	for (const occluder of occluders) {
		const bounds = rectBounds(occluder)
		if (!bounds) return undefined
		if (occluder.width === 0 || occluder.height === 0) continue
		const intersection = intersectBounds(targetBounds, bounds)
		if (intersection) intersections.push(intersection)
	}

	if (intersections.length === 0)
		return Object.freeze([rectangleContour(targetBounds)])

	const xs = sortedUnique([
		targetBounds.left,
		targetBounds.right,
		...intersections.flatMap(rect => [rect.left, rect.right]),
	])
	const ys = sortedUnique([
		targetBounds.top,
		targetBounds.bottom,
		...intersections.flatMap(rect => [rect.top, rect.bottom]),
	])
	const vertexColumns = xs.length
	const vertexRows = ys.length
	const cellColumns = vertexColumns - 1
	const cellRows = vertexRows - 1
	const vertexCount = vertexColumns * vertexRows
	const cellCount = cellColumns * cellRows
	if (!Number.isSafeInteger(vertexCount) || !Number.isSafeInteger(cellCount)) return undefined

	let coverageDelta: Float64Array
	let visible: Uint8Array
	let visited: Uint8Array
	try {
		coverageDelta = new Float64Array(vertexCount)
		visible = new Uint8Array(cellCount)
		visited = new Uint8Array(cellCount)
	}
	catch {
		return undefined
	}

	const xIndex = new Map(xs.map((value, index) => [value, index]))
	const yIndex = new Map(ys.map((value, index) => [value, index]))
	for (const rect of intersections) {
		const left = xIndex.get(rect.left)
		const right = xIndex.get(rect.right)
		const top = yIndex.get(rect.top)
		const bottom = yIndex.get(rect.bottom)
		if (left === undefined || right === undefined || top === undefined || bottom === undefined) return undefined
		addDelta(coverageDelta, vertexColumns, left, top, 1)
		addDelta(coverageDelta, vertexColumns, right, top, -1)
		addDelta(coverageDelta, vertexColumns, left, bottom, -1)
		addDelta(coverageDelta, vertexColumns, right, bottom, 1)
	}

	for (let y = 0; y < vertexRows; y++) {
		for (let x = 0; x < vertexColumns; x++) {
			const index = vertexIndex(x, y, vertexColumns)
			const left = x > 0 ? coverageDelta[index - 1]! : 0
			const above = y > 0 ? coverageDelta[index - vertexColumns]! : 0
			const diagonal = x > 0 && y > 0 ? coverageDelta[index - vertexColumns - 1]! : 0
			coverageDelta[index] = coverageDelta[index]! + left + above - diagonal
			if (x < cellColumns && y < cellRows && coverageDelta[index] === 0)
				visible[cellIndex(x, y, cellColumns)] = 1
		}
	}

	const contours: Contour[] = []
	for (let index = 0; index < cellCount; index++) {
		if (visible[index] === 0 || visited[index] !== 0) continue
		const component = collectComponent(index, visible, visited, cellColumns, cellRows)
		const contour = outerContourForComponent(component, xs, ys, cellColumns, cellRows)
		if (!contour) return undefined
		contours.push(contour)
	}

	return Object.freeze(contours)
}

function rectBounds(rect: WidgetRect): Bounds | undefined {
	if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
		|| rect.width < 0 || rect.height < 0)
		return undefined
	const right = rect.x + rect.width
	const bottom = rect.y + rect.height
	if (!Number.isFinite(right) || !Number.isFinite(bottom)) return undefined
	if ((rect.width > 0 && !(right > rect.x)) || (rect.height > 0 && !(bottom > rect.y)))
		return undefined
	return { left: rect.x, top: rect.y, right, bottom }
}

function intersectBounds(left: Bounds, right: Bounds): Bounds | undefined {
	const intersection = {
		left: Math.max(left.left, right.left),
		top: Math.max(left.top, right.top),
		right: Math.min(left.right, right.right),
		bottom: Math.min(left.bottom, right.bottom),
	}
	return intersection.left < intersection.right && intersection.top < intersection.bottom
		? intersection
		: undefined
}

function sortedUnique(values: readonly number[]): number[] {
	return [...new Set(values)].sort((left, right) => left - right)
}

function addDelta(delta: Float64Array, columns: number, x: number, y: number, amount: number): void {
	const index = vertexIndex(x, y, columns)
	delta[index] = delta[index]! + amount
}

function collectComponent(
	start: number,
	visible: Uint8Array,
	visited: Uint8Array,
	columns: number,
	rows: number,
): number[] {
	const component: number[] = []
	const queue = [start]
	visited[start] = 1
	for (let offset = 0; offset < queue.length; offset++) {
		const index = queue[offset]!
		component.push(index)
		const x = index % columns
		const y = Math.floor(index / columns)
		for (const [nextX, nextY] of [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]] as const) {
			if (nextX < 0 || nextX >= columns || nextY < 0 || nextY >= rows) continue
			const next = cellIndex(nextX, nextY, columns)
			if (visible[next] === 0 || visited[next] !== 0) continue
			visited[next] = 1
			queue.push(next)
		}
	}
	return component
}

function outerContourForComponent(
	component: readonly number[],
	xs: readonly number[],
	ys: readonly number[],
	cellColumns: number,
	cellRows: number,
): Contour | undefined {
	const vertexColumns = xs.length
	const cellCount = cellColumns * cellRows
	let componentMask: Uint8Array
	let exterior: Uint8Array
	try {
		componentMask = new Uint8Array(cellCount)
		exterior = new Uint8Array(cellCount)
	}
	catch {
		return undefined
	}
	for (const index of component) componentMask[index] = 1

	const queue: number[] = []
	const seedExterior = (x: number, y: number) => {
		const index = cellIndex(x, y, cellColumns)
		if (componentMask[index] !== 0 || exterior[index] !== 0) return
		exterior[index] = 1
		queue.push(index)
	}
	for (let x = 0; x < cellColumns; x++) {
		seedExterior(x, 0)
		if (cellRows > 1) seedExterior(x, cellRows - 1)
	}
	for (let y = 1; y + 1 < cellRows; y++) {
		seedExterior(0, y)
		if (cellColumns > 1) seedExterior(cellColumns - 1, y)
	}
	for (let offset = 0; offset < queue.length; offset++) {
		const index = queue[offset]!
		const x = index % cellColumns
		const y = Math.floor(index / cellColumns)
		for (const [nextX, nextY] of [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]] as const) {
			if (nextX < 0 || nextX >= cellColumns || nextY < 0 || nextY >= cellRows) continue
			const next = cellIndex(nextX, nextY, cellColumns)
			if (componentMask[next] !== 0 || exterior[next] !== 0) continue
			exterior[next] = 1
			queue.push(next)
		}
	}

	const facesExterior = (x: number, y: number): boolean =>
		x < 0 || x >= cellColumns || y < 0 || y >= cellRows
			|| exterior[cellIndex(x, y, cellColumns)] !== 0

	const edges: GridEdge[] = []
	for (const index of component) {
		const x = index % cellColumns
		const y = Math.floor(index / cellColumns)
		if (facesExterior(x, y - 1))
			edges.push({ from: vertexIndex(x, y, vertexColumns), to: vertexIndex(x + 1, y, vertexColumns) })
		if (facesExterior(x + 1, y))
			edges.push({ from: vertexIndex(x + 1, y, vertexColumns), to: vertexIndex(x + 1, y + 1, vertexColumns) })
		if (facesExterior(x, y + 1))
			edges.push({ from: vertexIndex(x + 1, y + 1, vertexColumns), to: vertexIndex(x, y + 1, vertexColumns) })
		if (facesExterior(x - 1, y))
			edges.push({ from: vertexIndex(x, y + 1, vertexColumns), to: vertexIndex(x, y, vertexColumns) })
	}

	const loop = traceSingleBoundaryLoop(edges)
	if (!loop) return undefined
	const simplified = simplifyGridLoop(loop, vertexColumns)
	if (simplified.length < 4) return undefined
	return contourFromGridLoop(simplified, xs, ys)
}

function traceSingleBoundaryLoop(edges: readonly GridEdge[]): number[] | undefined {
	if (edges.length === 0) return undefined
	const outgoing = new Map<number, number>()
	const incoming = new Map<number, number>()
	for (const edge of edges) {
		if (edge.from === edge.to || outgoing.has(edge.from)) return undefined
		outgoing.set(edge.from, edge.to)
		incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
	}
	if (outgoing.size !== incoming.size) return undefined
	for (const [vertex] of outgoing) {
		if (incoming.get(vertex) !== 1) return undefined
	}

	const start = edges[0]!.from
	const loop: number[] = []
	const seen = new Set<number>()
	let current = start
	while (true) {
		if (seen.has(current)) {
			if (current !== start || seen.size !== outgoing.size) return undefined
			break
		}
		seen.add(current)
		loop.push(current)
		const next = outgoing.get(current)
		if (next === undefined) return undefined
		current = next
	}
	return loop
}

function simplifyGridLoop(loop: readonly number[], columns: number): number[] {
	return loop.filter((vertex, index) => {
		const previous = gridPoint(loop[(index + loop.length - 1) % loop.length]!, columns)
		const current = gridPoint(vertex, columns)
		const next = gridPoint(loop[(index + 1) % loop.length]!, columns)
		return !((previous.x === current.x && current.x === next.x)
			|| (previous.y === current.y && current.y === next.y))
	})
}

function contourFromGridLoop(loop: readonly number[], xs: readonly number[], ys: readonly number[]): Contour {
	const columns = xs.length
	const points = loop.map(vertex => {
		const point = gridPoint(vertex, columns)
		return { x: xs[point.x]!, y: ys[point.y]! }
	})
	const commands: ContourCommand[] = [
		Object.freeze({ op: 'moveTo' as const, ...points[0]! }),
		...points.slice(1).map(point => Object.freeze({ op: 'lineTo' as const, ...point })),
		Object.freeze({ op: 'close' as const }),
	]
	return Object.freeze({ commands: Object.freeze(commands) })
}

function rectangleContour(bounds: Bounds): Contour {
	const commands: ContourCommand[] = [
		Object.freeze({ op: 'moveTo', x: bounds.left, y: bounds.top }),
		Object.freeze({ op: 'lineTo', x: bounds.right, y: bounds.top }),
		Object.freeze({ op: 'lineTo', x: bounds.right, y: bounds.bottom }),
		Object.freeze({ op: 'lineTo', x: bounds.left, y: bounds.bottom }),
		Object.freeze({ op: 'close' }),
	]
	return Object.freeze({ commands: Object.freeze(commands) })
}

function gridPoint(vertex: number, columns: number): Readonly<{ x: number; y: number }> {
	return { x: vertex % columns, y: Math.floor(vertex / columns) }
}

function vertexIndex(x: number, y: number, columns: number): number {
	return y * columns + x
}

function cellIndex(x: number, y: number, columns: number): number {
	return y * columns + x
}
