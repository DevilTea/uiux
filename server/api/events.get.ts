import { defineEventHandler } from 'h3'
import { getSelectedWorkspaceServerRuntime } from '../../src/server/selected-workspace'

/** The change-event stream (Clause 01a114ec-e839-7b11-957c-41c88b692e12); see `src/server/event-stream.ts`. */
export default defineEventHandler(event => getSelectedWorkspaceServerRuntime().eventStreams.serve(event))
