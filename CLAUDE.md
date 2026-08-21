# CLAUDE.md — Navisworks Codex MCP

把本机 AI 客户端接到 Autodesk Navisworks Manage 2023。一个 Navisworks 插件通过命名管道
暴露 9 个「只读 + 视图状态」工具。

| 组件 | 技术栈 | 角色 |
|---|---|---|
| `navisworks-plugin/` | .NET Framework 4.8 | Navisworks 2023 插件；命名管道服务端；**9 个工具的唯一实现** |
| `navisworks-desktop/` | C# `net8.0-windows` WPF | 聊天式 GUI，驱动**本地 Ollama** 做工具调用；仓库内唯一的客户端源码 |
| `artifacts/` | 交付产物 | 插件 bundle + `navisworks-mcp.mjs` + `SHA256SUMS.txt` |
| `scripts/` | PowerShell | 构建 / 打包 / 安装 / 校验 / 卸载 |

## Codex 那条链：源码已删，只剩二进制

Codex（以及 Claude Code）用的 `navisworks` MCP **不读本仓库**，它跑的是安装目录里的单文件 bundle：

```toml
# ~/.codex/config.toml
[mcp_servers.navisworks]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\Users\BOY\AppData\Local\NavisworksCodexMcp\mcp-server\navisworks-mcp.mjs']
```

2026-08-20 已删除 `mcp-server/`（TS 源）、`console/`（Web 控制台前端）、`navisworks-console/`
（C# REPL / stdio MCP）三个目录。后果：

- **运行时不受影响**：`%LOCALAPPDATA%` 下的 `.mjs` 和 Autodesk 目录下的插件 DLL 都还在，Codex 照常用。
- **`artifacts\mcp-server\navisworks-mcp.mjs` 是这个 bundle 的唯一仓库内副本**，`install.ps1` 靠它重装。
  别删，删了就再也装不回来。
- **改不动了**：给 Codex 那侧加/改工具 schema 需要 TS 源码，已不存在。要动就得重写 MCP 服务。
  桌面端不受此限——它直接连管道，不经过 `.mjs`。

## 红线

- **不执行任意代码**：不开放 C# / PowerShell / Navisworks 脚本执行，不新增此类工具。
- **不动模型文件**：不提供打开、保存、覆盖、删除能力。工具只读模型，最多改视图状态
  （选择 / 可见性 / 激活视点）。
- 命名管道 ACL 只授权当前 Windows 用户 —— 不要放宽。
- 单协议帧上限 1 MiB；`navisworks_find_items` 必须保留时间、数量、扫描三重上限。
- Autodesk 程序集只作编译引用，**不进交付包**（`artifacts/`）。
- 不提供联网搜索。

## 改动前必读：加/改/删一个工具 = 要同步 3 处源码

工具名在下列文件里各写了一遍，漏一处就出现「桌面端看不见这个工具」或「LLM 调了却被拦掉」：

| 文件 | 作用 |
|---|---|
| `navisworks-plugin/src/NavisworksCodexMcp.Plugin/NavisworksToolService.cs` | 唯一实现 |
| `navisworks-desktop/.../ViewModels/MainViewModel.cs` | `AllowedAgentTools` 白名单 |
| `navisworks-desktop/.../Services/LlmService.cs` | 给 Ollama 的工具定义 |

外加 `README.md` 的工具清单。**注意**：改了插件侧工具，Codex 用的 `.mjs` 不会跟着变（源码已删），
两边会漂移。

当前 9 个：`navisworks_status`、`navisworks_get_document`、`navisworks_get_selection`、
`navisworks_find_items`、`navisworks_get_item_properties`、`navisworks_select_items`、
`navisworks_set_visibility`、`navisworks_list_viewpoints`、`navisworks_activate_viewpoint`。

## Bridge 源码归属（历史耦合已解除）

`navisworks-desktop/NavisworksMcp.Desktop/Bridge/{BridgeTypes,EndpointReader,BridgeClient}.cs`
原先是从 `navisworks-console` 跨目录 `<Compile Include>` 链入的，随该项目删除已**物理复制进桌面端**，
现由 SDK 默认 glob 自动包含，csproj 里不再有显式 Compile 项。

命名空间**仍是 `NavisworksMcp.Console.Bridge`**（保持不变以免改动 `MainViewModel.cs`）。名字里的
`Console` 已无对应项目，属遗留命名；要改需同时动 4 个文件，先问再动。

## 桌面端窗口壳约束

- 桌面窗口虽然使用 `WindowStyle="None"`，但不是普通无边框窗口：`WindowChrome` 保留拖动、
  双击最大化与缩放边界，自绘标题栏按钮统一通过 `SystemCommands` 执行系统命令。
- 标题栏的非交互区域必须继续作为拖动区；按钮必须保留
  `WindowChrome.IsHitTestVisibleInChrome="True"`，否则会重新出现按钮无法点击的问题。
- `MainWindow.xaml.cs` 通过 DWM 属性同步深色模式，并在 Windows 11 请求系统圆角与边框；
  右键标题栏应打开标准窗口菜单。左上角只保留侧栏开关，不再显示应用图标或标题文字。
- 改标题栏、主题或弹出菜单后，除 `dotnet build` 外还要真实验证亮/暗主题、最小化、
  最大化/还原、关闭、系统菜单，以及模型/推理菜单；桌面端目前没有自动化 UI 测试。
- 桌面端会话验收不能只看 Codex/自动化工具直接启动的进程，也不能只读沙箱内的
  `%LOCALAPPDATA%`。受限环境可能看到虚拟化文件视图；必须从资源管理器正常启动成品，并在
  沙箱外核验真实 `%LOCALAPPDATA%\NavisworksMcpDesktop\` 后，才能判断用户会话是否已恢复。

## 命令速查

```powershell
# 插件全量构建（默认引用 F:\Navisworks\Navisworks Manage 2023）
# mcp-server 源码不存在时该步骤自动跳过，复用 artifacts\mcp-server\navisworks-mcp.mjs
.\scripts\build.ps1
.\scripts\build.ps1 -NavisworksPath '<NavisworksInstallDir>'

.\scripts\package.ps1      # 打 bundle 进 artifacts\
.\scripts\install.ps1      # 装插件 + mcp-server + 注册 Codex（先关 Navisworks）
.\scripts\verify.ps1       # 校验 artifacts\
.\scripts\uninstall.ps1
```

```powershell
# 桌面端不在 scripts\build.ps1 里，只能单独 dotnet 构建
dotnet build navisworks-desktop\NavisworksMcp.Desktop
```

构建被 `Permission denied` 挡住时，多半是 VS Code 的 Roslyn 语言服务器
（`Microsoft.CodeAnalysis.LanguageServer.exe`）或 C# Dev Kit BuildHost 持有 `obj\` 句柄。
先 `dotnet build-server shutdown`，必要时结束该进程，VS Code 会自动重启它。

## 运行时路径与前置条件

| 项 | 值 |
|---|---|
| 插件端点发现 | `%LOCALAPPDATA%\NavisworksCodexMcp\endpoint.json` |
| 插件安装位置 | `%APPDATA%\Autodesk\ApplicationPlugins\NavisworksCodexMcp.bundle` |
| mcp-server 安装位置 | `%LOCALAPPDATA%\NavisworksCodexMcp\mcp-server` |
| 桌面端会话与设置 | `%LOCALAPPDATA%\NavisworksMcpDesktop\{sessions.json,sessions.backup.json,settings.json}` |
| 桌面端 LLM | 本地 Ollama `http://localhost:11434`，默认模型 `qwen3.5:9b-q4_K_M` |
| 桌面端上下文窗口 | 固定 16384 tokens（`FixedContextWindowTokens`） |

任何客户端都要先拿到 `navisworks_status` 的 `connected: true` 再调其他工具。对象 ID 只在当前
文档 + 当前插件会话内有效，换文档或重启后必须重新查询。

## 深入文档

| 文档 | 内容 |
|---|---|
| `README.md` | 支持范围、安装、验证、安全边界 |
| `docs/architecture.md` | 数据流、构建方式 |
| `docs/protocol.md` | 命名管道帧格式、请求/响应/错误 JSON（未受删除影响） |

## 已知技术债（不要「顺手重构」，先问）

- 超过 800 行的文件：`MainViewModel.cs`、`MainWindow.xaml`、`NavisworksToolService.cs`。
- `navisworks-desktop` **零测试**；仓库内只有 `navisworks-plugin/tests` 有覆盖
  （`mcp-server/test` 随源码一并删除）。
- 仓库**没有 git**（只有 `.gitignore`）。没有历史层，所以文档就是唯一的交接介质，改了要同步。
- `navisworks-desktop\NavisworksMcp.Desktop\Views\` 是空目录，UI 全在 `MainWindow.xaml` 里。
- `.nuget\packages` 与 `.npm-cache` 已删；下次 `build.ps1` 会重新下载 NuGet 包（约 130 MB）。
