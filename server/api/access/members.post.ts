import { defineEventHandler } from 'h3'
import { addMemberForHttp } from '../../../src/server/access/admin-http'

export default defineEventHandler(event => addMemberForHttp(event))
