// The kit build (`kit/package.json` `uiux.build`): bundles the wrapper entry `adapters/reference.ts`,
// with the Kit components it wraps (`src/ui/*.vue`) and their styles, into `dist/uiux.js` and
// `dist/uiux.css`. The Preview cannot load `.vue` files, so this build is what makes the Kit's single
// file components reachable from an Adapter (Clause 01a11bb1-8721-721e-80b6-3cffed19e5ef).
//
// Why esbuild plus `vue/compiler-sfc`, and not Vite library mode: both are already dependencies of
// UIUX (`esbuild`, `vue`), so the build adds no package, and esbuild is the bundler the Preview and the
// Adapter content digest already use, so what this build emits is what they bundle. The output is
// deterministic: no absolute path, timestamp or hash of the host enters it.
//
// `node build.mjs` builds once; `node build.mjs --watch` rebuilds on change (`uiux.build.watch`).
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'
import { compileScript, compileStyle, parse } from 'vue/compiler-sfc'

const kitDirectory = dirname(fileURLToPath(import.meta.url))
process.chdir(kitDirectory)

/** Packages the host supplies to an Adapter at run time: the Preview aliases them, the server resolves them. */
const HOST_PACKAGES = ['vue', '@deviltea/widget-core', '@deviltea/widget-vue', '@deviltea/uiux/adapter']

/** The stable, host-independent label of a source file: its path relative to `kit/`, with `/`. */
function labelOf(path) {
  return relative(kitDirectory, path).split(sep).join('/')
}

/** Compiles `.vue` single file components: `<script setup>` and the template into JS, each `<style>` into CSS. */
const vueSfc = {
  name: 'vue-sfc',
  setup(build) {
    /** The parsed descriptor of each component, so its styles are compiled from the same parse. */
    const descriptors = new Map()
    build.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
      const label = labelOf(path)
      const { descriptor, errors } = parse(await readFile(path, 'utf8'), { filename: label })
      if (errors.length > 0) return { errors: errors.map(error => ({ text: error.message, location: { file: label, line: error.loc?.start.line ?? 1, column: 0 } })) }
      // A Kit component's styles are plain global CSS over `--kit-*` tokens, so the same file copies into a product
      // unchanged: scoped, module, preprocessor and external styles and CSS `v-bind()` are not supported, and fail here
      // instead of compiling into something a product's own build would treat differently.
      const unsupported = []
      for (const style of descriptor.styles) {
        const kind = style.scoped ? 'scoped' : style.module ? 'module' : style.lang ? `lang="${style.lang}"` : style.src ? 'src' : undefined
        if (kind) unsupported.push({ text: `<style ${kind}> is not supported in a Kit component: write plain global CSS in a <style> block.`, location: { file: label, line: style.loc.start.line, column: 0 } })
      }
      if (descriptor.cssVars.length > 0) unsupported.push({ text: `CSS v-bind() (${descriptor.cssVars.join(', ')}) is not supported in a Kit component: pass values through props and classes.`, location: { file: label, line: descriptor.styles[0]?.loc.start.line ?? 1, column: 0 } })
      if (unsupported.length > 0) return { errors: unsupported }
      descriptors.set(label, descriptor)
      const id = createHash('sha256').update(label).digest('hex').slice(0, 8)
      const script = compileScript(descriptor, { id, inlineTemplate: true, templateOptions: { compilerOptions: { comments: false } } })
      const contents = [
        script.content.replace('export default ', 'const __sfc__ = '),
        ...descriptor.styles.map((_, index) => `import ${JSON.stringify(`${label}?vue-style=${index}`)};`),
        'export default __sfc__;',
      ].join('\n')
      return { contents, loader: descriptor.scriptSetup?.lang === 'ts' || descriptor.script?.lang === 'ts' ? 'ts' : 'js', resolveDir: dirname(path) }
    })
    build.onResolve({ filter: /\.vue\?vue-style=\d+$/ }, ({ path }) => ({ path, namespace: 'vue-style' }))
    build.onLoad({ filter: /.*/, namespace: 'vue-style' }, ({ path }) => {
      const [label, index] = path.split('?vue-style=')
      const result = compileStyle({ source: descriptors.get(label).styles[Number(index)].content, filename: label, id: '', scoped: false })
      if (result.errors.length > 0) return { errors: result.errors.map(error => ({ text: error.message, location: { file: label } })) }
      return { contents: result.code, loader: 'css', resolveDir: dirname(resolve(kitDirectory, label)) }
    })
  },
}

const options = {
  absWorkingDir: kitDirectory,
  entryPoints: { uiux: 'adapters/reference.ts' },
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: HOST_PACKAGES,
  plugins: [vueSfc],
  // The CSS the bundle collects is written next to the module as `uiux.css`; the module links it so the
  // Adapter's module graph, which the Adapter content digest covers, includes it. The server loads
  // such an import as an empty module and the Preview bundler builds the real file.
  banner: { js: 'import "./uiux.css";' },
  define: { __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  legalComments: 'none',
  logLevel: 'info',
}

if (process.argv.includes('--watch')) {
  const context = await esbuild.context(options)
  await context.watch()
  console.log('watching kit sources')
}
else {
  await rm(resolve(kitDirectory, 'dist'), { recursive: true, force: true })
  await esbuild.build(options)
}
