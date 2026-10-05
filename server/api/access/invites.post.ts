import { defineEventHandler } from 'h3'
import { createInviteForHttp } from '../../../src/server/access/admin-http'

export default defineEventHandler(event => createInviteForHttp(event))
