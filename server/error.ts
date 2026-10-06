import { sendPersistenceBusyError } from '../src/server/persistence-busy'

/**
 * First Nitro error handler (registered in nuxt.config ahead of Nuxt's own): `persistence.busy`
 * becomes a retryable 503; any other error falls through to the next handler unchanged.
 */
export default defineNitroErrorHandler((error, event) => sendPersistenceBusyError(error, event))
