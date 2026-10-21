/**
 * The one module of `src/` and `server/` that writes diagnostics to the console (ESLint
 * `no-console` and the stdio restrictions in `eslint.config.js` forbid every other file).
 * The server process patches the console methods used here with credential redaction at start
 * (`installLogRedaction`, Rule 01a11485-ed17-791a-a30e-1b63fa6f16ce), so routing every
 * diagnostic through this module keeps unredacted writes in one auditable place.
 */
export const diagnostics = {
	info: (...args: unknown[]): void => console.log(...args),
	warn: (...args: unknown[]): void => console.warn(...args),
	error: (...args: unknown[]): void => console.error(...args),
}
