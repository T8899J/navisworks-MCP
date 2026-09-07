/**
 * The single compaction summary prompt (P14). ContextManager's automatic
 * path, AgentRuntime's manual /compact path, and CompactionService all render
 * from this one string — there is deliberately no second summary rule (§37/§90).
 */
export const COMPACT_SYSTEM_PROMPT = '你是会话压缩器。把提供的对话与工具过程压缩为一份简洁的工作摘要，必须保留：用户目标、已验证的关键事实（构件 ID、名称、数量、属性要点）、已执行的操作及结果、重要错误、未完成的步骤。不要编造，不要添加建议，只输出摘要本身。'
