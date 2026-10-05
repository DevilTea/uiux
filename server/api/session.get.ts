import { defineEventHandler } from 'h3'
import { readSessionForHttp } from '../../src/server/access/admin-http'

export default defineEventHandler(event => readSessionForHttp(event))
