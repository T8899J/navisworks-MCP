# Navisworks Codex MCP

本项目把本机 AI 客户端连接到 Autodesk Navisworks Manage 2023。Navisworks 插件通过命名管道
暴露 9 个工具，两个客户端共用同一条桥：Codex（stdio MCP）与桌面端聊天窗口。

连接链路：

```text
Codex   -> stdio MCP server -> current-user Windows named pipe -> Navisworks plug-in
桌面端  -> BridgeClient     -> current-user Windows named pipe -> Navisworks plug-in
```

> **Codex 那条链只剩二进制**：`mcp-server/`（TypeScript 源）、`console/`（Web 控制台）、
> `navisworks-console/`（C# REPL / stdio MCP）已于 2026-08-20 从仓库删除。Codex 运行的是
> `%LOCALAPPDATA%\NavisworksCodexMcp\mcp-server\navisworks-mcp.mjs`，不受影响；
> `artifacts\mcp-server\navisworks-mcp.mjs` 是它在仓库内的唯一副本，`install.ps1` 靠它重装。
> 该 MCP 服务的工具 schema 已无法再修改。


项目不提供联网搜索，也不允许执行任意 C#、PowerShell 或 Navisworks 脚本。

## 支持范围

- Autodesk Navisworks Manage 2023 x64
- Navisworks API `20.0.1382.63`
- .NET Framework 4.8 插件
- Node.js 20 或更高版本
- Codex CLI 或 Codex Desktop 的本地 stdio MCP
- .NET 8 SDK（桌面端）
- 本机 Ollama（仅桌面端需要）

## 第一版工具

- `navisworks_status`
- `navisworks_get_document`
- `navisworks_get_selection`
- `navisworks_find_items`
- `navisworks_get_item_properties`
- `navisworks_select_items`
- `navisworks_set_visibility`
- `navisworks_list_viewpoints`
- `navisworks_activate_viewpoint`

对象 ID 只在当前 Navisworks 文档和插件会话中有效。打开其他文档或重启
Navisworks 后，应重新查询对象。

## 构建

```powershell
.\scripts\build.ps1
```

默认从以下路径引用 Navisworks 2023 API：

```text
F:\Navisworks\Navisworks Manage 2023
```

其他机器可显式指定：

```powershell
.\scripts\build.ps1 -NavisworksPath '<NavisworksInstallDir>'
```

构建产物写入 `artifacts`，不会修改 Navisworks 或 Codex 配置。

## 安装

先关闭 Navisworks，再运行：

```powershell
.\scripts\install.ps1
```

安装位置：

- 插件：`%APPDATA%\Autodesk\ApplicationPlugins\NavisworksCodexMcp.bundle`
- MCP 服务：`%LOCALAPPDATA%\NavisworksCodexMcp\mcp-server`
- Codex：全局 MCP 条目 `navisworks`

安装器不会结束 Navisworks 进程；检测到正在运行时只会提示需要重启。

## 验证

重启 Navisworks 和 Codex 后，先调用：

```text
navisworks_status
```

返回 `connected: true` 后再调用其他工具。

## 桌面端

`navisworks-desktop` 是一个 WPF 聊天窗口，让**本机 Ollama** 上的模型直接对 Navisworks
做工具调用，不经过 MCP。需要先装好 Ollama（默认 `http://localhost:11434`，默认模型
`qwen3.5:9b-q4_K_M`）。

```powershell
dotnet build navisworks-desktop\NavisworksMcp.Desktop
```

窗口外壳遵循 Windows 桌面习惯：32 px 自绘标题栏保留拖动、双击最大化、系统窗口菜单和标准
最小化/最大化/关闭命令；亮暗色跟随 Windows 应用主题。Windows 11 下还会请求系统 DWM 圆角
与边框，较旧系统继续使用 WPF `WindowChrome` 的兼容行为。

会话与设置存在 `%LOCALAPPDATA%\NavisworksMcpDesktop\`：`sessions.json` 是主会话文件，
`sessions.backup.json` 是可回退副本，`settings.json` 保存模型、推理模式和上次活动会话。
启动时会恢复上次活动会话；主会话文件不可读时会尝试备份，两个文件都不可读时不会用空历史
覆盖原文件。模型只能调用上面那 9 个工具，白名单之外的调用一律拦掉。

> 如果“最近”列表意外为空，应从资源管理器正常启动成品，并核对真实的上述目录。受限自动化或
> 沙箱环境可能看到虚拟化的 `%LOCALAPPDATA%` 文件视图，不能用其直接启动结果代替用户侧验收。

> 桌面端不在 `scripts\build.ps1` 和 `install.ps1` 的交付链里，属于本地工具。
> 它所需的 `Bridge\*.cs` 原先从已删除的 `navisworks-console` 链入，现已并入桌面端自有源码。

## 文档

- [`docs/architecture.md`](docs/architecture.md) — 数据流、构建矩阵
- [`docs/protocol.md`](docs/protocol.md) — 命名管道帧格式与错误码
- [`CLAUDE.md`](CLAUDE.md) — 给 AI 协作者的红线、耦合点与命令速查

## 安全边界

- 命名管道 ACL 只授权当前 Windows 用户
- 单个协议帧最大 1 MiB
- MCP 输入由 Zod 校验
- 模型搜索有时间、数量和扫描上限
- 不开放文件打开、保存、覆盖、删除或任意代码执行
- Autodesk 程序集仅作为编译引用，不进入交付包
