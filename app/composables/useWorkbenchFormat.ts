import { useI18n } from '#imports'

/** Intl formatting bound to the active Workbench chrome locale. */
export function useWorkbenchFormat() {
	const { locale } = useI18n()

	function toDate(value: string | number | Date | undefined | null): Date | undefined {
		if (value === undefined || value === null || value === '') return undefined
		const date = value instanceof Date ? value : new Date(value)
		return Number.isNaN(date.getTime()) ? undefined : date
	}

	/** Date and time, e.g. "Oct 5, 2026, 4:12 PM" / "2026年10月5日 下午4:12". */
	function dateTime(value: string | number | Date | undefined | null, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }): string {
		const date = toDate(value)
		if (!date) return typeof value === 'string' ? value : ''
		return new Intl.DateTimeFormat(locale.value, options).format(date)
	}

	function date(value: string | number | Date | undefined | null): string {
		return dateTime(value, { dateStyle: 'medium' })
	}

	function time(value: string | number | Date | undefined | null): string {
		return dateTime(value, { timeStyle: 'medium' })
	}

	function number(value: number, options?: Intl.NumberFormatOptions): string {
		return new Intl.NumberFormat(locale.value, options).format(value)
	}

	function bytes(value: number): string {
		const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const
		let amount = value
		let unit = 0
		while (amount >= 1024 && unit < units.length - 1) {
			amount /= 1024
			unit += 1
		}
		return new Intl.NumberFormat(locale.value, {
			style: 'unit',
			unit: units[unit],
			unitDisplay: 'short',
			maximumFractionDigits: unit === 0 ? 0 : 1,
		}).format(amount)
	}

	return { dateTime, date, time, number, bytes }
}
