import { z } from 'zod'
import { REASONING_EFFORTS, type ReasoningEffort } from '../reasoning'

const nonEmptyString = z.string().trim().min(1)
const dateTimeString = z.string().trim().min(1)

export const reasoningEffortSchema = z.enum(REASONING_EFFORTS)
export type { ReasoningEffort }

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

/** API-profile compatibility & capability overrides. `null` = Auto (provider default). */
export const apiProfileAdvancedSchema = z.strictObject({
  /** Fixed context window for this endpoint; null → provider capability → safe fallback. */
  contextWindowTokens: z.number().int().min(1024).max(2_000_000).nullable().default(null),
  /** Output cap sent to the endpoint; null → do NOT send any max_tokens parameter. */
  maxOutputTokens: z.number().int().min(128).max(1_000_000).nullable().default(null),
  /** Forced sampling temperature; null → do not send temperature at all. */
  temperature: z.number().min(0).max(2).nullable().default(null),
  requestTimeoutMs: z.number().int().min(5_000).max(600_000).default(300_000),
  /** Which output-limit parameter name the endpoint understands ('omit' sends none). */
  maxTokensParameter: z.enum(['auto', 'max_tokens', 'max_completion_tokens', 'omit']).default('auto'),
  /** 'auto' sends reasoning_effort only when the composer picked a step; 'off' strips it. */
  sendReasoningEffort: z.enum(['auto', 'on', 'off']).default('auto'),
  /** stream_options.include_usage — some gateways reject it; false omits it. */
  sendStreamOptions: z.boolean().default(true)
})

export const DEFAULT_API_PROFILE_ADVANCED: ApiProfileAdvancedSettings = {
  contextWindowTokens: null,
  maxOutputTokens: null,
  temperature: null,
  requestTimeoutMs: 300_000,
  maxTokensParameter: 'auto',
  sendReasoningEffort: 'auto',
  sendStreamOptions: true
}

/**
 * Run-scoped agent execution policy (Agent Core settings). Previously these were
 * local-model hardcodes (8 rounds, 0.85 compaction, 24-message history,
 * 4000-char tool results, 2 planner attempts, 2 replans); they are now
 * user-configurable with defaults and hard schema ceilings.
 */
export const executionSettingsSchema = z.strictObject({
  maxToolRounds: z.number().int().min(1).max(64).default(8),
  compactionEnabled: z.boolean().default(true),
  compactionTriggerRatio: z.number().min(0.5).max(0.98).default(0.85),
  compactKeepRecentFrames: z.number().int().min(0).max(20).default(1),
  compactMaxTranscriptChars: z.number().int().min(2_000).max(200_000).default(30_000),
  /** 'auto' hands the FULL history to ContextManager (token-budgeted); 'fixed' slices first. */
  historyMode: z.enum(['auto', 'fixed']).default('auto'),
  historyMessageLimit: z.number().int().min(4).max(1_000).nullable().default(null),
  /** 'auto' sizes tool results from the remaining context budget; 'fixed' uses the value. */
  toolResultMode: z.enum(['auto', 'fixed']).default('auto'),
  toolResultMaxChars: z.number().int().min(500).max(200_000).nullable().default(null),
  plannerMaxAttempts: z.number().int().min(1).max(5).default(2),
  plannerMaxSteps: z.number().int().min(1).max(32).default(10),
  plannerMaxTokens: z.number().int().min(256).max(200_000).nullable().default(2048),
  verifierMaxAttempts: z.number().int().min(1).max(5).default(2),
  verifierMaxEvidence: z.number().int().min(2).max(50).default(12),
  maxTaskReplans: z.number().int().min(0).max(16).default(2)
})

export const DEFAULT_EXECUTION_SETTINGS: ExecutionSettings = {
  maxToolRounds: 8,
  compactionEnabled: true,
  compactionTriggerRatio: 0.85,
  compactKeepRecentFrames: 1,
  compactMaxTranscriptChars: 30_000,
  historyMode: 'auto',
  historyMessageLimit: null,
  toolResultMode: 'auto',
  toolResultMaxChars: null,
  plannerMaxAttempts: 2,
  plannerMaxSteps: 10,
  plannerMaxTokens: 2048,
  verifierMaxAttempts: 2,
  verifierMaxEvidence: 12,
  maxTaskReplans: 2
}

/**
 * Disk-history retention (separate from model-context trimming). 0 disables
 * count-based trimming entirely — the model context window NEVER deletes
 * what the user keeps on disk.
 */
export const storageSettingsSchema = z.strictObject({
  maxSessions: z.number().int().min(0).max(10_000).default(30),
  maxMessagesPerSession: z.number().int().min(0).max(10_000).default(100)
})

export const DEFAULT_STORAGE_SETTINGS: StorageSettings = {
  maxSessions: 30,
  maxMessagesPerSession: 100
}

export const apiProfileSchema = z.strictObject({
  id: nonEmptyString,
  name: nonEmptyString,
  baseUrl: z.string(),
  model: z.string(),
  hasApiKey: z.boolean(),
  /** Absent in old payloads → treated as all-auto defaults. */
  advanced: z.nullish(apiProfileAdvancedSchema).transform(
    (value) => value ?? DEFAULT_API_PROFILE_ADVANCED,
  )
})

export const appSettingsSchema = z.strictObject({
  selectedModel: z.string(),
  models: z.array(z.string()),
  reasoningMode: reasoningEffortSchema,
  themeMode: themeModeSchema,
  disabledTools: z.array(toolNameSchema),
  fontScale: z.number().min(0.85).max(1.3),
  contextWindowTokens: z.number().int().min(1024).max(1_000_000),
  preferApiModel: z.boolean(),
  /** Whether the local Ollama daemon may serve chat requests. */
  ollamaEnabled: z.boolean(),
  /** Whether the configured API endpoint may serve chat requests. */
  apiEnabled: z.boolean(),
  apiProfiles: z.array(apiProfileSchema),
  activeApiProfileId: z.string().nullable(),
  /** Run-scoped agent execution policy; absent in old payloads → defaults. */
  execution: z.nullish(executionSettingsSchema).transform((value) => value ?? DEFAULT_EXECUTION_SETTINGS),
  /** Disk-history retention; absent in old payloads → defaults. */
  storage: z.nullish(storageSettingsSchema).transform((value) => value ?? DEFAULT_STORAGE_SETTINGS)
})

export const navisworksStatusSchema = z.strictObject({
  connected: z.boolean(),
  status: z.string(),
  instanceId: z.string().optional(),
  documentName: z.string().optional(),
  selectionCount: z.number().int().nonnegative().optional(),
  bridgeSessionId: z.string().optional(),
  documentInstanceId: z.string().optional()
})

export const navisworksInstanceSummarySchema = z.strictObject({
  instanceId: nonEmptyString,
  processId: z.number().int().positive(),
  connected: z.boolean(),
  documentName: z.string().optional(),
  hostVersion: z.string(),
  pluginVersion: z.string()
})

export const navisworksConnectionStateSchema = z.strictObject({
  instances: z.array(navisworksInstanceSummarySchema),
  selectedInstanceId: z.string().optional(),
  runningInstanceId: z.string().optional()
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
      clearApiKey: z.boolean().optional(),
      advanced: apiProfileAdvancedSchema.nullish().optional()
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
  'window.control': {
    input: z.strictObject({ action: z.enum(['minimize', 'toggle-maximize', 'close']) }),
    output: z.strictObject({}).transform(() => ({} as Record<string, never>))
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
      reasoningMode: reasoningEffortSchema.optional()
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
  'navisworks.instances.list': {
    input: emptyInput,
    output: navisworksConnectionStateSchema
  },
  'navisworks.instance.select': {
    input: z.strictObject({ instanceId: nonEmptyString }),
    output: navisworksConnectionStateSchema
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
    contextWindowTokens: z.number().optional(),
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
  contextWindowTokens: z.number().optional(),
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
    instanceId: nonEmptyString.optional(),
    bridgeSessionId: nonEmptyString.optional(),
    documentInstanceId: nonEmptyString.optional(),
    ambiguousRetry: z.boolean().optional()
  }),
  'navisworks.status.changed': navisworksStatusSchema,
  'navisworks.instances.changed': navisworksConnectionStateSchema,
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
export type ApiProfileAdvancedSettings = z.output<typeof apiProfileAdvancedSchema>
export type ExecutionSettings = z.output<typeof executionSettingsSchema>
export type StorageSettings = z.output<typeof storageSettingsSchema>
export type AppearanceState = z.output<typeof appearanceStateSchema>
export type ThemeMode = z.output<typeof themeModeSchema>
export type EffectiveTheme = z.output<typeof effectiveThemeSchema>
export type NavisworksStatus = z.output<typeof navisworksStatusSchema>
export type NavisworksInstanceSummary = z.output<typeof navisworksInstanceSummarySchema>
export type NavisworksConnectionState = z.output<typeof navisworksConnectionStateSchema>
export type RuntimeInfo = z.output<typeof runtimeInfoSchema>
export type ToolName = z.output<typeof toolNameSchema>
export type ToolApprovalRequest = z.output<typeof eventSchemas['tool.approval.requested']>
