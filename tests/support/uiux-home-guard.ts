import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// Fail fast if a worker ever runs without the private UIUX_HOME from the global setup.
const configured = process.env.UIUX_HOME
if (!configured || resolve(configured) === resolve(join(homedir(), '.uiux')))
	throw new Error('Tests must run with a temporary UIUX_HOME (see tests/support/global-setup.ts); refusing to touch ~/.uiux.')
