import { z } from 'zod'
import { REASONING_EFFORTS, type ReasoningEffort } from '../reasoning'
import type { ModelConfiguration, ModelInfo, ModelUsage } from '../model'

const nonEmptyString = z.string().trim().min(1)
const dateTimeString = z.string().trim().min(1)

/** Tool permission: allow executes silently, ask gates on user approval, deny hides the tool. */
export const toolPermissionSchema = z.enum(['allow', 'ask', 'deny'])

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

/**
 * P30.7 generic tool identity: an OPEN namespace string, so a future
 * `files_read` / `browser_open` / `web_search` can be stored in disabledTools,
 * carried as a ToolName, and approved through the generic Tool-Approval event
 * WITHOUT ever re-widening a closed enum (§36/§37). The character set allows
 * the `:`/`_`/`.`/`-` namespaces a capability may want while refusing
 * whitespace and other junk; it deliberately does NOT hardcode any
 * capability's name. The 128-char ceiling is a defensive bound, not a limit
 * on legitimate namespaces.
 */
export const toolNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/, '工具名只允许字母、数字与 _ . : - 组合。')

/**
 * P30.7 Navisworks-only tool names. This STAYS a closed enum because the
 * `navisworks.tool.execute` route legitimately only exposes the direct
 * Navisworks READ tools (§38/§100) — future non-Navisworks capabilities must
 * NOT be reachable through it.
 */
/** P30.7: keep persisted/legacy disabled-tool entries that are well-formed
 *  (old names still work; future-capability names survive a settings
 *  round-trip — the closed enum would silently drop them, §39/§96) and drop
 *  malformed junk. Order-preserving and de-duplicating. */
export function sanitizeToolNames(values: Iterable<unknown>): string[] {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const value of values) {
    const parsed = toolNameSchema.safeParse(value)
    if (parsed.success && !seen.has(parsed.data)) {
      seen.add(parsed.data)
      kept.push(parsed.data)
    }
  }
  return kept
}

export const navisworksToolNameSchema = z.enum([
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

/**
 * Model System v1 shared schemas — single IPC source for model identity,
 * capabilities and raw usage. The plain-TS twins live in src/shared/model.ts;
 * the compile-time guards at the bottom of this file pin the two together.
 * modelRefSchema is declared here (above appSettingsSchema) because the
 * per-model configuration settings below reference it — a zod schema is a
 * VALUE, so it must exist before it is composed.
 */
export const modelRefSchema = z.strictObject({
  providerId: nonEmptyString,
  modelId: nonEmptyString,
})

/** Model Configuration v2 (§18/§24): modality metadata. */
export const modelInputModalitySchema = z.enum(['text', 'image', 'video', 'pdf'])
export const modelOutputModalitySchema = z.enum(['text', 'image'])

/**
 * A per-model configuration (§18/§19/§28). Numeric fields are `nullish` →
 * absent/null = Auto (no forced value). Bounds match §28: context 1024..2,000,000,
 * output 128..1,000,000. Modalities default to text-only (the safe truth until
 * a real transport is wired, §25).
 */
export const modelConfigurationSchema = z.strictObject({
  ref: modelRefSchema,
  contextWindowTokens: z.number().int().min(1024).max(2_000_000).nullish(),
  maxOutputTokens: z.number().int().min(128).max(1_000_000).nullish(),
  // OPTIONAL in both the wire type and the shared ModelConfiguration interface:
  // an absent side means "text-only" (the safe default the resolver applies),
  // which keeps the settings UPDATE PATCH (a partial) assignable to the stored
  // shape with no zod input/output drift.
  inputModalities: z.array(modelInputModalitySchema).readonly().optional(),
  outputModalities: z.array(modelOutputModalitySchema).readonly().optional(),
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
  /** Per-tool permission overrides (allow/ask/deny); absent keys use registry defaults. */
  toolPermissions: z.nullish(z.record(z.string(), toolPermissionSchema)).transform((value) => value ?? {}),
  /** Run-scoped agent execution policy; absent in old payloads → defaults. */
  execution: z.nullish(executionSettingsSchema).transform((value) => value ?? DEFAULT_EXECUTION_SETTINGS),
  /** Disk-history retention; absent in old payloads → defaults. */
  storage: z.nullish(storageSettingsSchema).transform((value) => value ?? DEFAULT_STORAGE_SETTINGS),
  /**
   * Model Configuration v2 (§19/§20): PER-MODEL overrides, bound to a
   * structured ModelRef. OPTIONAL — absent in old settings.json → the resolver
   * treats it as [] and the file loads unchanged (no migration wizard).
   */
  modelConfigurations: z.array(modelConfigurationSchema).optional(),
})

/** One registry tool as surfaced to the settings UI (resolved permission included). */
export const toolDefinitionSummarySchema = z.strictObject({
  name: nonEmptyString,
  label: nonEmptyString,
  description: z.string(),
  impact: z.enum(['read-only', 'view-state-change']),
  /** @deprecated display compatibility; capability grouping reads capabilityId. */
  category: z.enum(['navisworks', 'internal']),
  /** Capability Architecture v1: present only for capability-contributed tools. */
  capabilityId: z.string().optional(),
  capabilityName: z.string().optional(),
  permission: toolPermissionSchema,
  defaultPermission: toolPermissionSchema
})

/**
 * Where the context window a run budgeted against came from. Model Config v2:
 * 'model' = the user set an explicit per-model override (highest priority).
 * 'fallback' remains a SAFETY BUDGET, never a real model maximum.
 */
export const contextWindowSourceSchema = z.enum(['local', 'profile', 'provider', 'fallback', 'model'])

/**
 * P16 Question System — the single source for question identity so the IPC
 * schema, the main-service state and the renderer UI can never drift (§16).
 * Question ≠ Tool Approval: a question means the Agent LACKS information.
 * Answers are indexed by ARRAY POSITION (§5: never trust a model-supplied id).
 */
export const questionKindSchema = z.enum(['single', 'multiple', 'text'])
export const questionSourceSchema = z.enum(['tool', 'doom-loop'])

export const questionOptionSchema = z.strictObject({
  label: z.string().trim().min(1).max(200),
  description: z.string().max(500).optional(),
})

/** One prompt. `single`/`multiple` require 2–8 options; `text` forbids options. */
export const questionPromptSchema = z.strictObject({
  question: z.string().trim().min(1).max(500),
  kind: questionKindSchema,
  options: z.array(questionOptionSchema).min(2).max(8).optional(),
  required: z.boolean().optional(),
}).superRefine((prompt, ctx) => {
  if ((prompt.kind === 'single' || prompt.kind === 'multiple') && prompt.options === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'single/multiple 必须提供 2–8 个 options', path: ['options'] })
  }
  if (prompt.kind === 'text' && prompt.options !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'text 不允许提供 options', path: ['options'] })
  }
})

export const questionAnswerSchema = z.strictObject({
  questionIndex: z.number().int().min(0),
  values: z.array(z.string().max(500)).max(8),
})

/** A question the model raised for the user (wire shape; no resolvers). */
export const questionRequestSchema = z.strictObject({
  requestId: nonEmptyString,
  runId: nonEmptyString,
  sessionId: nonEmptyString,
  turnId: nonEmptyString.optional(),
  messageId: nonEmptyString.optional(),
  toolCallId: nonEmptyString.optional(),
  source: questionSourceSchema,
  questions: z.array(questionPromptSchema).min(1).max(4),
  createdAt: z.number().int().nonnegative(),
})

/** Raw provider usage. Absent field = NOT REPORTED — never a faked 0. */
export const modelUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
})

export const modelInfoSchema = z.strictObject({
  ref: modelRefSchema,
  displayName: z.string(),
  provider: z.strictObject({
    id: nonEmptyString,
    displayName: z.string(),
    kind: z.enum(['ollama', 'openai-compatible']),
  }),
  capabilities: z.strictObject({
    tools: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    temperature: z.boolean().optional(),
    attachments: z.boolean().optional(),
    // Model Configuration v2 (§24): modality metadata, .readonly() to stay
    // mutually assignable with the shared ModelCapabilities type.
    modalities: z.strictObject({
      input: z.array(modelInputModalitySchema).readonly().optional(),
      output: z.array(modelOutputModalitySchema).readonly().optional(),
    }).optional(),
  }),
  limits: z.strictObject({
    context: z.number().int().positive().optional(),
    input: z.number().int().positive().optional(),
    output: z.number().int().positive().optional(),
  }),
  reasoning: z.strictObject({
    // .readonly() keeps the schema output mutually assignable with the
    // shared ModelInfo type (`readonly ReasoningEffort[]`).
    modes: z.array(reasoningEffortSchema).readonly(),
    // Wire request policy (compatibility), deliberately distinct from
    // capabilities.reasoning (the capability truth). Absent = no policy stated.
    requestPolicy: z.enum(['auto', 'on', 'off']).optional(),
  }),
  metadataSource: z.enum(['local', 'profile', 'provider', 'model', 'unknown']),
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
  'tools.list': {
    input: emptyInput,
    output: z.array(toolDefinitionSummarySchema)
  },
  /** The ACTIVE model's identity + metadata, resolved once by main (P8). */
  'model.info.get': {
    input: emptyInput,
    output: modelInfoSchema
  },
  /** Answer a pending question; must belong to this session (Main verifies §101). */
  'question.answer': {
    input: z.strictObject({
      requestId: nonEmptyString,
      answers: z.array(questionAnswerSchema).min(1).max(4),
    }),
    output: z.strictObject({ resolved: z.boolean() })
  },
  /** User declines to answer — the model gets question_rejected, the run continues. */
  'question.reject': {
    input: z.strictObject({ requestId: nonEmptyString }),
    output: z.strictObject({ resolved: z.boolean() })
  },
  /** Re-attach pending questions after a session switch (§18) — never event-only UI. */
  'question.pending.list': {
    input: z.strictObject({ sessionId: nonEmptyString.optional() }),
    output: z.array(questionRequestSchema)
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
      // P30.7: this route stays restricted to Navisworks read tools — the
      // direct-invoke path is a Navisworks UI integration API, not a generic
      // capability bus (Invariant J).
      toolName: navisworksToolNameSchema,
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

const chatDoneEventSchema = z.strictObject({
  ...chatEventBase,
  kind: z.literal('done'),
  content: z.string(),
  thinkingText: z.string().optional(),
  /** P6 raw provider usage — the truth the legacy numbers below are derived from. */
  usage: modelUsageSchema.optional(),
  contextTokensUsed: z.number().optional(),
  cacheHitRate: z.number().optional(),
  contextWindowTokens: z.number().optional(),
  contextWindowSource: contextWindowSourceSchema.optional(),
  /**
   * Model Configuration v2 (§31): the ModelRef this run's window/usage was
   * budgeted against. The renderer only reuses a reported window when it belongs
   * to the CURRENT active model — a stale 32K from another model can never
   * contaminate the ring. Absent on legacy runs (renderer then ignores it).
   */
  modelRef: modelRefSchema.optional(),
  compacted: z.boolean().optional()
})

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
  // Single source of truth: the standalone chat.done schema below is reused
  // here so the two done definitions can never drift again (a drifted copy
  // made the real IPC emit drop every chat.done with contextWindowSource).
  chatDoneEventSchema,
  z.strictObject({
    ...chatEventBase,
    kind: z.literal('error'),
    error: z.strictObject({ code: z.string(), message: z.string() })
  })
])

const chatChunkEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...chatEventBase, kind: z.literal('thinking'), delta: z.string() }),
  z.strictObject({ ...chatEventBase, kind: z.literal('text'), delta: z.string() }),
  z.strictObject({ ...chatEventBase, kind: z.literal('phase'), phase: z.enum(['generating', 'verifying', 'awaiting-user-input']) }),
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

const chatErrorEventSchema = z.strictObject({
  ...chatEventBase,
  kind: z.literal('error'),
  error: z.strictObject({ code: z.string(), message: z.string() })
})

export const eventSchemas = {
  'chat.chunk': chatChunkEventSchema,
  'chat.done': chatDoneEventSchema,
  'chat.error': chatErrorEventSchema,
  /** P16: the Agent needs information — a pending question for the renderer. */
  'question.requested': questionRequestSchema,
  'tool.approval.requested': z.strictObject({
    approvalId: nonEmptyString,
    runId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString,
    messageId: nonEmptyString,
    toolCallId: nonEmptyString,
    // P30.7: approval can concern ANY capability tool, so the name is the
    // generic toolNameSchema (future fake/files/web tools validate) — never a
    // closed enum. Navisworks-only strictness lives on navisworks.tool.execute.
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
export type ToolDefinitionSummary = z.output<typeof toolDefinitionSummarySchema>
export type ToolApprovalRequest = z.output<typeof eventSchemas['tool.approval.requested']>
export type ToolPermission = z.output<typeof toolPermissionSchema>

export type {
  ModelRef,
  ModelInfo,
  ModelUsage,
  ModelConfiguration,
  ModelInputModality,
  ModelOutputModality,
} from '../model'

export type ContextWindowSource = z.output<typeof contextWindowSourceSchema>
export type QuestionKind = z.output<typeof questionKindSchema>
export type QuestionSource = z.output<typeof questionSourceSchema>
export type QuestionOption = z.output<typeof questionOptionSchema>
export type QuestionPrompt = z.output<typeof questionPromptSchema>
export type QuestionAnswer = z.output<typeof questionAnswerSchema>
export type QuestionRequest = z.output<typeof questionRequestSchema>
export type ModelRefSummary = z.output<typeof modelRefSchema>
export type ModelUsageSummary = z.output<typeof modelUsageSchema>
export type ModelInfoSummary = z.output<typeof modelInfoSchema>
export type ModelConfigurationSummary = z.output<typeof modelConfigurationSchema>

// Compile-time pins so the IPC schema and the shared Model System types can
// never drift (same failure class as the old chat.done schema drift): every
// ModelUsageSummary is a ModelUsage and vice versa.
const _modelUsageGuard: ModelUsage = null as unknown as ModelUsageSummary
const _modelUsageGuardBack: ModelUsageSummary = null as unknown as ModelUsage
const _modelInfoGuard: ModelInfo = null as unknown as ModelInfoSummary
const _modelInfoGuardBack: ModelInfoSummary = null as unknown as ModelInfo
// Model Configuration v2: the per-model config schema and the shared
// ModelConfiguration type must not drift (modalities readonly-pinned above).
const _modelConfigGuard: ModelConfiguration = null as unknown as ModelConfigurationSummary
const _modelConfigGuardBack: ModelConfigurationSummary = null as unknown as ModelConfiguration
void _modelUsageGuard
void _modelUsageGuardBack
void _modelInfoGuard
void _modelInfoGuardBack
void _modelConfigGuard
void _modelConfigGuardBack
