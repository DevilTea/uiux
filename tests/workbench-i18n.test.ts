import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	matchWorkbenchLocale,
	resolveInitialWorkbenchLocale,
	WORKBENCH_LOCALES,
} from '../app/utils/workbench-locale'

const LOCALES_DIR = join(import.meta.dirname, '..', 'app', 'i18n', 'locales')

type Catalog = { [key: string]: string | Catalog }

function readCatalog(locale: string): Catalog {
	return JSON.parse(readFileSync(join(LOCALES_DIR, `${locale}.json`), 'utf8')) as Catalog
}

function flattenKeys(catalog: Catalog, prefix = ''): string[] {
	return Object.entries(catalog).flatMap(([key, value]) => {
		const path = prefix ? `${prefix}.${key}` : key
		return typeof value === 'string' ? [path] : flattenKeys(value, path)
	})
}

function flattenEntries(catalog: Catalog, prefix = ''): [string, string][] {
	return Object.entries(catalog).flatMap(([key, value]) => {
		const path = prefix ? `${prefix}.${key}` : key
		return typeof value === 'string' ? [[path, value] as [string, string]] : flattenEntries(value, path)
	})
}

describe('Workbench chrome catalogs', () => {
	it('ships exactly one catalog per Workbench locale', () => {
		const files = readdirSync(LOCALES_DIR).filter(file => file.endsWith('.json')).sort()
		expect(files).toEqual([...WORKBENCH_LOCALES].map(locale => `${locale}.json`).sort())
	})

	it('keeps en-US and zh-TW key sets identical', () => {
		const english = flattenKeys(readCatalog('en-US')).sort()
		const chinese = flattenKeys(readCatalog('zh-TW')).sort()
		expect(english.length).toBeGreaterThan(0)
		expect(chinese).toEqual(english)
	})

	it('keeps plural choice counts aligned between locales', () => {
		const chinese = new Map(flattenEntries(readCatalog('zh-TW')))
		for (const [key, value] of flattenEntries(readCatalog('en-US'))) {
			const choices = value.split(' | ').length
			if (choices > 1) expect(chinese.get(key)?.split(' | ').length, key).toBe(choices)
		}
	})

	it('has no empty messages', () => {
		for (const locale of WORKBENCH_LOCALES) {
			for (const [key, value] of flattenEntries(readCatalog(locale)))
				expect(value.trim(), `${locale}:${key}`).not.toBe('')
		}
	})
})

describe('Workbench locale resolution', () => {
	it('prefers a saved Workbench locale', () => {
		expect(resolveInitialWorkbenchLocale('zh-TW', ['en-US'])).toBe('zh-TW')
		expect(resolveInitialWorkbenchLocale('en-US', ['zh-TW'])).toBe('en-US')
	})

	it('ignores unknown saved values and falls back to the browser languages', () => {
		expect(resolveInitialWorkbenchLocale('fr-FR', ['zh-TW'])).toBe('zh-TW')
		expect(resolveInitialWorkbenchLocale(null, ['ja-JP', 'zh-Hant-TW'])).toBe('zh-TW')
		expect(resolveInitialWorkbenchLocale(undefined, ['zh-Hant'])).toBe('zh-TW')
		expect(resolveInitialWorkbenchLocale(undefined, ['en-GB'])).toBe('en-US')
	})

	it('falls back to en-US', () => {
		expect(resolveInitialWorkbenchLocale(null, [])).toBe('en-US')
		expect(resolveInitialWorkbenchLocale(null, ['zh-CN', 'ja-JP'])).toBe('en-US')
	})

	it('does not map Simplified Chinese tags to zh-TW', () => {
		expect(matchWorkbenchLocale('zh-CN')).toBeUndefined()
		expect(matchWorkbenchLocale('zh-Hans-TW')).toBeUndefined()
		expect(matchWorkbenchLocale('ZH-tw')).toBe('zh-TW')
	})
})
