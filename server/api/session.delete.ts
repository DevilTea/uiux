import { defineEventHandler } from 'h3'
import { endSessionForHttp } from '../../src/server/access/admin-http'

export default defineEventHandler(event => endSessionForHttp(event))
