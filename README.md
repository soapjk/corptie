<p align="center">
  <img src="apps/macos/Sources/CopetsMac/Resources/AppIcon.png" alt="Corptie 应用图标" width="150">
</p>

<h1 align="center">Corptie</h1>

<p align="center">
  <strong>一个为异步 AI Agent 工作流设计的桌面悬浮终端。</strong>
</p>

<p align="center">
  <a href="README.en.md">English</a>
  ·
  <a href="README.zh-CN.md">简体中文</a>
  ·
  <a href="https://youtu.be/OqqVC_ITiYc">视频演示</a>
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS-111827?style=flat-square&logo=apple">
  <img alt="Agent" src="https://img.shields.io/badge/agents-Codex%20%7C%20Claude%20Code-2563eb?style=flat-square">
  <img alt="Backend" src="https://img.shields.io/badge/backend-Node.js-16a34a?style=flat-square&logo=node.js&logoColor=white">
  <img alt="Frontend" src="https://img.shields.io/badge/frontend-SwiftUI-f97316?style=flat-square&logo=swift&logoColor=white">
  <a href="LICENSE">
    <img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-64748b?style=flat-square">
  </a>
</p>

---

## 一句话

Corptie 提倡更少占用注意力的 Agent 交互方式，让所有 Agent 成为整个PC使用流程中的辅助工具。。它通过尽量简洁的悬浮窗和悬浮球，让用户与 Agent 的交互聚焦在对话本身，最大程度减少界面侵占，让用户在部署 Agent 任务的过程中，更少打断自己的其他工作流。同时内置支持不同Agent之间的消息传递和任务协作。

## ✨ 项目亮点

| 能力 | 价值 |
| --- | --- |
| 🧭 **多 Agent 桌面驾驶舱** | 同时运行和监督 Codex、Claude Code 等多个任务，只在需要输入、审批或处理异常时打断你 |
| 📱 **飞书远程 Agent 网关** | 将可信飞书用户与本机会话安全配对，可在飞书中创建或接管会话、收发消息、中断任务并处理审批 |
| 🤝 **Agent 间结构化协作** | 基于稳定身份、服务归属、验收条件和交付物让独立 Agent 协作，内置用户确认、可持久投递、验证/修订和升级流程 |
| 🔎 **单轮代码改动审阅与撤销** | 按 Codex 回复查看文件改动，可在外部 Diff 工具中审阅，并以冲突安全的方式只撤销该轮补丁 |
| 🧠 **LLM 增强交互** | 用本地 Agent 或 OpenAI 兼容接口将终端中的文本选项转换为可直接点击的结构化操作 |
| 🛡️ **本地优先与环境隔离** | Agent、会话、队列和 SQLite 数据默认留在本机；正式版与开发版可并行运行且数据完全分离 |

## 🎯 主要能力

- 新建会话时选择 Agent、模型、推理强度、sandbox 和 approval 策略。
- 统一展示 `running`、`needs input`、`approval required`、`complete` 和 `failed` 等真实状态，支持回复、审批、中断、恢复和安全终止。
- 会话可拆成独立浮球，直接阅读最新回复和提交快捷输入；每个会话可单独设置完成提示音。
- Codex 默认使用 App Server 协议，同时保留 PTY Legacy 适配；Claude Code 通过 Agent SDK 接入。

## 🖥️ UI 展示

### 悬浮球视频展示

<p align="center">
  <a href="https://youtu.be/OqqVC_ITiYc">
    <img src="https://img.youtube.com/vi/OqqVC_ITiYc/maxresdefault.jpg" alt="Corptie YouTube 演示视频" width="100%">
  </a>
</p>

> GitHub README 不能直接内嵌播放 YouTube 视频，点击封面即可打开演示。

### 主悬浮面板

<p align="center">
  <img src="resources/imgs/screenshot-20260702-110500.png" alt="Corptie 主悬浮面板，展示多个 Agent 会话状态和快捷回复入口" width="100%">
</p>

<details>
  <summary><strong>展开查看更多界面截图</strong></summary>

### 分离悬浮球（模型执行中状态）

<p align="center">
  <img src="resources/imgs/screenshot-20260702-110255.png" alt="Corptie 分离悬浮球，显示 Agent 头像、运行状态和桌面常驻入口" width="520">
</p>

### 快捷选项交互

<p align="center">
  <img src="resources/imgs/screenshot-20260702-110149.png" alt="Corptie 将 Agent 的文本选项整理为可点击的快捷回复按钮" width="720">
</p>

</details>

## 🧩 架构

```text
apps/macos
  SwiftUI + AppKit 原生桌面前端
  悬浮面板、分离浮球、设置页、聊天/详情视图

apps/backend
  Node.js 本地运行层
  HTTP API、SSE 详情流、Agent 适配器、统一工作队列、SQLite 存储

apps/backend/src/collaboration
  Agent/服务注册、协作任务状态机、可持久投递与验收流程

apps/backend/src/feishu
  飞书机器人、用户配对、会话绑定、互动卡片与审批同步

scripts
  开发启动、生产后端辅助脚本、macOS 打包
```

Codex 会话默认通过 App Server 的结构化事件驱动，并保留 PTY 兼容模式；两种模式都支持会话恢复、中断、模型切换和 approval。Agent 输入统一进入可持久工作队列，避免用户、飞书和 Agent 协作消息在会话忙碌时丢失。

## 📱 飞书网关

飞书集成是可选能力，需要本机已安装 `lark-cli`，并在飞书开放平台中准备好已发布的企业应用和机器人能力。

1. 在 Corptie 设置的 **Feishu Gateway** 中，使用 App ID/App Secret 或现有 `lark-cli` Profile 添加机器人。
2. 添加可从飞书创建会话的可信工作区，启用机器人并生成 6 位配对码。
3. 用飞书账号向机器人发送配对码；配对后即可通过卡片选择工作区和 Agent，创建或接管会话。

App Secret 会交给 `lark-cli` 的加密存储，不保存在 Corptie 数据库中。卡片操作会校验已配对的用户和会话，未授权操作不会转发给 Agent。

## 🤝 Agent 协作

Corptie 为每个受管 Codex 会话分配稳定 Agent 身份，并提供本地 MCP 协作工具。Agent 可发现其他 Agent 与服务，用明确的任务、验收条件和交付物进行点对点协作。

新协作请求会先向用户展示确认卡片；确认后才会投递。协作窗口可查看收件箱、待验证、已升级任务、Agent/服务注册信息与完整时间线，并支持取消任务和重试失败投递。

## 🚦 环境隔离

| 环境 | 后端 | 数据目录 |
| --- | ---: | --- |
| 正式版 | `127.0.0.1:47321` | `~/Library/Application Support/Corptie/` |
| 开发版 | `127.0.0.1:47322` | `~/Library/Application Support/Corptie Development/` |

两个环境不共享后端配置、SQLite 数据、前端 `UserDefaults`、透明度设置和窗口尺寸记忆。

Corptie 管理的 Codex 也使用独立运行时目录：正式版位于 `~/.corptie/runtimes/codex/`，开发版位于 `~/.corptie/development/runtimes/codex/`。它们不会修改原生 Codex 的 `~/.codex/`。首次初始化会在本机一次性复制现有认证和 Corptie 已管理的线程状态；之后各环境独立演进。每次后端启动都会校验并修复 Corptie 内置 Skill，同时为每个新建或恢复的 Agent 动态配置协作 MCP。

## 🛠️ 开发

需要 macOS 14+、Node.js 22.13+、Swift 6，以及已安装并登录的 Codex CLI 或 Claude Code。首次运行先安装后端依赖：

```sh
npm install --prefix apps/backend
```

```sh
scripts/run-development.sh
```

常用检查：

```sh
curl "http://127.0.0.1:47322/health"
swift build --package-path apps/macos
node --check apps/backend/src/server.mjs
```

创建一个 Codex PTY 会话：

```sh
curl -X POST "http://127.0.0.1:47322/codex/pty-sessions" \
  -H "content-type: application/json" \
  --data '{"title":"Codex smoke test","prompt":"Summarize this repo without editing files.","cwd":"/path/to/corptie"}'
```

如果 `prompt` 为空，Corptie 会自动发送一条很短的初始化提示，让 Codex 回复 `Ready`，这样新会话会立即完成绑定并可用。

## 📦 打包

构建生产安装包：

```sh
scripts/package-macos-installer.sh
```

从当前工作区构建正式版、确认没有未完成会话、安全停止旧版、安装并打开新版：

```sh
scripts/rebuild-install-restart-production.sh
```

只检查正式版当前是否可以安全停止：

```sh
scripts/rebuild-install-restart-production.sh --check-only
```

产物会写入 `dist/`，包含带时间戳的 `.pkg` 和 `.dmg`。`.dmg` 内含 `Corptie.app`、`Applications` 快捷入口和简短安装说明。

## License

[Apache-2.0](LICENSE)
