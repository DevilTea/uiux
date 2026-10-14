import { sha256Identity } from '../artifacts/schema'
import { canonicalJsonBytes } from '../canonical-json'

/**
 * File and component digests (Clause 01a11bb1-8b0c-7590-9478-0348530b1ea7). A file digest is
 * `sha256:` and the lowercase hex SHA-256 of the file's bytes. A component digest is the `sha256:`
 * identity of the canonical JSON (`canonicalJsonBytes`, as `bundleIdentity` uses) of the map from
 * each of the component's file paths, as the registry declares them (relative to `kit/`), to its
 * file digest. The CLI copy-out (`uiux components`) and the MCP kit source Tools share them.
 */
export async function fileDigest(bytes: Uint8Array): Promise<string> {
	return sha256Identity(bytes)
}

/** The component digest of `files`, a map from each kit-relative file path to its file digest. */
export async function componentDigest(files: Readonly<Record<string, string>>): Promise<string> {
	return sha256Identity(canonicalJsonBytes(files))
}
