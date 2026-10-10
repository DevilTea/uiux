/**
 * Copies text, also without a secure context (Rule 01a12500-b84a-7d4e-a52d-5c7e13d78fd0): plain-HTTP network origins have no
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
