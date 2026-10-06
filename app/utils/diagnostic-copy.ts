/**
 * Workbench copy for server and domain diagnostics.
 *
 * Every refusal the server sends carries a stable `code` and an English `message` written for
 * agents and logs. The Workbench never shows that English sentence as chrome in another UI
 * language: it maps the code to a catalog sentence (`diagnostics.<code>`), else uses the caller's
 * own fallback, else a sentence for the code's namespace (`diagnosticFallback.<namespace>`). The
 * raw message stays one click away in the Details disclosure (`WbErrorDetails`).
 *
 * en-US is the language the server writes its messages in, so there the specific server sentence
 * is the en-US copy and is shown as is; the catalog's en-US entries are the source text of the
 * translations and the copy for a code that arrives without a message.
 *
 * The functions here are pure and framework-free; the `diagnostic-copy` client plugin registers
 * the i18n-backed localizer, so `describeFetchError` and every list of diagnostics share one rule.
 */
/** `localized` marks a Workbench-written entry whose message is already in the UI language. */
export type DiagnosticLike = Readonly<{ code?: string; message?: string; localized?: boolean }>

export type DiagnosticLocalizer = Readonly<{
	/** True when the UI language is the one server messages are written in (en-US). */
	sourceLocale: () => boolean
	/** The catalog sentence for this exact code, if the catalog maps it. */
	exact: (code: string) => string | undefined
	/** The catalog sentence for this code's namespace (or the generic one). */
	namespace: (code: string | undefined) => string
}>

let localizer: DiagnosticLocalizer | undefined

export function setDiagnosticLocalizer(next: DiagnosticLocalizer | undefined): void {
	localizer = next
}

/** `review.message_body_empty` → `diagnostics.review.message_body_empty`; kebab-case parts become snake_case. */
export function diagnosticMessageKey(code: string): string {
	return `diagnostics.${code.split('.').map(part => part.replace(/[^A-Za-z0-9_]/g, '_')).join('.')}`
}

/** `review.message_body_empty` → `diagnosticFallback.review`; a code without a namespace uses `generic`. */
export function diagnosticNamespaceKey(code: string | undefined): string {
	const namespace = code?.includes('.') ? code.slice(0, code.indexOf('.')) : ''
	return `diagnosticFallback.${namespace.replace(/[^A-Za-z0-9_]/g, '_') || 'generic'}`
}

/**
 * The sentence the Workbench shows for one diagnostic in the current UI language. `fallback` is
 * the caller's own sentence for the failed operation ("Couldn't save the Spec"); it wins over the
 * namespace sentence because it says what the person was doing.
 */
export function diagnosticText(diagnostic: DiagnosticLike, fallback?: string): string {
	const message = diagnostic.message?.trim() || undefined
	if (!localizer || (diagnostic.localized && message)) return message ?? fallback ?? diagnostic.code ?? ''
	const exact = diagnostic.code ? localizer.exact(diagnostic.code) : undefined
	if (localizer.sourceLocale()) return message ?? exact ?? fallback ?? localizer.namespace(diagnostic.code)
	return exact ?? fallback ?? localizer.namespace(diagnostic.code)
}

/** True when the shown sentence is not the server's own words, so they belong in Details. */
export function diagnosticTextReplacesMessage(diagnostic: DiagnosticLike, fallback?: string): boolean {
	const message = diagnostic.message?.trim()
	return !!message && diagnosticText(diagnostic, fallback) !== message
}

/**
 * Extra lines for an error alert or toast: each diagnostic in the UI language, without the
 * headline itself and without repeating a sentence.
 */
export function diagnosticLines(headline: string, diagnostics: readonly DiagnosticLike[]): string[] {
	const lines: string[] = []
	for (const diagnostic of diagnostics) {
		const text = diagnosticText(diagnostic)
		if (text && text !== headline && !lines.includes(text)) lines.push(text)
	}
	return lines
}
