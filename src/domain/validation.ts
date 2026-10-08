/** Shared, dependency-free validation primitives for canonical domain resources. */

export type Diagnostic = Readonly<{
	code: string
	path: string
	message: string
}>

export type ValidationResult<T> =
	| Readonly<{ ok: true; value: T; diagnostics: readonly [] }>
	| Readonly<{ ok: false; diagnostics: readonly Diagnostic[] }>

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export const FULL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/

export function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

export function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key)
}

export function isFullUuid(value: unknown): value is string {
	return typeof value === 'string' && FULL_UUID_PATTERN.test(value)
}

export function isSha256Digest(value: unknown): value is string {
	return typeof value === 'string' && SHA256_PATTERN.test(value)
}

export function isAbsoluteUri(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || /\s/u.test(value) || hasAsciiControlCharacter(value))
		return false
	if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) || /%(?![0-9A-Fa-f]{2})/u.test(value))
		return false
	try {
		const parsed = new URL(value)
		return parsed.protocol.length > 1
	}
	catch {
		return false
	}
}

/** A non-empty `/`-separated relative path with no empty, `.` or `..` segment, backslash or ASCII control character. */
export function isSafeRelativePath(path: unknown): path is string {
	return typeof path === 'string'
		&& path.length > 0
		&& !path.includes('\\')
		&& !hasAsciiControlCharacter(path)
		&& path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

export function hasAsciiControlCharacter(value: string): boolean {
	return [...value].some(character => {
		const code = character.charCodeAt(0)
		return code <= 0x1f || code === 0x7f
	})
}

/** Accept only the casing returned by the platform's BCP-47 canonicalizer. */
export function isCanonicalLocaleFilename(filename: unknown): filename is string {
	if (typeof filename !== 'string' || !filename.endsWith('.json'))
		return false
	const tag = filename.slice(0, -'.json'.length)
	return isCanonicalLocaleTag(tag)
}

export function isCanonicalLocaleTag(tag: unknown): tag is string {
	if (typeof tag !== 'string' || !tag)
		return false
	try {
		return Intl.getCanonicalLocales(tag)[0] === tag
	}
	catch {
		return false
	}
}

export function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return true
	if (typeof value === 'number')
		return Number.isFinite(value)
	if (typeof value !== 'object')
		return false
	if (seen.has(value))
		return false
	seen.add(value)
	let valid: boolean
	if (Array.isArray(value)) {
		const keys = Object.keys(value)
		valid = keys.length === value.length
			&& keys.every((key, index) => key === String(index))
			&& value.every(item => isJsonValue(item, seen))
	}
	else {
		const prototype = Object.getPrototypeOf(value)
		valid = (prototype === Object.prototype || prototype === null)
			&& Object.values(value).every(item => isJsonValue(item, seen))
	}
	seen.delete(value)
	return valid
}

export function isJsonObject(value: unknown): value is JsonObject {
	return isRecord(value) && isJsonValue(value)
}

export class Validator {
	readonly diagnostics: Diagnostic[] = []

	issue(code: string, path: string, message: string): void {
		this.diagnostics.push({ code, path, message })
	}

	object(value: unknown, path: string): Record<string, unknown> | undefined {
		if (!isRecord(value)) {
			this.issue('schema.expected_object', path, 'Expected an object.')
			return undefined
		}
		return value
	}

	array(value: unknown, path: string): unknown[] | undefined {
		if (!Array.isArray(value)) {
			this.issue('schema.expected_array', path, 'Expected an array.')
			return undefined
		}
		return value
	}

	string(value: unknown, path: string, nonEmpty = false): string | undefined {
		if (typeof value !== 'string') {
			this.issue('schema.expected_string', path, 'Expected a string.')
			return undefined
		}
		if (nonEmpty && value.length === 0)
			this.issue('schema.empty_string', path, 'Expected a non-empty string.')
		return value
	}

	finiteNumber(value: unknown, path: string): number | undefined {
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			this.issue('schema.expected_finite_number', path, 'Expected a finite number.')
			return undefined
		}
		return value
	}

	finish<T>(value: unknown): ValidationResult<T> {
		if (this.diagnostics.length > 0)
			return { ok: false, diagnostics: this.diagnostics }
		return { ok: true, value: value as T, diagnostics: [] }
	}
}

export function jsonPointer(path: string, segment: string | number): string {
	const escaped = String(segment).replaceAll('~', '~0').replaceAll('/', '~1')
	return `${path}/${escaped}`
}

export function validateUuid(value: unknown, path: string, validator: Validator, label = 'UUID'): value is string {
	if (!isFullUuid(value)) {
		validator.issue('identity.invalid_uuid', path, `${label} must be a full UUID.`)
		return false
	}
	return true
}

export function validateDigest(value: unknown, path: string, validator: Validator): value is string {
	if (!isSha256Digest(value)) {
		validator.issue('identity.invalid_sha256', path, 'Expected a sha256:<64 lowercase hexadecimal characters> identity.')
		return false
	}
	return true
}

export function validateAbsoluteUri(value: unknown, path: string, validator: Validator): value is string {
	if (!isAbsoluteUri(value)) {
		validator.issue('reference.invalid_absolute_uri', path, 'Expected a non-empty absolute URI.')
		return false
	}
	return true
}

export function validateUtcTimestamp(value: unknown, path: string, validator: Validator): value is string {
	if (typeof value !== 'string') {
		validator.issue('time.invalid_rfc3339_utc', path, 'Expected an RFC 3339 UTC timestamp ending in Z.')
		return false
	}
	const fields = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u.exec(value)
	const parsed = Date.parse(value)
	if (!fields || Number.isNaN(parsed)) {
		validator.issue('time.invalid_rfc3339_utc', path, 'Expected an RFC 3339 UTC timestamp ending in Z.')
		return false
	}
	const date = new Date(parsed)
	const actual = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
	const expected = fields.slice(1).map(Number)
	if (actual.some((field, index) => field !== expected[index])) {
		validator.issue('time.invalid_rfc3339_utc', path, 'Timestamp fields must identify an actual UTC date and time.')
		return false
	}
	return true
}

export function validateJsonValue(value: unknown, path: string, validator: Validator): value is JsonValue {
	if (!isJsonValue(value)) {
		validator.issue('schema.invalid_json_value', path, 'Expected a JSON-compatible value.')
		return false
	}
	return true
}

export function validateJsonObject(value: unknown, path: string, validator: Validator): value is JsonObject {
	if (!isJsonObject(value)) {
		validator.issue('schema.invalid_json_object', path, 'Expected a JSON-compatible object.')
		return false
	}
	return true
}

export function validateUniqueStrings(values: readonly unknown[], path: string, validator: Validator, nonEmpty = true): void {
	const seen = new Set<string>()
	values.forEach((value, index) => {
		if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
			validator.issue('identity.invalid_string_key', jsonPointer(path, index), 'Expected a non-empty string identity.')
			return
		}
		if (seen.has(value))
			validator.issue('identity.duplicate', jsonPointer(path, index), 'Identity is duplicated.')
		seen.add(value)
	})
}

/** Persisted contracts use closed object shapes unless an owner explicitly marks them extensible. */
export function rejectUnknownKeys(object: Record<string, unknown>, allowed: readonly string[], path: string, validator: Validator): void {
	const set = new Set(allowed)
	for (const key of Object.keys(object)) {
		if (!set.has(key))
			validator.issue('schema.unknown_field', jsonPointer(path, key), 'Field is outside this canonical object shape.')
	}
}
