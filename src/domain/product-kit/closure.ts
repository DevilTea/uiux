import type { ProductKit } from './schema'

type Registry = Pick<ProductKit, 'components'>

export type ComponentClosure =
	| Readonly<{ ok: true; components: readonly string[] }>
	| Readonly<{ ok: false; unknown: readonly string[] }>

/**
 * The `requires` closure of `names` (Rule 01a11bb1-a376-719c-86e0-5f5e4d11cb8c, Clause
 * 01a11bb1-8a44-793a-8306-21fea501acad): the named components in the order given, then every
 * component they require, transitively, in depth-first order, each once. A name that is not a
 * registry component makes it fail, naming every such name. A `requires` cycle ends at a
 * component already taken.
 */
export function componentClosure(registry: Registry, names: readonly string[]): ComponentClosure {
	const unknown = [...new Set(names.filter(name => !Object.hasOwn(registry.components, name)))]
	if (unknown.length > 0) return { ok: false, unknown }
	const taken = new Set<string>(names)
	const ordered = [...taken]
	const visit = (name: string) => {
		for (const required of registry.components[name]?.requires ?? []) {
			if (taken.has(required) || !Object.hasOwn(registry.components, required)) continue
			taken.add(required)
			ordered.push(required)
			visit(required)
		}
	}
	for (const name of [...taken]) visit(name)
	return { ok: true, components: ordered }
}

/** The registry components that require `name` directly. */
export function componentsRequiring(registry: Registry, name: string): string[] {
	return Object.entries(registry.components)
		.filter(([, component]) => component.requires?.includes(name) === true)
		.map(([dependent]) => dependent)
}

/**
 * The external packages the components `names` declare (`packages`), each once, sorted. `names`
 * is usually a closure from {@link componentClosure}.
 */
export function componentPackages(registry: Registry, names: readonly string[]): string[] {
	const packages = new Set<string>()
	for (const name of names) {
		for (const packageName of registry.components[name]?.packages ?? []) packages.add(packageName)
	}
	return [...packages].sort()
}
