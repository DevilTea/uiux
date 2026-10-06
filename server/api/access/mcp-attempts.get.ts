import { defineEventHandler } from 'h3'
import { mcpAttemptsForHttp } from '../../../src/server/access/admin-http'

export default defineEventHandler(event => mcpAttemptsForHttp(event))
