// Local recovery stub for missing generated SDK types.
// The leaked source tree does not include this codegen artifact.

import { z } from 'zod/v4'
import { HookEventSchema, ModelUsageSchema } from './coreSchemas.js'

export type HookEvent = z.infer<typeof HookEventSchema>
export type ModelUsage = z.infer<typeof ModelUsageSchema>
export type SDKMessage = any
