import {
	hasAsciiControlCharacter,
	isSafeRelativePath,
	jsonPointer,
	rejectUnknownKeys,
	validateJsonValue,
	Validator,
	type ValidationResult,
} from '../validation'
import { isPortableAdapterModuleSpecifier, validateAdapterSelections, type WorkspaceAdapterSelection } from '../workspace/schema'

export { PRODUCT_KIT_SCHEMA_VERSION } from '../workspace/schema'

/** Clause 01a11bb1-8e31-7b25-b6b8-da667b201670: the Product Kit file's path under the Workspace root, kind and key. */
export const PRODUCT_KIT_FILENAME = 'product-kit.json'
export const PRODUCT_KIT_RESOURCE_KIND = 'product-kit'
export const PRODUCT_KIT_RESOURCE_KEY = 'product-kit'

/** Clause 01a11bb1-8a44-793a-8306-21fea501acad: the layers of a registry component. */
export const PRODUCT_KIT_COMPONENT_LAYERS = Object.freeze(['design-system', 'product'] as const)
export type ProductKitComponentLayer = typeof PRODUCT_KIT_COMPONENT_LAYERS[number]

const COMPONENT_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u
/** An npm package name: an optional `@scope/` and a lowercase, URL-safe name of at most 214 characters. */
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/u
const PACKAGE_NAME_MAX_LENGTH = 214
/** An HTML attribute name: non-empty, without whitespace, `"`, `'`, `>`, `/`, `=` or an ASCII control character. */
function isAttributeName(name: string): boolean {
	return /^[^\s"'>/=]+$/u.test(name) && !hasAsciiControlCharacter(name)
}

export type ProductKitComponent = {
	files: string[]
	requires?: string[]
	packages?: string[]
	layer: ProductKitComponentLayer
}

export type ProductKitWidgetMapping = { component: string } | { import: string; export: string }

/**
 * The Product Kit file (Clause 01a11bb1-8e31-7b25-b6b8-da667b201670): the six required members, any
 * of which may be empty.
 */
export type ProductKit = {
	designSystems: string[]
	adapters: WorkspaceAdapterSelection[]
	styles: string[]
	themes: Record<string, Record<string, string>>
	components: Record<string, ProductKitComponent>
	widgets: Record<string, ProductKitWidgetMapping>
}

const PRODUCT_KIT_MEMBERS = Object.freeze(['designSystems', 'adapters', 'styles', 'themes', 'components', 'widgets'] as const)

/** A Product Kit with every member empty: what a new Workspace starts with. */
export function emptyProductKit(): ProductKit {
	return { designSystems: [], adapters: [], styles: [], themes: {}, components: {}, widgets: {} }
}

export function isProductKitPackageName(value: unknown): value is string {
	return typeof value === 'string' && value.length <= PACKAGE_NAME_MAX_LENGTH && PACKAGE_NAME_PATTERN.test(value)
}

/**
 * Validates the shape of the Product Kit file. It checks what the file alone decides: the members
 * and their shapes (Clauses 01a11bb1-8e31-…, 01a11bb1-8e98-…, 01a11bb1-8efc-…, 01a1144e-538e-…,
 * 01a11bb1-8a44-… and 01a11bb1-8aa9-…), including that `requires` and `widgets` name registry
 * components of the same file. What needs the kit project (declared dependencies, files that exist,
 * the wrapper entry, the build output) is checked where the kit is read, not here.
 */
export function validateProductKit(input: unknown): ValidationResult<ProductKit> {
	const v = new Validator()
	const root = v.object(input, '')
	if (!root)
		return v.finish<ProductKit>(input)
	validateJsonValue(input, '', v)
	rejectUnknownKeys(root, PRODUCT_KIT_MEMBERS, '', v)
	for (const member of PRODUCT_KIT_MEMBERS) {
		if (!Object.hasOwn(root, member))
			v.issue('schema.required_field', `/${member}`, `The Product Kit file requires ${member}, which may be empty.`)
	}

	if (Object.hasOwn(root, 'designSystems'))
		validatePackageNames(root.designSystems, '/designSystems', v)
	if (Object.hasOwn(root, 'adapters'))
		validateAdapterSelections(root.adapters, '/adapters', v)
	if (Object.hasOwn(root, 'styles')) {
		v.array(root.styles, '/styles')?.forEach((style, index) => {
			if (!isStyleSpecifier(style))
				v.issue('product_kit.invalid_style_specifier', jsonPointer('/styles', index), 'A styles entry is a bare package specifier or a ./ specifier relative to kit/.')
		})
	}
	if (Object.hasOwn(root, 'themes'))
		validateThemes(root.themes, v)

	const components = Object.hasOwn(root, 'components') ? v.object(root.components, '/components') : undefined
	const componentNames = new Set(components ? Object.keys(components) : [])
	if (components) {
		for (const [name, entry] of Object.entries(components))
			validateComponent(name, entry, componentNames, v)
	}
	if (Object.hasOwn(root, 'widgets'))
		validateWidgets(root.widgets, componentNames, v)

	return v.finish<ProductKit>(input)
}

function validatePackageNames(input: unknown, path: string, v: Validator): void {
	const seen = new Set<string>()
	v.array(input, path)?.forEach((name, index) => {
		const itemPath = jsonPointer(path, index)
		if (!isProductKitPackageName(name)) {
			v.issue('product_kit.invalid_package_name', itemPath, 'Expected an npm package name.')
			return
		}
		if (seen.has(name)) v.issue('identity.duplicate', itemPath, 'Package name is duplicated.')
		seen.add(name)
	})
}

function validateThemes(input: unknown, v: Validator): void {
	const themes = v.object(input, '/themes')
	if (!themes) return
	for (const [themeId, attributes] of Object.entries(themes)) {
		const themePath = jsonPointer('/themes', themeId)
		if (themeId.length === 0)
			v.issue('workspace.empty_registry_key', '/themes', 'Theme IDs are non-empty strings.')
		const entry = v.object(attributes, themePath)
		if (!entry) continue
		for (const [name, value] of Object.entries(entry)) {
			const attributePath = jsonPointer(themePath, name)
			if (!isAttributeName(name))
				v.issue('product_kit.invalid_theme_attribute', attributePath, 'A theme root attribute name is a valid HTML attribute name.')
			if (typeof value !== 'string')
				v.issue('schema.expected_string', attributePath, 'A theme root attribute value is a string.')
		}
	}
}

function validateComponent(name: string, input: unknown, componentNames: ReadonlySet<string>, v: Validator): void {
	const path = jsonPointer('/components', name)
	if (!COMPONENT_NAME_PATTERN.test(name))
		v.issue('product_kit.invalid_component_name', path, 'A component name is lowercase words joined by single hyphens.')
	const component = v.object(input, path)
	if (!component) return
	rejectUnknownKeys(component, ['files', 'requires', 'packages', 'layer'], path, v)

	const files = v.array(component.files, `${path}/files`)
	const seenFiles = new Set<string>()
	files?.forEach((file, index) => {
		const filePath = jsonPointer(`${path}/files`, index)
		if (!isSafeRelativePath(file) || !file.startsWith('src/') || file.length === 'src/'.length) {
			v.issue('product_kit.invalid_component_file', filePath, 'A component file path is relative to kit/ and lies under kit/src/.')
			return
		}
		if (seenFiles.has(file)) v.issue('identity.duplicate', filePath, 'Component file path is duplicated.')
		seenFiles.add(file)
	})

	if (Object.hasOwn(component, 'requires')) {
		const seen = new Set<string>()
		v.array(component.requires, `${path}/requires`)?.forEach((required, index) => {
			const requiredPath = jsonPointer(`${path}/requires`, index)
			if (typeof required !== 'string' || !componentNames.has(required)) {
				v.issue('product_kit.unknown_component', requiredPath, 'requires names other components of this registry.')
				return
			}
			if (required === name) v.issue('product_kit.unknown_component', requiredPath, 'A component does not require itself.')
			if (seen.has(required)) v.issue('identity.duplicate', requiredPath, 'Required component is duplicated.')
			seen.add(required)
		})
	}
	if (Object.hasOwn(component, 'packages'))
		validatePackageNames(component.packages, `${path}/packages`, v)
	if (!(PRODUCT_KIT_COMPONENT_LAYERS as readonly unknown[]).includes(component.layer))
		v.issue('product_kit.invalid_component_layer', `${path}/layer`, `layer is ${PRODUCT_KIT_COMPONENT_LAYERS.join(' or ')}.`)
}

function validateWidgets(input: unknown, componentNames: ReadonlySet<string>, v: Validator): void {
	const widgets = v.object(input, '/widgets')
	if (!widgets) return
	for (const [widgetType, mapping] of Object.entries(widgets)) {
		const path = jsonPointer('/widgets', widgetType)
		if (widgetType.length === 0)
			v.issue('workspace.empty_registry_key', '/widgets', 'Widget types are non-empty strings.')
		const entry = v.object(mapping, path)
		if (!entry) continue
		if (Object.hasOwn(entry, 'component')) {
			rejectUnknownKeys(entry, ['component'], path, v)
			if (typeof entry.component !== 'string' || !componentNames.has(entry.component))
				v.issue('product_kit.unknown_component', `${path}/component`, 'component names a component of this registry.')
			continue
		}
		rejectUnknownKeys(entry, ['import', 'export'], path, v)
		if (!isBareSpecifier(entry.import))
			v.issue('product_kit.invalid_widget_import', `${path}/import`, 'import names an external package with a bare specifier.')
		if (typeof entry.export !== 'string' || entry.export.length === 0)
			v.issue('product_kit.invalid_widget_import', `${path}/export`, 'export names one export of that package.')
	}
}

/**
 * A `styles` entry (Clause 01a11bb1-8e98-7270-9662-682c048f9929): a portable specifier whose path
 * part has no empty, `.` or `..` segment, so a `./` entry stays inside `kit/` and a bare entry names
 * a path inside its package.
 */
function isStyleSpecifier(value: unknown): value is string {
	if (!isPortableAdapterModuleSpecifier(value)) return false
	return isSafeRelativePath(value.startsWith('./') ? value.slice(2) : value)
}

function isBareSpecifier(value: unknown): value is string {
	return isPortableAdapterModuleSpecifier(value) && !value.startsWith('./')
}
