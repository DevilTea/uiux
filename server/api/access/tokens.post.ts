import { defineEventHandler } from 'h3'
import { createTokenForHttp } from '../../../src/server/access/admin-http'

export default defineEventHandler(event => createTokenForHttp(event))
