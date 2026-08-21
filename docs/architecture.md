# 架构总览

本仓库是「一条桥 + 一个客户端源码」。桥是 Navisworks 插件里的一个命名管道服务端。

历史上有四个客户端；2026-08-20 删除了其中三个的源码（`mcp-server/`、`console/`、
`navisworks-console/`）。Codex 用的 stdio MCP **仍在运行**，但只以编译产物的形式存在，
见下面「Codex 那条链」。

```text
                  ┌──────────────────────────────────────────────┐
                  │  Navisworks Manage 2023（进程内）            │
                  │  navisworks-plugin (.NET Framework 4.8)      │
                  │    BridgeServer ── UiDispatcher ── NW API    │
                  │    NavisworksToolService ← 9 个工具唯一实现  │
                  └──────────────────────────────────────────────┘
                          ▲  命名管道（ACL 仅当前用户）
                          │  发现：%LOCALAPPDATA%\NavisworksCodexMcp\endpoint.json
              ┌───────────┴────────────┐
              │                        │
     ┌────────┴─────────┐    ┌─────────┴───────────┐
     │ navisworks-mcp   │    │ navisworks-         │
     │ .mjs（无源码）   │    │ desktop (WPF)       │
     │ stdio MCP        │    │ Ollama 聊天 GUI     │
     └────────┬─────────┘    └─────────┬───────────┘
              │                        │
        Codex / Claude Code        桌面窗口
```

## 桥：navisworks-plugin

`.NET Framework 4.8`，作为 Navisworks 2023 插件在宿主进程内运行。

| 文件 | 职责 |
|---|---|
| `NavisworksMcpPlugin.cs` | 插件入口，Navisworks 加载时启动桥 |
| `BridgeServer.cs` | 命名管道服务端（多实例并发 accept，上限 8），ACL 只授权当前 Windows 用户 |
| `BridgeEndpointRegistry.cs` | 写 `endpoint.json`（管道名、协议版本、PID、插件版本、宿主版本） |
| `BridgeFrameProtocol.cs` | 4 字节小端长度 + UTF-8 JSON，单帧上限 1 MiB |
| `NavisworksToolService.cs` | **9 个工具的唯一实现**（大型文件） |
| `UiDispatcher.cs` | 把调用切到 Navisworks 的 UI 线程 |
| `BridgeLogger.cs` / `BridgeContracts.cs` | 日志与请求/响应契约 |

帧格式与错误码见 [protocol.md](protocol.md)。

## Codex 那条链：只剩二进制

原 `mcp-server/`（TypeScript，Node ≥20，产物是单文件 ESM bundle）已删除。现状：

| 位置 | 内容 | 状态 |
|---|---|---|
| `%LOCALAPPDATA%\NavisworksCodexMcp\mcp-server\navisworks-mcp.mjs` | Codex 实际运行的 MCP 服务 | 正常工作 |
| `artifacts\mcp-server\navisworks-mcp.mjs` | 仓库内唯一副本，`install.ps1` 的安装源 | 保留，哈希记入 `SHA256SUMS.txt` |
| `mcp-server/src/**` | TypeScript 源码 | **已删除，不可恢复** |

Codex 的注册项在 `~/.codex/config.toml` 的 `[mcp_servers.navisworks]`，
Claude Code 的在 `~/.claude.json` 的 `mcpServers.navisworks`，两者指向同一个 `.mjs`。

**后果**：该 MCP 服务的工具 schema 无法再修改。若插件侧新增或改动工具，`.mjs` 不会跟着变，
两侧会漂移；要同步只能重写一套 MCP 服务。桌面端不受此限，它直接连管道。

同时删除的还有 Web 控制台（后端 `mcp-server/src/consoleServer.ts` + 前端 `console/public/`）
和 `navisworks-console`（`net8.0` 的 Spectre.Console REPL / 另一套 stdio MCP）。

## 客户端：navisworks-desktop（WPF）

`net8.0-windows`，x64，程序集名 `NavisworksMcpDesktop`。唯一自带 LLM 的客户端：
它不走 MCP，而是直接驱动**本机 Ollama**，让模型对 Navisworks 做工具调用。

| 文件 | 职责 |
|---|---|
| `Services/LlmService.cs` | `OllamaClient`：`http://localhost:11434`，默认模型 `qwen3.5:9b-q4_K_M`，解析 `tool_calls` |
| `ViewModels/MainViewModel.cs` | 会话、设置、白名单 `AllowedAgentTools`、编排循环（大型文件） |
| `MainWindow.xaml(.cs)` | 全部 UI（大型文件）；`Views/` 目录是空的 |
| `App.xaml.cs` | 跟随 Windows 注册表 `AppsUseLightTheme` 切换亮/暗色板 |
| `Themes/DarkTheme.xaml` | 控件样式 |
| `Bridge/{BridgeClient,BridgeTypes,EndpointReader}.cs` | C# 侧管道客户端 |

- 状态落在 `%LOCALAPPDATA%\NavisworksMcpDesktop\`：`sessions.json` 是主会话文件，
  `sessions.backup.json` 是回退副本，`settings.json` 保存模型、推理模式和活动会话 ID；仓库内
  不存这些文件。启动时先读主文件，失败后读备份；两者都不可读时禁用本次持久化，避免退出时
  用空集合覆盖历史。`sessions.json`（含备份）与 `settings.json` 均通过同目录临时文件后
  原子替换写入。
- 上下文窗口固定 16384 tokens。
- 模型只能调 `AllowedAgentTools` 白名单里的 9 个工具，其他一律拦掉。
- **Bridge 归属已变更**：这三个文件原先由 csproj 用 `<Compile Include>` 从 `navisworks-console`
  跨目录链入，随该项目删除已物理并入本项目，现由 SDK 默认 glob 自动包含。命名空间仍是
  `NavisworksMcp.Console.Bridge`（遗留命名，改动需同时动 4 个文件）。

### 窗口外壳与主题

桌面端使用 WPF 自绘窗口壳，但保留 Windows 的非客户区行为：

- `MainWindow.xaml` 以 32 px `WindowChrome` 标题栏提供拖动、双击最大化和 8 px 缩放边界；
  左侧只保留侧栏开关，不显示应用图标或标题文字，46 × 32 px 的标题栏按钮固定在右侧。
- 最小化、最大化/还原和关闭通过 `SystemCommands` 执行；右键标题栏会打开标准 Windows
  系统菜单。交互控件通过 `IsHitTestVisibleInChrome` 从拖动区中排除。
- `MainWindow.xaml.cs` 调用 `DwmSetWindowAttribute` 同步沉浸式深色模式；Windows 11
  （Build 22000 及以上）额外请求系统圆角和默认边框，旧版 Windows 忽略这两个属性。
- `App.xaml.cs` 读取 `AppsUseLightTheme` 并响应 `WM_SETTINGCHANGE`，动态替换亮/暗色资源；
  标题栏按钮在窗口失焦时降低视觉权重。

窗口行为没有自动化测试覆盖。修改 `MainWindow.xaml(.cs)`、`App.xaml.cs` 或标题栏样式后，
应先构建，再在真实窗口中验证拖动、系统菜单、最小化、最大化/还原、关闭和亮/暗主题。

会话恢复也有明确的验收边界：Codex/自动化工具直接启动的进程以及沙箱内读取的
`%LOCALAPPDATA%` 可能落在虚拟化文件视图。用户侧验收必须从资源管理器正常启动成品，并在
沙箱外核对真实 `%LOCALAPPDATA%\NavisworksMcpDesktop\`，不能把受限环境中的结果当作等价证据。

## 构建与测试矩阵

| 子项目 | 怎么构建 | 有测试吗 |
|---|---|---|
| `navisworks-plugin` | `scripts\build.ps1`（vswhere 找 MSBuild） | `tests/NavisworksCodexMcp.ProtocolTests` |
| `navisworks-desktop` | **不在 build.ps1 里**，用 `dotnet build` | 无 |

`scripts\build.ps1` 现在只负责插件 + 插件测试 + 打包校验。它开头的 mcp-server `npm ci`/
`npm run verify` 步骤已加 `Test-Path` 判空：源码目录不存在时打印 `SKIP:` 并跳过，
直接复用 `artifacts\mcp-server\navisworks-mcp.mjs`。桌面端不进 `artifacts/`，也不进 `install.ps1`。

构建被 `Permission denied` 挡住时，通常是 VS Code 的 Roslyn 语言服务器
（`Microsoft.CodeAnalysis.LanguageServer.exe`）或 C# Dev Kit BuildHost 持有 `obj\` 目录句柄。
先 `dotnet build-server shutdown`，必要时结束该进程，VS Code 会自动重启它。

## 交付链

```text
scripts\build.ps1 → scripts\package.ps1 → artifacts\ → scripts\install.ps1 → scripts\verify.ps1
```

`artifacts/` 里是 `NavisworksCodexMcp.bundle`、`mcp-server/navisworks-mcp.mjs` 和 `SHA256SUMS.txt`，
三者哈希互相校验（`verify.ps1` 要求恰好三条）。Autodesk 程序集只作编译引用，不进包。
`install.ps1` 不会结束 Navisworks 进程，检测到正在运行只提示需要重启；
它支持 `-ArtifactRoot`、`-Force`、`-SkipCodexRegistration`。

## 不变量

- 先 `navisworks_status` 拿到 `connected: true`，再调其他工具。
- 对象 ID 只在当前文档 + 当前插件会话内有效；换文档或重启 Navisworks 后必须重新查询。
- 所有搜索有时间、数量、扫描三重上限，不做全模型无界遍历。
- 工具只读模型，最多改视图状态（选择 / 可见性 / 激活视点），不碰磁盘上的模型文件。
