import { z } from 'zod'

const nonEmptyString = z.string().trim().min(1)
const dateTimeString = z.string().trim().min(1)

export const messageRoleSchema = z.enum(['user', 'assistant', 'system', 'error'])

const textPartSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string()
})

const thinkingPartSchema = z.strictObject({
  type: z.literal('thinking'),
  text: z.string()
})

const toolCallPartSchema = z.strictObject({
  type: z.literal('tool-call'),
  toolCallId: nonEmptyString,
  toolName: nonEmptyString,
  arguments: z.unknown().optional(),
  result: z.unknown().optional(),
  status: z.enum(['running', 'success', 'error'])
})

const errorPartSchema = z.strictObject({
  type: z.literal('error'),
  message: z.string()
})

export const messagePartSchema = z.discriminatedUnion('type', [
  textPartSchema,
  thinkingPartSchema,
  toolCallPartSchema,
  errorPartSchema
])

export const chatMessageSchema = z.strictObject({
  id: nonEmptyString,
  role: messageRoleSchema,
  content: z.string(),
  thinking: z.string().optional(),
  createdAt: dateTimeString,
  transient: z.boolean().optional(),
  tools: z.array(
    z.strictObject({
      id: nonEmptyString,
      name: nonEmptyString,
      status: z.enum(['queued', 'running', 'success', 'error', 'cancelled']),
      arguments: z.unknown().optional(),
      result: z.unknown().optional(),
      error: z.string().optional()
    })
  ),
  parts: z.array(messagePartSchema).optional()
})

export const sessionSummarySchema = z.strictObject({
  id: nonEmptyString,
  title: z.string(),
  preview: z.string(),
  updatedAt: dateTimeString,
  pinnedAt: dateTimeString.nullable().optional(),
  contextTokensUsed: z.number().int().nonnegative().optional()
})

export const sessionSchema = sessionSummarySchema.extend({
  createdAt: dateTimeString.optional(),
  messages: z.array(chatMessageSchema),
  // P4: the durable result of context compaction — a short digest of early turns. Optional
  // so older sessions.json files load unchanged (missing field ⇒ no summary yet).
  compactSummary: z.string().optional(),
  semanticMemory: z.strictObject({
    goals: z.array(z.string()),
    constraints: z.array(z.string()),
    decisions: z.array(z.string()),
    notes: z.array(z.string()),
    updatedAt: z.number().int().nonnegative()
  }).optional()
})

export const themeModeSchema = z.enum(['system', 'light', 'dark'])
export const effectiveThemeSchema = z.enum(['light', 'dark'])

export const appearanceStateSchema = z.strictObject({
  themeMode: themeModeSchema,
  effectiveTheme: effectiveThemeSchema
})

export const toolNameSchema = z.enum([
  'navisworks_status',
  'navisworks_get_document',
  'navisworks_get_selection',
  'navisworks_find_items',
  'navisworks_get_item_properties',
  'navisworks_select_items',
  'navisworks_set_visibility',
  'navisworks_list_viewpoints',
  'navisworks_activate_viewpoint'
])

export const apiProfileSchema = z.strictObject({
  id: nonEmptyString,
  name: nonEmptyString,
  baseUrl: z.string(),
  model: z.string(),
  hasApiKey: z.boolean()
})

export const appSettingsSchema = z.strictObject({
  selectedModel: z.string(),
  models: z.array(z.string()),
  reasoningMode: z.enum(['fast', 'deep']),
  themeMode: themeModeSchema,
  disabledTools: z.array(toolNameSchema),
  fontScale: z.number().min(0.85).max(1.3),
  contextWindowTokens: z.number().int().min(1024).max(1_000_000),
  preferApiModel: z.boolean(),
  apiProfiles: z.array(apiProfileSchema),
  activeApiProfileId: z.string().nullable()
})

export const navisworksStatusSchema = z.strictObject({
  connected: z.boolean(),
  status: z.string(),
  documentName: z.string().optional(),
  selectionCount: z.number().int().nonnegative().optional(),
  bridgeSessionId: z.string().optional(),
  documentInstanceId: z.string().optional()
})

export const runtimeInfoSchema = z.strictObject({
  version: z.string(),
  platform: z.string(),
  isPackaged: z.boolean(),
  dataDirectory: z.string(),
  profile: z.string()
})

const emptyInput = z.undefined()

export const requestSchemas = {
  'app.runtime.get': {
    input: emptyInput,
    output: runtimeInfoSchema
  },
  'sessions.list': {
    input: emptyInput,
    output: z.array(sessionSummarySchema)
  },
  'sessions.get': {
    input: z.strictObject({ sessionId: nonEmptyString }),
    output: sessionSchema.nullable()
  },
  'sessions.save': {
    input: z.strictObject({ session: sessionSchema }),
    output: sessionSchema
  },
  'sessions.delete': {
    input: z.strictObject({ sessionId: nonEmptyString }),
    output: z.void()
  },
  'sessions.summarizeTitle': {
    input: z.strictObject({ text: nonEmptyString }),
    output: z.strictObject({ title: z.string() })
  },
  'settings.get': {
    input: emptyInput,
    output: appSettingsSchema
  },
  'settings.update': {
    input: z.strictObject({ settings: appSettingsSchema.partial() }),
    output: appSettingsSchema
  },
  'api.profile.save': {
    input: z.strictObject({
      id: z.string().optional(),
      name: z.string().trim().min(1).max(60),
      baseUrl: z.string().trim().max(2048),
      model: z.string().trim().max(200),
      apiKey: z.string().max(4096).optional(),
      clearApiKey: z.boolean().optional()
    }),
    output: appSettingsSchema
  },
  'api.profile.delete': {
    input: z.strictObject({ profileId: nonEmptyString }),
    output: appSettingsSchema
  },
  'api.profile.models.list': {
    input: z.strictObject({ profileId: nonEmptyString }),
    output: z.array(z.string())
  },
  'api.profile.connection.test': {
    input: z.strictObject({ profileId: nonEmptyString }),
    output: z.strictObject({ connected: z.boolean(), message: z.string() })
  },
  'appearance.get': {
    input: emptyInput,
    output: appearanceStateSchema
  },
  'appearance.update': {
    input: z.strictObject({ themeMode: themeModeSchema }),
    output: appearanceStateSchema
  },
  'ollama.models.list': {
    input: z.strictObject({
      baseUrl: z.string().url().optional(),
      apiKey: z.string().optional()
    }).optional(),
    output: z.array(z.string())
  },
  'ollama.connection.test': {
    input: z.strictObject({
      baseUrl: z.string().url().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional()
    }).optional(),
    output: z.strictObject({ connected: z.boolean(), message: z.string() })
  },
  'chat.start': {
    input: z.strictObject({
      sessionId: nonEmptyString,
      messageId: nonEmptyString,
      text: nonEmptyString,
      model: z.string().optional(),
      reasoningMode: z.enum(['fast', 'deep']).optional()
    }),
    output: z.strictObject({
      runId: nonEmptyString,
      sessionId: nonEmptyString,
      turnId: nonEmptyString
    })
  },
  'chat.abort': {
    input: z.strictObject({
      sessionId: nonEmptyString,
      turnId: nonEmptyString.optional()
    }),
    output: z.strictObject({ aborted: z.boolean() })
  },
  'tool.approval.resolve': {
    input: z.strictObject({
      approvalId: nonEmptyString,
      decision: z.enum(['confirm', 'cancel'])
    }),
    output: z.strictObject({ resolved: z.boolean() })
  },
  'chat.compact': {
    input: z.strictObject({ sessionId: nonEmptyString }),
    output: z.strictObject({ summary: z.string() })
  },
  'navisworks.status.get': {
    input: emptyInput,
    output: navisworksStatusSchema
  },
  'navisworks.tool.execute': {
    input: z.strictObject({
      toolName: toolNameSchema,
      arguments: z.record(z.string(), z.unknown())
    }),
    output: z.unknown()
  }
} as const

const chatEventBase = {
  runId: nonEmptyString,
  sessionId: nonEmptyString,
  turnId: nonEmptyString,
  messageId: nonEmptyString
}

export const chatEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...chatEventBase, kind: z.literal('thinking'), delta: z.string() }),
  z.strictObject({ ...chatEventBase, kind: z.literal('text'), delta: z.string() }),
  z.strictObject({
    ...chatEventBase,
    kind: z.literal('tool-start'),
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    arguments: z.unknown()
  }),
  z.strictObject({
    ...chatEventBase,
    kind: z.literal('tool-result'),
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    arguments: z.unknown().optional(),
    result: z.unknown(),
    error: z.strictObject({ code: z.string(), message: z.string() }).optional()
  }),
  z.strictObject({
    ...chatEventBase,
    kind: z.literal('done'),
    content: z.string(),
    thinkingText: z.string().optional(),
    contextTokensUsed: z.number().optional(),
    cacheHitRate: z.number().optional(),
    compacted: z.boolean().optional()
  }),
  z.strictObject({
    ...chatEventBase,
    kind: z.literal('error'),
    error: z.strictObject({ code: z.string(), message: z.string() })
  })
])

const chatChunkEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...chatEventBase, kind: z.literal('thinking'), delta: z.string() }),
  z.strictObject({ ...chatEventBase, kind: z.literal('text'), delta: z.string() }),
  z.strictObject({
    ...chatEventBase,
    kind: z.literal('tool-start'),
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    arguments: z.unknown()
  }),
  z.strictObject({
    ...chatEventBase,
    kind: z.literal('tool-result'),
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    arguments: z.unknown().optional(),
    result: z.unknown(),
    error: z.strictObject({ code: z.string(), message: z.string() }).optional()
  })
])

const chatDoneEventSchema = z.strictObject({
  ...chatEventBase,
  kind: z.literal('done'),
  content: z.string(),
  thinkingText: z.string().optional(),
  contextTokensUsed: z.number().optional(),
  cacheHitRate: z.number().optional(),
  compacted: z.boolean().optional()
})

const chatErrorEventSchema = z.strictObject({
  ...chatEventBase,
  kind: z.literal('error'),
  error: z.strictObject({ code: z.string(), message: z.string() })
})

export const eventSchemas = {
  'chat.chunk': chatChunkEventSchema,
  'chat.done': chatDoneEventSchema,
  'chat.error': chatErrorEventSchema,
  'tool.approval.requested': z.strictObject({
    approvalId: nonEmptyString,
    runId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString,
    messageId: nonEmptyString,
    toolCallId: nonEmptyString,
    toolName: toolNameSchema,
    arguments: z.record(z.string(), z.unknown()),
    argumentsHash: nonEmptyString,
    documentInstanceId: nonEmptyString.optional(),
    ambiguousRetry: z.boolean().optional()
  }),
  'navisworks.status.changed': navisworksStatusSchema,
  'nativeTheme.updated': appearanceStateSchema
} as const

export type RequestSchemas = typeof requestSchemas
export type EventSchemas = typeof eventSchemas
export type IpcRoute = keyof RequestSchemas
export type DesktopEventName = keyof EventSchemas
export type InputFor<R extends IpcRoute> = z.input<RequestSchemas[R]['input']>
export type OutputFor<R extends IpcRoute> = z.output<RequestSchemas[R]['output']>
export type EventPayload<E extends DesktopEventName> = z.output<EventSchemas[E]>
export type ChatEvent = z.output<typeof chatEventSchema>
export type Session = z.output<typeof sessionSchema>
export type SessionSummary = z.output<typeof sessionSummarySchema>
export type AppSettings = z.output<typeof appSettingsSchema>
export type ApiProfile = z.output<typeof apiProfileSchema>
export type AppearanceState = z.output<typeof appearanceStateSchema>
export type ThemeMode = z.output<typeof themeModeSchema>
export type EffectiveTheme = z.output<typeof effectiveThemeSchema>
export type NavisworksStatus = z.output<typeof navisworksStatusSchema>
export type RuntimeInfo = z.output<typeof runtimeInfoSchema>
export type ToolName = z.output<typeof toolNameSchema>
export type ToolApprovalRequest = z.output<typeof eventSchemas['tool.approval.requested']>
