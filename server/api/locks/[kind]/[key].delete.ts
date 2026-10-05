import { defineEventHandler } from 'h3'
import { forceReleaseLockForHttp } from '../../../../src/server/access/admin-http'

export default defineEventHandler(event => forceReleaseLockForHttp(event))
