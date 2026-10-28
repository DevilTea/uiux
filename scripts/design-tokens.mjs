// `pnpm design:tokens` rewrites the color and token sections of DESIGN.md from the Kit's one token
// source, `.uiux/kit/src/tokens/tokens.css` (Discussion #379, owner answer 5). It generates only:
//
//   - the `colors:` block of the front matter, one entry per palette token (`--color-<name>-<step>`);
//   - the block between `<!-- generated:tokens -->` and `<!-- /generated:tokens -->`, the semantic
//     token table (`--kit-*`, light and dark).
//
// Everything else in DESIGN.md stays hand-written. `pnpm design:tokens --check` generates in memory
// and exits 1 when DESIGN.md differs, so a change to tokens.css without a regeneration fails CI.
import { realpathSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOKENS = join(ROOT, '.uiux', 'kit', 'src', 'tokens', 'tokens.css')
const DESIGN = join(ROOT, 'DESIGN.md')
const BEGIN = '<!-- generated:tokens -->'
const END = '<!-- /generated:tokens -->'

/** The declarations (`--name: value`) of each `/* @tokens <section> *\/` section of tokens.css, in order. */
export function parseTokens(css) {
  const sections = new Map()
  const markers = [...css.matchAll(/\/\*\s*@tokens\s+([a-z-]+)\s*\*\//g)]
  markers.forEach((marker, index) => {
    const body = css.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? css.length)
    const declarations = []
    for (const declaration of body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g))
      declarations.push([declaration[1], declaration[2].trim().replace(/\s+/g, ' ')])
    sections.set(marker[1], declarations)
  })
  for (const name of ['palette', 'light', 'dark', 'dark-auto']) {
    if (!sections.has(name)) throw new Error(`tokens.css has no "@tokens ${name}" section`)
  }
  return sections
}

function oklchToHex(value) {
  const match = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value)
  if (!match) return undefined
  const l = Number(match[1]) / 100
  const c = Number(match[2])
  const h = (Number(match[3]) * Math.PI) / 180
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
  return `#${linear.map((channel) => {
    const clamped = Math.min(1, Math.max(0, channel))
    const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
    return Math.round(encoded * 255).toString(16).padStart(2, '0')
  }).join('')}`
}

/** A semantic token's value for the table: a palette reference with its hex, or the expression with palette references shortened. */
function describe(value, palette) {
  const reference = /^var\(--color-([a-z0-9-]+)\)$/.exec(value)
  if (reference) {
    const literal = palette.get(`--color-${reference[1]}`)
    const hex = literal === undefined ? undefined : oklchToHex(literal)
    return hex ? `\`${reference[1]}\` ${hex}` : `\`${reference[1]}\``
  }
  return `\`${value.replace(/var\(--color-([a-z0-9-]+)\)/g, '$1')}\``
}

export function generate(css, design) {
  const sections = parseTokens(css)
  const palette = new Map(sections.get('palette').filter(([name]) => name.startsWith('--color-')))
  const light = sections.get('light').filter(([name]) => name.startsWith('--kit-'))
  const dark = new Map(sections.get('dark').filter(([name]) => name.startsWith('--kit-')))
  const darkAuto = new Map(sections.get('dark-auto').filter(([name]) => name.startsWith('--kit-')))

  const problems = []
  for (const [name, value] of dark) {
    if (darkAuto.get(name) !== value) problems.push(`the dark and dark-auto sections differ at ${name}`)
  }
  for (const name of darkAuto.keys()) if (!dark.has(name)) problems.push(`dark-auto declares ${name}, which dark does not`)
  for (const [name] of light) if (!dark.has(name)) problems.push(`${name} is declared for light but not for dark`)
  for (const name of dark.keys()) if (!light.some(([lightName]) => lightName === name)) problems.push(`${name} is declared for dark but not for light`)
  if (problems.length > 0) throw new Error(`tokens.css is inconsistent:\n- ${problems.join('\n- ')}`)

  const colors = ['colors:', ...[...palette].map(([name, value]) => `  ${name.slice('--color-'.length)}: "${value}"`)].join('\n')
  const rows = light.map(([name, value]) => `| \`${name}\` | ${describe(value, palette)} | ${describe(dark.get(name), palette)} |`)
  const table = [
    BEGIN,
    '### Semantic tokens (generated)',
    '',
    'Generated from `.uiux/kit/src/tokens/tokens.css` by `pnpm design:tokens`; change the CSS and regenerate, never edit this block. `--kit-*` are the tokens Kit components read. A palette reference shows its step and sRGB hex; `color-mix` tints and shadows are shown as written.',
    '',
    '| Token | Light | Dark |',
    '|---|---|---|',
    ...rows,
    '',
    END,
  ].join('\n')

  let next = design
  const frontEnd = next.indexOf('\n---\n', 4)
  const colorsStart = next.indexOf('\ncolors:\n')
  const colorsEnd = next.indexOf('\ntypography:\n')
  if (colorsStart < 0 || colorsEnd < colorsStart || colorsEnd > frontEnd) throw new Error('DESIGN.md front matter has no colors: block before typography:')
  next = `${next.slice(0, colorsStart + 1)}${colors}${next.slice(colorsEnd)}`
  const begin = next.indexOf(BEGIN)
  const end = next.indexOf(END)
  if (begin < 0 || end < begin) throw new Error(`DESIGN.md has no ${BEGIN} ... ${END} block`)
  next = `${next.slice(0, begin)}${table}${next.slice(end + END.length)}`
  return next
}

async function main() {
  const check = process.argv.includes('--check')
  const [css, design] = await Promise.all([readFile(TOKENS, 'utf8'), readFile(DESIGN, 'utf8')])
  const next = generate(css, design)
  if (check) {
    if (next !== design) {
      process.stderr.write('DESIGN.md is out of date with .uiux/kit/src/tokens/tokens.css; run `pnpm design:tokens`.\n')
      process.exitCode = 1
    }
    return
  }
  if (next !== design) await writeFile(DESIGN, next)
  process.stdout.write(next === design ? 'DESIGN.md is up to date.\n' : 'DESIGN.md updated from tokens.css.\n')
}

// Run as a script (not when a test imports `generate`); the real path, since argv[1] may name a symbolic link.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
