import { defineEventHandler } from 'h3'
import { listMembersForHttp } from '../../../src/server/access/admin-http'

export default defineEventHandler(event => listMembersForHttp(event))
