# Agent Runtime 上下文与状态架构契约

本文件是 `navisworks-desktop-electron` Agent Runtime 的现行架构契约。修改
`src/main/agent/**`、`src/main/agentRuntime.ts`、`src/main/model/**` 或 `src/main/kernel/**` 前必须先对齐本文。

P0–P6 的主体能力已经落地：ContextFrame、有限 token 预算、文档身份、Verified Facts、Reference Sets、
Tool Result Recall、Semantic Memory、持久执行账本及 Cordis 生命周期。它们不改变聊天 UI，也不扩大
Navisworks 工具权限。

## 一、状态作用域

`ScopeKind` 共四档；Document 与 Conversation **正交**，不是父子关系。

```text
                         App Scope
                             │
             ┌───────────────┴───────────────┐
             │                               │
     Conversation Scope               Document Scope
             │                               │
             └───────────────┬───────────────┘
                             │
                         Run Scope
```

| Scope | 生命周期 | 主要状态 |
|---|---|---|
| App | Electron main 启动至退出 | ModelRouter、Settings、Tool Catalog、Session Store、Instance Registry/Selection、ContextState、Approval、Execution Ledger、Cordis Root |
| Conversation | ChatSession 创建至删除 | `semanticMemory`、`compactSummary`、会话元信息；不永久持有 Navisworks 精确 ID |
| Document | 文档实例激活至关闭、切换、实例选择变化或插件会话变化 | `instanceId`、`documentInstanceId`、`bridgeSessionId`、Verified Facts、Reference Sets、易失状态 |
| Run | 一次 `chat.start` 至 done/error/abort | `runId`、不可变 Navisworks Run Binding、当前 Conversation/Document 引用、最近完整帧、当前工具交换与审批 |

`AgentScopeManager` 把 Conversation 与 Document 分别建成 App 的子 Scope；Run 也是 App 子 Scope，只保存对
两者的 service reference。这样同一 Conversation 可跨文档，同一 Document 也可被多个 Conversation 使用。

## 二、核心不变量

- **A**：每个 Run 只能绑定一个 `instanceId + bridgeSessionId + documentInstanceId` 环境；工具调用不得重新读取当前 UI 选择。
- **B**：实例或文档身份变化后，旧引用不得进入修改型工具；旧 facts、reference sets 和 pending approvals 同时失效。
- **C**：LLM 生成的 summary / memory 永远不能成为 Verified Fact。
- **D**：assistant tool call 与其全部 tool results 作为一个 `ContextFrame` 原子保留或删除。
- **E**：修改型工具执行必须绑定真实 `runId`、`toolCallId`、`instanceId`、`bridgeSessionId`、`documentInstanceId` 与参数哈希。
- **F**：`ambiguous` execution 不自动重试；只有用户明确要求仍然执行，才重新审批并继续。
- **G**：`ContextManager` 不判断 local/cloud，只接收上层算好的有限 `effectiveContextWindow`。

机器可确定的文档身份、工具完成状态、最近结果集、审批和错误由 Runtime 管理，不依赖模型输出固定
`<status>`。模型只提供自然语言目标和回答。

## 三、ContextFrame 与组装顺序

上下文裁剪和压缩只操作完整帧：

```ts
type ContextFrame =
  | UserTurnFrame
  | AssistantTextFrame
  | ToolExchangeFrame
  | CompactSummaryFrame
```

`ToolExchangeFrame` 同时持有一条 assistant 消息、其中一个或多个 `toolCalls`，以及每个 call 的结果。
`messagesToContextFrames()` 与 `contextFramesToMessages()` 负责无损往返；`findOrphanToolMessages()` 用于测试协议合法性。

当前请求的组装顺序：

1. System Prompt
2. Semantic Memory（长期目标与约束，不含精确工程 ID）
3. Compact Summary（早期语义历史，不是事实）
4. Verified Facts
5. 当前 Conversation + Document 的 Active Reference Set
6. 该 Reference Set 对应的持久 Tool Result 召回片段
7. Recent Context Frames
8. Current User Input
9. Tools Schema（单独计入预算）

当前用户指令及其后产生的工具交换是受保护帧。高压下只删除旧历史帧；自动压缩至少积累三个完整工具
交换后才摘要较早两个，并保留最新交换原文，避免丢失仍在使用的 Tool Call ID。

## 四、Token 预算与 Provider 边界

```text
contextBudget = effectiveContextWindow
              - outputReserve
              - providerOverhead
              - safetyMargin

要求：estimatedMessages + toolSchemaTokens <= contextBudget
```

- 无精确 tokenizer 时使用保守的 CJK / ASCII 估算器。
- `CONTEXT_SOFT_PRESSURE_RATIO = 0.80`；`CONTEXT_COMPACT_TRIGGER_RATIO = 0.85`。
- 本地 Ollama 窗口硬封顶 32768，并收到 `num_ctx`。
- OpenAI 兼容端点使用配置或 capability 给出的有限窗口做内部预算，但不发送 `num_ctx`，也不默认当作 1M。
- 工具 Schema、输出预留、provider overhead 和 safety margin 都进入预算。

`ModelProvider.capabilities(model)` 只暴露能力：tools、thinking、已知最大/默认上下文和可选最大输出。
Provider 自己负责 Ollama ndjson 或 OpenAI SSE 的线格式；`ContextManager` 不依赖 Provider 类型。

## 五、实例与文档身份、事实与引用

桌面端把 Discovery、Selection 与 Run Binding 分开：注册表发现所有 endpoint，用户选择下一轮目标，
Run 开始时冻结 `instanceId`、endpoint、`bridgeSessionId` 和 `documentInstanceId`。插件启动时生成稳定的
`bridgeSessionId`；每次打开、切换或重新打开文档时生成新的 `documentInstanceId`。
`navisworks_status` 返回这些身份，`ContextState` 通过轮询和工具结果持续观察。切换到另一个窗口属于
`instance-changed`，同一窗口换文档属于 `document-changed`；两者都不会被描述成上一轮查询错误。

Verified Fact 只能由确定性的 tool-result extractor 产生，并携带：

- `sourceToolCallId`
- `documentInstanceId`
- `observedAt`
- `volatility`（stable/document/volatile）
- `priority`（critical/active/normal）

同 key 的新事实替换旧事实；selection 等 volatile facts 默认 30 秒后不再注入。实例或文档切换会删除
旧环境的全部 facts。

Reference Set 保存搜索结果、选择或视点的有序 ID，并同时绑定 Conversation、Document 和来源 Tool Call。
因此“第一个 / 第三个 / 刚才那些”按机器保存的顺序重新注入，而不是依赖模型重读旧文本。文档变化或会话
删除后，相应引用失效。

## 六、Tool Result Recall 与会话记忆

`ToolResultIndex` 只索引现有 `sessions.json` 中的工具记录，不创建第二份 Session Store。超过 256 KiB 的
工具结果写入数据目录的 `tool-results/`，会话中保存带 preview 和 byteLength 的引用；会话删除或保存时清理
不再被引用的外置文件。

Provider 可见的单轮工具结果仍有 4000 字符护栏，但会附结构摘要；需要历史完整值时，Runtime 根据
`sessionId + toolCallId` 从本地持久结果内部召回。

Conversation 持久化 `SemanticMemory` 与 `compactSummary`：

- Semantic Memory 保存 goals、constraints、decisions、notes 和 `updatedAt`，精确 ID 会被脱敏。
- Compact Summary 保存较早语义过程。
- 两者都不能生成 Verified Fact，也不能直接驱动修改型工具参数。

旧会话缺少新字段时按安全默认读取，保持向后兼容。

## 七、修改型工具执行安全

`ToolExecutionLedger` 对 view-state-change 工具持久记录，并保存实例、插件会话与文档身份：

```text
requested → awaiting-approval → approved → executing
                                      ├─→ success
                                      ├─→ failed
                                      └─→ ambiguous → resolved
```

审批绑定真实 Tool Call、参数哈希和 Run Binding。批准后、取得同环境执行锁后都会再次校验
`instanceId + bridgeSessionId + documentInstanceId`；等待期间发生切换也不会把审批应用到另一实例。
环境变化会主动取消对应的待审批请求。

同一实例 + Document 的修改型工具由 `DocumentOperationCoordinator` 串行执行；只读工具不经过该队列。Bridge 在
请求可能已经送达后发生超时/I/O 错误时标记 `ambiguous`。启动时残留的 `executing` 也转成 `ambiguous`，
不自动重放。

账本使用临时文件原子替换，并保留 `execution-ledger.backup.json` 作为主文件损坏时的回退。

## 八、Cordis 边界

Cordis 只负责 service registry、依赖、Scope 和 disposal，不负责 Agent reasoning。封装集中在
`src/main/kernel/**`，Domain 类型不依赖 Cordis。

App Scope 注册 Session、Settings、ModelRouter、Tool Catalog、Navisworks Bridge、Instance Registry/Selection、
AgentRuntime、Compaction、Approval、ContextState、ExecutionLedger、OperationCoordinator 与 AgentScopeManager。
Run 结束、会话删除、文档失效和应用退出都有对应 dispose 路径。

## 九、ContextBuildReport 与已知边界

每次请求内部生成 `ContextBuildReport`，包含窗口、输入估算、输出预留、安全余量、System、Tools Schema、
Semantic Memory、Verified Facts、Recent Frames 及裁剪数量。报告暂不改变 UI。

目前没有单独的 `WorkingState` 数据结构或 model-visible block，`workingStateTokens` 保持 0；已完成 Tool Call、
审批、文档身份和错误状态分别由 ContextState、Run、Approval 与 Ledger 维护。若以后需要显式计划状态，应新增
独立 Domain 类型，不能塞回 Semantic Memory 或让模型自由生成精确执行状态。

自动化验证覆盖 ContextFrame 原子性、有限窗口、文档失效、引用顺序、事实来源、大结果召回、compact、账本
恢复、ambiguous 拦截、审批竞态、同文档串行和 Cordis 正交 Scope。自动化不替代真实 Electron GUI、Ollama
或 Navisworks 业务验收。
