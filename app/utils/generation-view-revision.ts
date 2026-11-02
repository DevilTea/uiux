/**
 * The revision of the View an open Preview generation renders (issue #52; Clause
 * 01a19ab9-d028-7bb9-a370-4736992852f5). The Runtime echoes the revision its document read; a
 * Spec-only edit changes the View's revision without a new generation, so the Workbench keeps the
 * revision it had when the generation appeared. The exact fix needs the Preview to report the
 * revision it read (issue #484); until then this is the Workbench's approximation.
 */
export type GenerationViewAnchor = Readonly<{
	/** The View the generation was admitted for. */
	viewId: string
	/** Its revision; `undefined` until that View is loaded. */
	revision?: string
}>

type LoadedView = Readonly<{ key: string; revision: string }>

/** The anchor at admission: the revision of the selected View when it is loaded, otherwise only its id. */
export function anchorGenerationView(viewId: string | undefined, view: LoadedView | undefined): GenerationViewAnchor | undefined {
	if (!viewId) return undefined
	return view?.key === viewId ? { viewId, revision: view.revision } : { viewId }
}

/**
 * The anchor after a View load: an anchor without a revision takes the first load of its own View. A
 * known revision never moves (a later load is an edit that started no new generation), and a load of
 * another View changes nothing.
 */
export function anchorOnViewLoad(anchor: GenerationViewAnchor | undefined, view: LoadedView | undefined): GenerationViewAnchor | undefined {
	if (!anchor || anchor.revision !== undefined || !view || view.key !== anchor.viewId) return anchor
	return { viewId: anchor.viewId, revision: view.revision }
}
