import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Workbench copy contracts (PRODUCT.md voice and zh-TW terminology policy, roadmap R2):
 * domain nouns stay English in zh-TW, status vocabulary is fixed, plurals use pipes,
 * every key named in a surface brief copy table exists, and no emoji stands in for an icon.
 */

const ROOT = join(import.meta.dirname, '..')
const LOCALES = join(ROOT, 'app', 'i18n', 'locales')

type Catalog = { [key: string]: string | Catalog }

function flatten(catalog: Catalog, prefix = ''): Map<string, string> {
	const out = new Map<string, string>()
	for (const [key, value] of Object.entries(catalog)) {
		const path = prefix ? `${prefix}.${key}` : key
		if (typeof value === 'string') out.set(path, value)
		else for (const [k, v] of flatten(value, path)) out.set(k, v)
	}
	return out
}

const en = flatten(JSON.parse(readFileSync(join(LOCALES, 'en-US.json'), 'utf8')) as Catalog)
const zh = flatten(JSON.parse(readFileSync(join(LOCALES, 'zh-TW.json'), 'utf8')) as Catalog)

/** Canonical domain nouns that zh-TW keeps in English (PRODUCT.md, user decision). */
const DOMAIN_NOUNS = ['View', 'Variant', 'Widget', 'Review', 'Flow', 'Spec', 'Decision', 'Evidence', 'Handoff', 'Workspace', 'Locale', 'Asset', 'MCP']

/** Chinese renderings of those nouns that must not appear in the zh-TW catalog. */
const FORBIDDEN_TRANSLATIONS = ['變體', '視圖', '畫面元件', '元件', '流程', '規格', '決策', '證據', '交付', '工作區', '語系', '素材', '資產', '審查']

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry)
		return statSync(path).isDirectory() ? walk(path) : [path]
	})
}

/** Parses `| Key | en-US | zh-TW |` tables from the persisted surface briefs. */
function briefKeys(): { key: string; source: string }[] {
	const dir = join(ROOT, '.impeccable', 'surfaces')
	const keys: { key: string; source: string }[] = []
	for (const file of readdirSync(dir).filter(name => name.endsWith('.md'))) {
		let inTable = false
		for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
			if (/^\| Key \| en-US \| zh-TW \|/.test(line)) { inTable = true; continue }
			if (!inTable) continue
			if (!line.startsWith('|')) { inTable = false; continue }
			if (line.startsWith('|---')) continue
			const cell = line.split('|')[1]!.trim()
			const parts = cell.split(' / ').map(part => part.trim())
			const base = parts[0]!.includes('.') ? parts[0]!.slice(0, parts[0]!.lastIndexOf('.')) : ''
			keys.push({ key: parts[0]!, source: file })
			for (const sibling of parts.slice(1)) keys.push({ key: base ? `${base}.${sibling}` : sibling, source: file })
		}
	}
	return keys
}

describe('zh-TW glossary', () => {
	it('keeps every domain noun of an en-US string in English', () => {
		const offenders: string[] = []
		for (const [key, english] of en) {
			const chinese = zh.get(key) ?? ''
			for (const noun of DOMAIN_NOUNS) {
				if (new RegExp(`\\b${noun}s?\\b`).test(english) && !chinese.includes(noun))
					offenders.push(`${key}: "${english}" → "${chinese}" lost ${noun}`)
			}
		}
		expect(offenders).toEqual([])
	})

	it('never translates a domain noun', () => {
		const offenders = [...zh].filter(([, value]) => FORBIDDEN_TRANSLATIONS.some(word => value.includes(word)))
		expect(offenders).toEqual([])
	})

	it('uses the fixed status vocabulary', () => {
		expect(zh.get('reviews.status.open')).toBe('未解決')
		expect(zh.get('reviews.status.readyForReview')).toBe('待審核')
		expect(zh.get('reviews.status.resolved')).toBe('已解決')
		expect(zh.get('decision.pending')).toBe('待定')
		expect(zh.get('decision.decided')).toBe('已決定')
		expect(zh.get('decision.deferred')).toBe('延後')
	})
})

describe('Workbench copy', () => {
	it('defines every key from the surface brief copy tables in both locales', () => {
		const missing = briefKeys().filter(({ key }) => !en.has(key) || !zh.has(key)).map(({ key, source }) => `${source}: ${key}`)
		expect(missing).toEqual([])
	})

	it('writes counted messages as pipe plurals with matching choice counts', () => {
		const offenders: string[] = []
		for (const [key, english] of en) {
			const choices = english.split(' | ').length
			if ((zh.get(key) ?? '').split(' | ').length !== choices) offenders.push(`${key}: choice count differs`)
			// A count followed by a plural noun must offer a singular form.
			if (choices === 1 && /\{n\} [a-z]+s\b/i.test(english)) offenders.push(`${key}: "${english}" has no singular form`)
		}
		expect(offenders).toEqual([])
	})

	it('resolves every literal message key used in app sources', () => {
		const missing: string[] = []
		for (const file of walk(join(ROOT, 'app')).filter(path => /\.(vue|ts)$/.test(path))) {
			for (const match of readFileSync(file, 'utf8').matchAll(/(?:\bt\(|keypath=")['"]?([a-zA-Z][\w.]+)['"]/g)) {
				const key = match[1]!
				if (key.includes('.') && !en.has(key) && ![...en.keys()].some(existing => existing.startsWith(`${key}.`)))
					missing.push(`${relative(ROOT, file)}: ${key}`)
			}
		}
		expect(missing).toEqual([])
	})

	it('keeps engineering-literal headings out of the chrome', () => {
		const banned = /iframe boundary|architecture seam|atomic cas|handshake|mountPreviewRuntime/i
		expect([...en].filter(([, value]) => banned.test(value))).toEqual([])
	})

	it('uses no emoji code points in app sources', () => {
		const emoji = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\u{FE0F}/u
		const offenders: string[] = []
		for (const file of walk(join(ROOT, 'app'))) {
			readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
				if (emoji.test(line)) offenders.push(`${relative(ROOT, file)}:${index + 1}`)
			})
		}
		expect(offenders).toEqual([])
	})
})
