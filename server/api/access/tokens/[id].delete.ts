import { defineEventHandler } from 'h3'
import { revokeTokenForHttp } from '../../../../src/server/access/admin-http'

export default defineEventHandler(event => revokeTokenForHttp(event))
