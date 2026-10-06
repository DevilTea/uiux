import { defineEventHandler } from 'h3'
import { listTokensForHttp } from '../../../src/server/access/admin-http'

export default defineEventHandler(event => listTokensForHttp(event))
