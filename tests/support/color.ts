/**
 * Minimal CSS color parsing and WCAG contrast for browser-computed colors.
 * Chromium reports computed colors as `rgb()/rgba()`, `oklch()`, `oklab()` or `color(srgb …)`.
 */
export type Rgba = Readonly<{ r: number; g: number; b: number; a: number }>

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value))
}

function linearToSrgb(value: number): number {
	return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055
}

function srgbToLinear(value: number): number {
	return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function oklabToSrgb(l: number, a: number, b: number): [number, number, number] {
	const l_ = l + 0.3963377774 * a + 0.2158037573 * b
	const m_ = l - 0.1055613458 * a - 0.0638541728 * b
	const s_ = l - 0.0894841775 * a - 1.291485548 * b
	const l3 = l_ ** 3
	const m3 = m_ ** 3
	const s3 = s_ ** 3
	const r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
	const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
	const bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3
	return [clamp01(linearToSrgb(r)), clamp01(linearToSrgb(g)), clamp01(linearToSrgb(bl))]
}

function number(token: string | undefined, percentScale = 1): number {
	if (!token || token === 'none') return 0
	if (token.endsWith('%')) return (Number.parseFloat(token) / 100) * percentScale
	return Number.parseFloat(token)
}

export function parseCssColor(input: string): Rgba {
	const value = input.trim().toLowerCase()
	if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
	const match = value.match(/^([a-z-]+)\((.*)\)$/)
	if (!match) throw new Error(`Unsupported color: ${input}`)
	const fn = match[1]!
	const [channels, alphaPart] = match[2]!.split('/').map(part => part.trim()) as [string, string | undefined]
	const parts = channels.replace(/,/g, ' ').split(/\s+/).filter(Boolean)
	const alpha = alphaPart ? number(alphaPart) : fn === 'rgba' && parts.length === 4 ? Number.parseFloat(parts.pop()!) : 1
	if (fn === 'rgb' || fn === 'rgba') {
		const [r, g, b] = parts.map(part => number(part, 255) / 255)
		return { r: r!, g: g!, b: b!, a: alpha }
	}
	if (fn === 'oklch') {
		const l = number(parts[0])
		const c = number(parts[1], 0.4)
		const h = (number(parts[2]) * Math.PI) / 180
		const [r, g, b] = oklabToSrgb(l, c * Math.cos(h), c * Math.sin(h))
		return { r, g, b, a: alpha }
	}
	if (fn === 'oklab') {
		const [r, g, b] = oklabToSrgb(number(parts[0]), number(parts[1], 0.4), number(parts[2], 0.4))
		return { r, g, b, a: alpha }
	}
	if (fn === 'color' && parts[0] === 'srgb') {
		const [r, g, b] = parts.slice(1).map(part => number(part))
		return { r: r!, g: g!, b: b!, a: alpha }
	}
	throw new Error(`Unsupported color: ${input}`)
}

/** Composites `top` over an opaque `bottom`. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
	const a = top.a
	return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 }
}

export function relativeLuminance(color: Rgba): number {
	return 0.2126 * srgbToLinear(color.r) + 0.7152 * srgbToLinear(color.g) + 0.0722 * srgbToLinear(color.b)
}

export function contrastRatio(foreground: string | Rgba, background: string | Rgba): number {
	const bg = typeof background === 'string' ? parseCssColor(background) : background
	const fgRaw = typeof foreground === 'string' ? parseCssColor(foreground) : foreground
	const fg = fgRaw.a < 1 ? composite(fgRaw, bg) : fgRaw
	const l1 = relativeLuminance(fg)
	const l2 = relativeLuminance(bg)
	return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}
