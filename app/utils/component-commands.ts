/**
 * The commands the Components section of the Product Kit page copies for one registry component
 * (Rule 01a11bb1-b918-7cb5-b581-a3fd3f647f09): `uiux components add` and its MCP counterpart
 * `get_component_source`. A pasted command must run as shown, so every value the viewer typed is one
 * POSIX shell word.
 */

/** The `--to` directory when none is typed. */
export const DEFAULT_COMPONENT_TARGET = 'src/components'

/** A value as one POSIX shell word: unchanged when it holds only safe characters, single-quoted otherwise. */
export function shellWord(value: string): string {
	return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll('\'', '\'\\\'\'')}'`
}

/** `uiux components add <name> --to <dir>`, with `dir` trimmed and the default when empty. */
export function componentAddCommand(name: string, target: string): string {
	return `uiux components add ${shellWord(name)} --to ${shellWord(target.trim() || DEFAULT_COMPONENT_TARGET)}`
}

/** The `get_component_source` call that reads the component with what it requires. */
export function componentSourceCall(name: string): string {
	return `get_component_source ${JSON.stringify({ name, withRequires: true })}`
}
