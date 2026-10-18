import esbuild from 'esbuild'

/**
 * An Adapter module built the way a pre-built Adapter package that bundles its own
 * `@deviltea/widget-core` is: widget-core is inlined, so its Widget plugins come from a real second
 * widget-core module instance (not a structural look-alike) that the Preview bundler's single-copy
 * aliasing cannot reach (Clause 01a116f0-cae2-7c64-9c76-d472f252789a). `vue` and
 * `@deviltea/widget-vue` stay external imports. The input is a source with the directory its
 * imports resolve from, or an entry file.
 */
export async function bundleAdapterWithOwnWidgetCore(input: Readonly<{ source: string; resolveDir: string }> | Readonly<{ entry: string }>): Promise<string> {
	const result = await esbuild.build({
		...('entry' in input
			? { entryPoints: [input.entry], outdir: 'own-widget-core' }
			: { stdin: { contents: input.source, resolveDir: input.resolveDir, loader: 'ts' as const } }),
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		write: false,
		logLevel: 'silent',
		external: ['vue', '@deviltea/widget-vue'],
	})
	const text = result.outputFiles.find(file => !file.path.endsWith('.css'))!.text
	// Guard the fixture itself: the module must carry its own widget-core, not import the host's.
	if (/from\s*["']@deviltea\/widget-core/u.test(text)) throw new Error('The fixture Adapter still imports @deviltea/widget-core.')
	return text
}
