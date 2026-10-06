import { defineEventHandler } from 'h3'
import { removeMemberForHttp } from '../../../../src/server/access/admin-http'

export default defineEventHandler(event => removeMemberForHttp(event))
