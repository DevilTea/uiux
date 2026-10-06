import { defineEventHandler } from 'h3'
import { listLocksForHttp } from '../../src/server/access/admin-http'

export default defineEventHandler(event => listLocksForHttp(event))
