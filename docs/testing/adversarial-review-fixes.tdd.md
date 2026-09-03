# 对抗性审查修复 TDD 证据

## 来源与用户路径

本轮测试场景来自 2026-08-31 的代码审查和对抗性审查：

- 自动压缩默认使用本地模型；手动压缩只使用用户当前显式选择的模型端点。
- 用户执行 `/compact` 时，preload 必须允许调用已经注册的 IPC 路由。
- 模型端点流式响应挂起时，超时和用户停止操作必须结束读取。
- `navisworks_find_items` 返回 `truncated=true` 后，相同参数必须从断点返回下一页。
- `scope=all` 必须继续搜索名称和属性，并避免重复构件。

## RED / GREEN 证据

| 保证 | 测试或命令 | 类型 | RED | GREEN |
|---|---|---|---|---|
| preload 允许 `chat.compact` | `src/preload/__tests__/index.test.ts` | 集成 | `Unknown desktop route: chat.compact` | PASS |
| 自动压缩不隐式切换到 API | `src/main/__tests__/agentRuntime.test.ts` | 单元 | 摘要请求走错端点 | PASS |
| OpenAI 流在响应头后仍受超时约束 | `src/main/__tests__/openaiProvider.test.ts` | 单元 | 150 ms 后仍为 `hung` | PASS |
| Ollama 流在响应头后仍可取消 | `src/main/__tests__/ollamaProvider.test.ts` | 单元 | 150 ms 后仍为 `hung` | PASS |
| 满页搜索保留续扫状态 | `NavisworksCodexMcp.ProtocolTests/Program.cs` | 单元 | `SearchContinuationPolicy` 不存在，编译失败 | PASS |
| `scope=all` 从名称阶段进入属性阶段 | `NavisworksCodexMcp.ProtocolTests/Program.cs` | 单元 | `SearchContinuationPolicy` 不存在，编译失败 | PASS |
| Tool Call / Result 在裁剪与 Compact 中保持原子 | `src/main/agent/__tests__/contextManager.test.ts` | 单元 | 早期实现按单条消息裁剪 | PASS |
| 文档切换取消旧审批且不进入执行队列 | `src/main/__tests__/agentRuntimeP5.test.ts` | 单元 | 审批后排队期间仍可能切换文档 | PASS |
| `executing` 崩溃恢复为 `ambiguous` | `src/main/agent/__tests__/executionLedger.test.ts` | 单元 | 账本只在内存中 | PASS |
| Conversation / Document Scope 正交复用 | `src/main/kernel/__tests__/kernel.test.ts` | 单元 | 无真实 Scope 生命周期 | PASS |

## 已执行验证

- Electron `pnpm verify`：26 个测试文件、177 项测试通过，TypeScript node/web 类型检查通过。
- .NET Framework 协议测试：`PROTOCOL_TESTS: PASS (6/6)`。
- Navisworks 插件 Release/x64 编译：通过。

## 已知缺口

- 仓库尚未配置 Vitest coverage provider，因此本轮没有可用的覆盖率百分比报告。
- 自动化测试无法替代真实 Electron GUI、Navisworks 大模型分页搜索和视图状态修改验收。
- 自动化未覆盖独立的 `WorkingState` model-visible block；当前机器状态分别由 ContextState、Run、Approval 与 Ledger 管理。
- 工作区在本轮开始前已有大量未提交改动；为避免把用户改动混入自动提交，本轮未创建 TDD checkpoint commit。
