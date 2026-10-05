import { defineEventHandler } from 'h3'
import { setMemberForHttp } from '../../../../src/server/access/admin-http'

export default defineEventHandler(event => setMemberForHttp(event))
