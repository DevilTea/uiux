import { defineEventHandler } from 'h3'
import { revokeSessionForHttp } from '../../../../src/server/access/admin-http'

export default defineEventHandler(event => revokeSessionForHttp(event))
