import { defineEventHandler } from 'h3'
import { listSessionsForHttp } from '../../../src/server/access/admin-http'

export default defineEventHandler(event => listSessionsForHttp(event))
