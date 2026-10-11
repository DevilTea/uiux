import type { MemberLabel } from '../../src/application/access/labels'

/**
 * A member label as the Workbench shows it (Rule 01a11c09-cef3-7767-9d95-c3b89510aea3): a preset's
 * name exactly as written, since preset names are Workspace data, and only Custom translated.
 */
export function memberLabelText(label: MemberLabel | undefined, custom: string): string {
	if (!label) return ''
	return 'preset' in label ? label.preset.name : custom
}
