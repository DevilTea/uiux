import { defineEventHandler } from 'h3'
import { healthResponse } from '../../src/server/health'

export default defineEventHandler(() => healthResponse)
