/**
 * Copies text, also without a secure context (team-access F6): plain-HTTP LAN origins have no
 * `navigator.clipboard`, so it falls back to a selected off-screen textarea and `execCommand`.
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (globalThis.isSecureContext && navigator.clipboard) {
			await navigator.clipboard.writeText(text)
			return true
		}
	}
	catch {
		// fall through to the selection fallback
	}
	const area = document.createElement('textarea')
	area.value = text
	area.setAttribute('readonly', '')
	area.style.position = 'fixed'
	area.style.opacity = '0'
	area.style.insetInlineStart = '-9999px'
	document.body.appendChild(area)
	area.select()
	try {
		return document.execCommand('copy')
	}
	catch {
		return false
	}
	finally {
		area.remove()
	}
}
