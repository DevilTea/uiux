/**
 * The kit project's file listing (`GET /api/product-kit/files`, Clause 01a11bb1-b1c2-716f-b611-f8d7b2a934d9)
 * as a tree for the Files section of the Product Kit page. The listing names regular files only, by
 * their path relative to `kit/`; directories are inferred from those paths.
 */
export type KitFileEntry = Readonly<{ path: string; size: number }>

export type KitTreeDirectory = Readonly<{ kind: 'directory'; name: string; path: string; children: readonly KitTreeNode[] }>
export type KitTreeFile = Readonly<{ kind: 'file'; name: string; path: string; size: number }>
export type KitTreeNode = KitTreeDirectory | KitTreeFile

type MutableDirectory = { name: string; path: string; directories: Map<string, MutableDirectory>; files: KitTreeFile[] }

function byName(left: Readonly<{ name: string }>, right: Readonly<{ name: string }>): number {
	return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

function freeze(directory: MutableDirectory): KitTreeNode[] {
	const directories = [...directory.directories.values()].sort(byName).map((child): KitTreeDirectory => ({ kind: 'directory', name: child.name, path: child.path, children: freeze(child) }))
	return [...directories, ...directory.files.sort(byName)]
}

/** Directories first, then files, each sorted by name in code-unit order. */
export function kitFileTree(files: readonly KitFileEntry[]): KitTreeNode[] {
	const root: MutableDirectory = { name: '', path: '', directories: new Map(), files: [] }
	for (const file of files) {
		const segments = file.path.split('/')
		let directory = root
		for (const segment of segments.slice(0, -1)) {
			let child = directory.directories.get(segment)
			if (!child) {
				child = { name: segment, path: directory.path ? `${directory.path}/${segment}` : segment, directories: new Map(), files: [] }
				directory.directories.set(segment, child)
			}
			directory = child
		}
		directory.files.push({ kind: 'file', name: segments.at(-1)!, path: file.path, size: file.size })
	}
	return freeze(root)
}

export type KitTreeRow = Readonly<{ node: KitTreeNode; level: number; expanded: boolean; setSize: number; position: number }>

/** The rows a tree view shows: every top-level node, and the children of each expanded directory. */
export function visibleKitTreeRows(nodes: readonly KitTreeNode[], expanded: ReadonlySet<string>, level = 1): KitTreeRow[] {
	const rows: KitTreeRow[] = []
	nodes.forEach((node, index) => {
		const open = node.kind === 'directory' && expanded.has(node.path)
		rows.push({ node, level, expanded: open, setSize: nodes.length, position: index + 1 })
		if (node.kind === 'directory' && open) rows.push(...visibleKitTreeRows(node.children, expanded, level + 1))
	})
	return rows
}

/** Every directory that holds `path`, so revealing a file expands its ancestors. */
export function kitPathAncestors(path: string): string[] {
	const segments = path.split('/').slice(0, -1)
	return segments.map((_, index) => segments.slice(0, index + 1).join('/'))
}
