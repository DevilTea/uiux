import { describe, expect, it } from 'vitest'
import {
	deriveWidgetTree,
	flattenWidgetTree,
	findWidgetInTree,
} from '../src/preview/widget-tree'

describe('canonical widget tree derivation', () => {
	it('derives a single RootShell node from empty View IR', () => {
		const ir = {
			type: 'RootShell',
			id: 'root',
			slots: { content: [] },
		}
		const result = deriveWidgetTree(ir)
		expect(result.status).toBe('valid')
		if (result.status !== 'valid') return

		expect(result.root.id).toBe('root')
		expect(result.root.type).toBe('RootShell')
		expect(result.root.depth).toBe(0)
		expect(result.root.children).toHaveLength(0)
	})

	it('preserves child slot order within one slot', () => {
		const ir = {
			type: 'RootShell',
			id: 'root',
			slots: {
				content: [
					{ id: 'first', type: 'Header' },
					{ id: 'second', type: 'Content' },
					{ id: 'third', type: 'Footer' },
				],
			},
		}
		const result = deriveWidgetTree(ir)
		expect(result.status).toBe('valid')
		if (result.status !== 'valid') return

		expect(result.root.children).toHaveLength(3)
		expect(result.root.children.map(c => c.id)).toEqual(['first', 'second', 'third'])
		expect(result.root.children.map(c => c.type)).toEqual(['Header', 'Content', 'Footer'])
		expect(result.root.children.map(c => c.slotName)).toEqual(['content', 'content', 'content'])
		expect(result.root.children.map(c => c.slotIndex)).toEqual([0, 1, 2])
		expect(result.root.children.every(c => c.depth === 1)).toBe(true)
	})

	it('derives nested multi-slot trees maintaining hierarchy and depth', () => {
		const ir = {
			type: 'RootShell',
			id: 'root',
			slots: {
				content: [
					{
						id: 'layout',
						type: 'SplitLayout',
						slots: {
							sidebar: [{ id: 'nav', type: 'NavMenu' }],
							main: [
								{ id: 'card1', type: 'Card' },
								{ id: 'card2', type: 'Card' },
							],
						},
					},
				],
			},
		}
		const result = deriveWidgetTree(ir)
		expect(result.status).toBe('valid')
		if (result.status !== 'valid') return

		const layout = result.root.children[0]!
		expect(layout.id).toBe('layout')
		expect(layout.depth).toBe(1)
		expect(layout.children).toHaveLength(3)

		const nav = layout.children[0]!
		expect(nav.id).toBe('nav')
		expect(nav.slotName).toBe('sidebar')
		expect(nav.depth).toBe(2)

		const card1 = layout.children[1]!
		expect(card1.id).toBe('card1')
		expect(card1.slotName).toBe('main')
		expect(card1.slotIndex).toBe(0)
		expect(card1.depth).toBe(2)

		const card2 = layout.children[2]!
		expect(card2.id).toBe('card2')
		expect(card2.slotName).toBe('main')
		expect(card2.slotIndex).toBe(1)
		expect(card2.depth).toBe(2)
	})

	it('flattens tree into a pre-order list', () => {
		const ir = {
			type: 'RootShell',
			id: 'root',
			slots: {
				content: [
					{
						id: 'a',
						type: 'Box',
						slots: {
							inner: [{ id: 'b', type: 'Text' }],
						},
					},
					{ id: 'c', type: 'Button' },
				],
			},
		}
		const result = deriveWidgetTree(ir)
		if (result.status !== 'valid') throw new Error('Expected valid tree')

		const flattened = flattenWidgetTree(result.root)
		expect(flattened.map(n => n.id)).toEqual(['root', 'a', 'b', 'c'])
	})

	it('finds widgets in tree by ID', () => {
		const ir = {
			type: 'RootShell',
			id: 'root',
			slots: {
				content: [
					{
						id: 'parent',
						type: 'Container',
						slots: {
							default: [{ id: 'target-node', type: 'Target' }],
						},
					},
				],
			},
		}
		const result = deriveWidgetTree(ir)
		if (result.status !== 'valid') throw new Error('Expected valid tree')

		const found = findWidgetInTree(result.root, 'target-node')
		expect(found).toBeDefined()
		expect(found?.type).toBe('Target')
		expect(found?.slotName).toBe('default')

		expect(findWidgetInTree(result.root, 'non-existent')).toBeUndefined()
	})

	it('rejects invalid or malformed IR inputs', () => {
		expect(deriveWidgetTree(null)).toEqual({ status: 'invalid', reason: 'IR must be a JSON object.' })
		expect(deriveWidgetTree('string')).toEqual({ status: 'invalid', reason: 'IR must be a JSON object.' })
		expect(deriveWidgetTree({})).toEqual({ status: 'invalid', reason: 'Widget node must have a non-empty string id.' })
		expect(deriveWidgetTree({ id: 'root' })).toEqual({ status: 'invalid', reason: 'Widget node must have a non-empty string type.' })
	})
})
