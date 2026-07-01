# Copets 项目目标形态与技术方案调研

更新日期：2026-06-30

当前阶段决策：首版优先 macOS，UI 效果优先。前端使用 SwiftUI + AppKit 原生实现悬浮窗和系统级视觉效果；后端使用 Node.js 实现 Agent runtime、本地任务调度和事件流。后端需要保持前后端分离边界，未来可以迁移到 Go 或其他 shared core。

## 1. 项目想做什么

Copets 想做的是一个面向多 Agent、异步并行工作的桌面客户端。它解决的不是“如何和单个 Agent 聊天”，而是“当用户同时启动很多个长期任务时，如何在不打断当前工作/学习/娱乐的情况下，持续感知所有任务状态，并在需要介入时快速接管”。

典型场景：

- 用户让 Codex、Claude Code 或其他 Agent 同时处理多个开发任务、调研任务、长期聊天/知识库任务。
- 用户启动任务后去做别的事情，例如看视频、学习、写文档、开会。
- Agent 任务可能持续几分钟到几十分钟，中间会有状态变化、阻塞、需要确认、完成、失败等事件。
- 当前“完成后弹通知，用户再点回去”的方式不适合高并发异步任务，因为用户缺少一个持续、低打扰、可扫视的全局进度面板。

目标形态：

- 一个始终置顶的桌面悬浮窗，优先支持 macOS，后续兼容 Windows。
- 悬浮窗可以任意拖动，不局限于 macOS 灵动岛/菜单栏/固定屏幕区域。
- 悬浮窗无需点击展开也能直接展示多个任务的状态、进度、最近输出、阻塞原因和下一步操作。
- 用户可以对每个任务做轻量操作，例如暂停、继续、取消、查看详情、发送简短确认、切换优先级。
- 支持多个不同 Agent 配置：开发 Agent、代码审查 Agent、调研 Agent、长期知识库聊天 Agent、带特定人设或工作习惯的助手等。
- UI 需要足够漂亮，具备高级质感，并支持皮肤/主题自定义。
- 产品体验应偏“异步任务中控台 + 桌面宠物式陪伴感”，但不是单纯装饰；核心价值是让用户无点击地感知并管理并行 Agent 工作。

## 2. 核心产品模块

### 2.1 悬浮任务面板

- Always-on-top：始终在其他应用之上显示。
- Frameless / transparent：无系统标题栏、透明或半透明背景。
- Draggable：可拖动并记住位置，支持多显示器。
- Compact / expanded：默认展示紧凑但信息密度高的任务列表；点击任务可打开详情。
- Non-intrusive：可以设置透明度、尺寸、自动折叠、鼠标穿透或边缘吸附。
- Actionable：阻塞任务直接显示需要用户操作的按钮。

### 2.2 Agent 任务运行层

- 把每个 Agent 任务抽象为 `TaskSession`：状态、日志、进度、最后活动时间、工作目录、权限、模型/供应商、输入输出。
- 同时支持 CLI 型 Agent 和 SDK 型 Agent。
- CLI 型：通过 PTY 或非交互命令运行 Codex、Claude Code 等。
- SDK 型：通过 Agent SDK 直接拿到结构化事件流。
- 所有任务事件写入本地数据库，保证应用重启后仍可恢复状态。

### 2.3 多 Agent 配置

- Agent Profile：名称、头像/图标、供应商、模型、工具权限、系统提示词、工作目录、知识库/MCP 配置。
- Task Template：常见任务模板，例如“修 bug”、“跑测试并修复”、“读仓库并总结风险”、“长期陪伴式学习助手”。
- Permission Profile：开发任务和长期聊天任务的权限必须分开，避免长期 Agent 获得不必要的文件/命令权限。

### 2.4 主题与皮肤

- 主题变量：颜色、材质、圆角、阴影、字体、密度、动效速度。
- 皮肤包：可选主题 JSON + 图片/动效资源。
- macOS 可利用 vibrancy/blur 材质营造系统融合感；Windows 可考虑 Mica/Acrylic 风格，但实现细节要分平台处理。

## 3. 当前推荐架构

首版推荐使用 macOS 原生前端 + Node.js 本地后端。

选择理由：

- 首版的关键竞争力是 macOS 悬浮窗的高级质感，而不是跨平台速度。SwiftUI/AppKit 能更直接地使用 macOS 原生窗口、材质、动画和系统行为。
- 悬浮窗需要深度使用 `NSPanel`、`NSWindow.Level`、`collectionBehavior`、`NSVisualEffectView`、Space/全屏窗口行为、点击穿透、多显示器定位等能力。这些能力用原生 App 更可控。
- Apple 最新系统视觉语言，例如 Liquid Glass / native material，更适合通过 SwiftUI/AppKit 直接采用，而不是在 WebView/Electron 中模拟。
- 后端使用 Node.js 能快速接入 Codex、Claude Code、`node-pty`、MCP、Claude Agent SDK 等 Agent 工具链。
- 通过本地 RPC/WebSocket 边界把 UI 和后端分离，后续可以把 Node.js 后端迁移到 Go，而不重写 macOS UI。

建议分层：

```text
macOS Native UI
  - SwiftUI task cards and controls
  - AppKit floating panel / NSPanel
  - native material / Liquid Glass / vibrancy
  - menu bar, notifications, global shortcuts
  - skin/theme rendering

Local Backend (Node.js)
  - task scheduler
  - Codex exec adapter
  - Claude Code / Claude Agent SDK adapter
  - generic PTY runner
  - MCP integration
  - permission profiles
  - event normalizer
  - SQLite persistence

Communication Boundary
  - JSON-RPC or local HTTP for commands
  - WebSocket or local event stream for task events
  - versioned DTO schema
```

### 3.1 macOS 前端职责

- 始终置顶悬浮窗：使用 AppKit 封装 `NSPanel` 或定制 `NSWindow`。
- 系统级视觉效果：优先使用 SwiftUI/AppKit 原生材质，而不是 CSS 模拟。
- 任务列表和任务卡片：展示多个 Agent 的状态、最近输出、阻塞原因和轻量操作。
- 用户操作：暂停、继续、取消、发送确认、打开详情、调整优先级。
- 设置和主题：编辑 Agent Profile、主题参数、窗口行为、通知策略。
- 后端连接状态：展示 runtime 是否在线、任务是否恢复、是否需要重启后端。

macOS 前端不应该承担：

- Agent CLI 生命周期管理。
- 日志解析和任务状态机。
- 数据库读写细节。
- MCP/SDK 适配。
- 权限策略判定。

这些都属于后端 runtime。

### 3.2 Node.js 后端职责

- 启动、停止、暂停和恢复 Agent 任务。
- 运行 `codex exec`、Claude Code CLI、通用 shell/PTY 任务。
- 将 stdout/stderr、SDK 事件、工具调用、退出码统一转换为 `TaskEvent`。
- 管理 `TaskSession`、`AgentProfile`、`TaskTemplate`、权限配置。
- 写入 SQLite，保证任务事件、日志、配置可恢复。
- 向 macOS 前端推送实时事件流。
- 对外暴露稳定协议，避免 UI 绑定 Node.js 内部实现。

### 3.3 Agent 编排路线

首版 Copets 应优先做“本机 Agent 工具编排层”，而不是从零自研完整 Agent。

也就是说，Copets 首先直接使用用户本机已经安装和登录好的 Agent 工具：

- Codex CLI / `codex exec`
- Claude Code CLI
- 其他可通过 CLI、PTY、SDK 或 MCP 运行的本地 Agent

选择理由：

- 现有 Agent 工具已经处理了大量复杂能力：代码理解、文件编辑、命令执行、权限交互、上下文管理、模型选择、登录认证、工具调用策略。
- Copets 的首要创新点不是“再造一个 coding agent”，而是“让多个 Agent 异步并行、可视化、可恢复、可管理”。
- 直接复用本机 Agent 可以最快验证产品形态，也符合开发者已有工作流。
- 用户本机的 Codex/Claude Code 已经拥有各自账号、配置和权限边界，Copets 不需要一开始承担模型 API key、计费、工具安全沙箱等完整责任。

但后端协议必须抽象出统一的 `AgentAdapter`，避免长期绑定某一个 CLI：

```text
AgentAdapter
  - id
  - displayName
  - capabilities
  - startTask(input)
  - sendInput(taskId, input)
  - cancelTask(taskId)
  - streamEvents(taskId)
  - resolveStatus(taskId)
```

Codex 接入需要区分两种层级：

- `codex exec`：非交互自动化入口。适合 Copets 自己启动一个新任务、读取 JSONL 事件/最终输出、把进程退出映射为完成/失败。它不是用来追踪任意一个已经在 Codex TUI/App 中运行的任务的完整控制协议。
- `codex app-server`：Codex App/IDE 级别的协议入口。它支持 `thread/start`、`thread/list`、`thread/read`、`turn/start`、`turn/steer`、`turn/interrupt` 等会话/turn 操作，并包含线程状态、turn 状态、计划更新、diff 更新、命令输出、文件变更、审批请求、用户输入请求等通知/请求类型。它更接近 Copets 需要的“追踪正在运行的 Codex 任务并做简单交互”。

因此 Codex 的路线不应该只做 `CodexExecAdapter`。更准确的拆分是：

```text
CodexExecAdapter
  - lowest-friction automation
  - run new non-interactive tasks
  - parse --json JSONL events
  - good for MVP smoke tests and batch jobs

CodexAppServerAdapter
  - preferred long-term integration
  - connect to Codex app-server by stdio/unix socket/ws
  - list/read/resume/start Codex threads
  - map Codex thread/turn notifications to Copets TaskEvent
  - support steer/interrupt/approval/user-input interactions
```

当前实现结论：

- Copets 已经可以通过 `thread/start` + `turn/start` 创建由 Copets 管理的新 Codex thread，并把后续用户输入发送到这个 thread。
- Codex Desktop/IDE 已有历史 thread 可以通过 `thread/list` 发现；当 `thread/read` 失败时，Copets 会从本地 rollout JSONL fallback 读取历史消息。
- 这类历史 thread 暂时标记为只读，因为直接 `thread/resume` 或 `codex exec resume` 会遇到 Codex thread-store 错误，无法保证消息真的写入 Codex Desktop 当前会话。
- app-server 的 live notifications 已经接入后端调试/详情路径；即使 `thread/read` 暂时不可用，Copets 管理的新任务也可以显示 user item、reconnect/error、turn 状态等实时信息。
- Copets 现在增加了 `PtyAgentManager`，可以用 `node-pty` 启动不可见 CLI 会话，把任意交互式 Agent CLI 映射为 Copets task/detail/input。PTY 是首版兼容 Claude Code、Codex CLI、OpenClacky、Aider、Goose 等工具的通用兜底层。
- Codex 当前首选路径改为 `Codex CLI over PTY`：后端通过 `/codex/pty-sessions` 启动 `codex --no-alt-screen -C <workspace> -s workspace-write -a on-request <prompt>`，后续输入走 PTY input，中断走 ESC。这条路线不接管 Codex Desktop，但能在 Copets 悬浮窗中直接启动和操作 Codex CLI。
- PTY 路线不依赖 Codex Desktop 私有协议；风险主要转移为 CLI 输出解析、审批提示识别、进程恢复和安全拦截。后续应优先吃稳定 JSON/API，PTY 作为兼容层保留。

首版适配器优先级：

1. `PtyAgentAdapter`：首版通用兼容层，用不可见伪终端托管任意交互式 CLI Agent。
2. `CodexExecAdapter`：脚本化任务入口，适合开发任务、修复任务、代码审查任务。
3. `CodexAppServerAdapter`：追踪/控制 Codex thread 和 turn，承接正在运行任务、简单交互和审批，但按 experimental adapter 管理。
4. `OpenHands/Goose/OpenClacky API Adapter`：当开源 Agent runtime 提供稳定 HTTP/SDK 时优先接 API。
5. `ShellAdapter`：用于模拟长任务、测试调度、跑本地脚本。
6. `CustomApiAgentAdapter`：后续再做，允许 Copets 自己通过模型 API + 工具系统实现 Agent。

长期形态可以是混合模式：

- Bring-your-own-agent：复用本机 Codex、Claude Code、其他 CLI Agent。
- Copets-native-agent：Copets 自己通过模型 API、MCP、工具权限和上下文系统实现的内置 Agent。
- Remote/Team agent：未来接入远程执行环境或团队共享任务队列。

因此当前原则是：

- 首版不自研完整 coding agent。
- 首版重点做任务编排、状态归一、事件流、悬浮可视化和用户介入体验。
- 架构上保留自研 Agent 的位置，但把它作为后续 adapter，而不是 MVP 的前置条件。

### 3.4 可迁移到 Go 的边界要求

Node.js 后端从第一天开始就按“可替换本地服务”设计：

- 前端只通过 RPC/event stream 调用后端，不直接调用 Node 模块。
- DTO 使用 JSON schema 或 TypeScript 类型生成，保留版本号。
- 后端内部模块不要泄漏到 Swift 代码中。
- 持久化 schema 独立于运行时语言。
- 所有核心任务状态通过事件流表达，而不是靠 UI 推断。

未来迁移到 Go 时，目标是保持以下协议不变：

```text
createTask(input) -> TaskSession
cancelTask(taskId) -> CommandResult
pauseTask(taskId) -> CommandResult
resumeTask(taskId) -> CommandResult
sendInput(taskId, input) -> CommandResult
listSessions(filter) -> TaskSession[]
getSession(taskId) -> TaskSessionDetail
subscribeEvents(cursor) -> TaskEvent stream
updateAgentProfile(profile) -> AgentProfile
```

### 3.5 风险与应对

- SwiftUI 复杂自定义 UI 迭代速度低于 Web：首版组件要少而精，优先悬浮任务卡片和详情面板。
- Swift/Node 跨进程通信需要调试：使用简单、可观测的本地协议，所有请求/事件写日志。
- Node 后端作为长期进程需要生命周期管理：macOS App 负责启动、健康检查、重启和退出策略。
- Apple 新系统材质可能有系统版本差异：保留 fallback 主题，避免只在最新 macOS 上可用。
- Windows 首版暂缓：当前协议边界仍要保持跨平台，以免未来 Windows shell 需要重写后端。
- 直接编排本机 Agent 会遇到输出格式不稳定、CLI 行为变化、交互式权限提示等问题：通过 adapter 层隔离，并优先使用结构化/非交互模式。
- 自研 Agent 能力会带来模型 API、工具沙箱、上下文压缩和安全策略成本：放在后续阶段，不阻塞首版产品验证。

## 4. 技术方案候选与取舍记录

### 方案 A：Electron + React/Vue/Svelte

优点：

- 最适合做复杂、漂亮、可主题化的 UI。
- Chromium 渲染一致性强，macOS/Windows 的 CSS、动画、Canvas/WebGL 表现更稳定。
- Electron `BrowserWindow` 支持窗口定制，适合 frameless、transparent、always-on-top、skip taskbar 等悬浮窗需求。
- 生态成熟，和 `node-pty`、xterm.js、Node 后台进程管理天然适配。

缺点：

- 包体和内存占用较高。
- macOS 原生窗口细节、Windows 透明窗口边缘/阴影/点击穿透等仍需要平台专项调试。
- 如果要做到非常原生的 macOS panel 行为，需要桥接原生模块或写 native addon。

适合度：适合快速验证跨平台 Web UI，但不作为当前首版首选。原因是 macOS 悬浮窗和 Apple 原生材质已经被提升为首版核心体验。

### 方案 B：Tauri v2 + Web 前端 + Rust 后台

优点：

- 包体小、性能好、安全模型更细。
- Tauri v2 支持窗口自定义、透明窗口、always-on-top、visible-on-all-workspaces 等能力。
- Rust 后台适合做任务调度、本地数据库、进程生命周期管理。

缺点：

- WebView 使用系统渲染器：macOS 是 WebKit，Windows 是 WebView2。同一套 UI 在两端可能出现 CSS/透明/滤镜/字体渲染差异。
- 漂亮复杂 UI 和透明悬浮窗的跨平台调试成本通常高于 Electron。
- Node 生态集成没有 Electron 顺手，跑 PTY/agent CLI 时需要 Rust crate 或 sidecar。

适合度：中高。适合重视轻量和安全，但 UI 极致一致性风险更高。

### 方案 C：macOS 原生 SwiftUI/AppKit + Windows 另写 WinUI

优点：

- macOS 悬浮窗体验最好，可用 `NSPanel`、`NSWindow.Level`、`collectionBehavior` 做出接近系统级的 panel。
- 原生材质、动画、可访问性、多桌面行为更自然。
- Windows 端可用 WinUI 3 + WebView2 或纯 WinUI 实现 Mica/Acrylic。

缺点：

- 基本等于维护两个前端客户端。
- 皮肤系统、组件库、交互一致性成本高。
- 多 Agent 后台逻辑需要抽成共享 core，否则重复实现严重。

适合度：当前首版首选，但范围收敛为 macOS 原生 UI + 共享/可迁移后端，不在首版同时开发 Windows。

### 方案 D：Wails + Web 前端 + Go 后台

优点：

- Go 后台简单、部署友好。
- 支持 frameless、透明背景、always-on-top 等桌面窗口选项。
- 适合做进程管理和本地服务。

缺点：

- 相比 Electron/Tauri，复杂桌面 UI 和窗口边界案例的生态较小。
- WebView 差异仍存在。

适合度：可作为备选，但不是当前首选。

## 5. UI 跨平台兼容是否麻烦

结论：如果坚持“漂亮、半透明、异形、动效、始终置顶、可拖动、可皮肤化”，跨系统兼容一定会麻烦，但可以通过架构选择降低难度。

麻烦主要来自：

- 窗口层级：macOS 和 Windows 对 always-on-top、多桌面、全屏应用、Mission Control/虚拟桌面的处理不同。
- 透明窗口：透明背景、阴影、圆角、模糊、点击穿透在不同系统和 GPU 设置下表现不同。
- 系统材质：macOS vibrancy 和 Windows Mica/Acrylic 不是同一个东西，不能指望一套 CSS 完全模拟。
- 字体渲染：Chromium 一致性较好，但系统字体、emoji、亚像素渲染仍会不同。
- 拖动区域：frameless 窗口通常需要显式声明 draggable/no-drag 区域，复杂交互控件要仔细避让。

当前决策下的降低风险策略：

- 首版只做 macOS，不在早期同时追求 Windows 视觉一致。
- UI 允许未来平台差异，但后台协议、任务状态机、事件模型必须一致。
- macOS UI 使用原生 SwiftUI/AppKit；未来 Windows UI 可以使用 WinUI 3 或其他原生方案接入同一后端协议。
- 主题系统拆成语义 token，而不是绑定具体平台材质。例如 `surfaceFloating`, `surfaceCritical`, `textMuted`, `agentRunningAccent`。
- 建立 macOS 截图回归测试：浅色/深色、不同透明度、多个任务状态、多显示器、全屏应用上方行为。

## 6. Agent 接入建议

Codex：

- 使用 `codex exec` 跑脚本化/自动化任务，捕获 stderr 进度和 stdout 最终结果。
- 对需要持续交互的任务，可使用 PTY 方式运行 Codex TUI，但事件结构化会更难。
- 优先设计一个 Codex adapter，将 CLI 输出归一成 `TaskEvent`。

Claude：

- 优先调研 Claude Agent SDK，因为它可以程序化创建 Agent，并拿到更结构化的事件流。
- Claude Code CLI 也可以作为 PTY agent 接入。

通用 CLI Agent：

- 使用 `node-pty` 启动 shell/CLI，捕获输出、发送输入、调整终端尺寸。
- 每个任务必须有独立工作目录、权限说明、环境变量和取消机制。

MCP：

- MCP 可以作为工具/知识库接入层，而不是直接作为任务调度层。
- 长期聊天 Agent、知识库 Agent、项目开发 Agent 都可以通过 MCP 连接外部数据源和工具。

## 7. MVP 范围建议

第一阶段：

- macOS SwiftUI + AppKit 项目骨架。
- 一个使用 `NSPanel` 或定制 `NSWindow` 的 always-on-top、可拖动、可调整透明度的 macOS 悬浮窗。
- 原生材质/玻璃效果 spike：验证 Liquid Glass/native material/vibrancy 在悬浮窗中的可用性和 fallback。
- 本地 mock 任务列表：运行中、阻塞、完成、失败。
- 主题系统 v0：内置 3 套主题 + 语义 token。
- 任务详情抽屉/弹窗。

第二阶段：

- Node.js 本地后端服务骨架。
- 前后端通信：JSON-RPC/local HTTP + WebSocket/event stream。
- 接入真实 CLI runner：先用普通 shell 命令模拟长任务，再接 Codex `exec`。
- SQLite 持久化任务事件。
- macOS 通知和菜单栏入口。
- 基础 Agent Profile。

第三阶段：

- Claude Agent SDK adapter。
- 多任务并行调度、取消、暂停、恢复。
- 后端协议版本化，为未来 Go 迁移和 Windows shell 做准备。
- 皮肤包导入导出。

## 8. 参考资料

- Electron BrowserWindow：窗口定制能力，`BrowserWindow` 是 frameless/transparent/always-on-top 的主要入口。https://www.electronjs.org/docs/latest/api/browser-window
- Tauri Window Customization：Tauri v2 支持自定义标题栏、透明窗口等窗口能力。https://v2.tauri.app/learn/window-customization/
- Tauri WebviewWindowBuilder：包含 `always_on_top`、`visible_on_all_workspaces`、`skip_taskbar`、`effects` 等桌面窗口 API。https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html
- Wails Options：支持 `Frameless`、透明背景色、`AlwaysOnTop`。https://wails.io/docs/reference/options/
- Microsoft WebView2：Windows 原生应用嵌入 Web 技术的官方方案。https://learn.microsoft.com/en-us/microsoft-edge/webview2/
- Codex CLI：Codex 可在本地终端读写代码、运行命令，支持 macOS/Windows/Linux。https://developers.openai.com/codex/cli
- Codex non-interactive mode：`codex exec` 适合脚本化运行并流式输出进度。https://developers.openai.com/codex/noninteractive
- Claude Agent SDK TypeScript：可程序化创建具备 Claude Code 能力的 Agent。https://github.com/anthropics/claude-agent-sdk-typescript
- node-pty：跨 macOS/Windows/Linux 的伪终端能力，可用于运行交互式 CLI Agent。https://github.com/microsoft/node-pty
- MCP Introduction：MCP 是 AI 应用连接外部工具和数据源的开放协议。https://modelcontextprotocol.io/docs/getting-started/intro
