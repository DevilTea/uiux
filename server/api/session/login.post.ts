import { defineEventHandler } from 'h3'
import { loginForHttp } from '../../../src/server/access/admin-http'

export default defineEventHandler(event => loginForHttp(event))
