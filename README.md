<p align="center">
  <img src="apps/macos/Sources/CopetsMac/Resources/AppIcon.png" alt="Corptie 应用图标" width="144">
</p>

<h1 align="center">Corptie</h1>

<p align="center">
  <strong>面向长时间、异步和多 Agent 工作流的本地优先 macOS 工作台。</strong>
</p>

<p align="center">
  <a href="README.en.md">English</a>
  ·
  <a href="https://youtu.be/OqqVC_ITiYc">视频演示</a>
</p>

Corptie 是一个帮助你同时组织、运行和监督多个 AI Agent 的桌面工作台。你可以随时发起一次对话，也可以把复杂目标拆成带验收标准的工作项，交给不同 Agent 在彼此隔离的工作区中完成。

任务运行期间，Corptie 会集中展示进展、待处理输入、审批和最终结果。你不需要来回盯着多个终端，只在真正需要判断或确认时介入。多个 Agent 也可以在你的确认下互相委派任务、交付结果并完成验收。

> 会话、任务、队列和配置默认保留在本机；Development 与 Production 数据相互隔离。

## 目录

- [Corptie 能做什么](#corptie-能做什么)
- [快速开始](#快速开始)
- [核心使用流程](#核心使用流程)
- [配置与数据](#配置与数据)
- [设计与项目结构](#设计与项目结构)
- [开发与验证](#开发与验证)
- [打包与本机安装](#打包与本机安装)
- [常见问题](#常见问题)

## Corptie 能做什么

| 你需要做的事 | Corptie 提供的帮助 |
| --- | --- |
| 同时推进多个 Agent 任务 | 在一个工作台中查看所有任务的真实状态，只处理需要输入、审批或异常恢复的会话。 |
| 把复杂目标拆解并落实 | 用 Objective 管理目标和参与者，用带验收标准的 WorkItem 跟踪具体交付。 |
| 避免不同任务互相覆盖 | 为工作项准备独立 Worktree，并在本地集成前展示可审查的计划与风险。 |
| 让不同 Agent 分工协作 | 通过带验收条件和交付物的协作任务完成委派、验证、修订和升级。 |
| 随时发起轻量对话 | 直接创建 Assistant 或 Independent Contributor Session，按需切换模型、权限和工作目录。 |
| 离开电脑后继续跟进 | 可选接入飞书，在可信账号中查看会话、回复消息、处理中断和审批。 |

<p align="center">
  <img src="resources/imgs/screenshot-20260702-110500.png" alt="Corptie 主窗口，展示多个 Agent 会话和状态" width="100%">
</p>

## 快速开始

### 前置条件

- macOS 14 或更高版本。
- Node.js 22.13 或更高版本；后端使用内置 `node:sqlite`。
- Swift 6 工具链（Xcode 16 或兼容的 Command Line Tools）。
- Git。
- 至少一个可用的 Agent Provider。首次体验建议安装并登录 Codex CLI。

先检查本机工具链：

```sh
node --version
swift --version
git --version
codex --version
```

内置 Provider 的运行要求：

| Provider | 当前接入方式 | 运行要求 |
| --- | --- | --- |
| **Codex**（默认） | 托管的 App Server | `codex` 可执行文件位于登录 shell、常见包管理器目录或 Codex.app 内，并已完成认证。 |
| **Claude Code** | `@anthropic-ai/claude-agent-sdk` | 本机存在可用 Claude Code 凭据；首次启动会将凭据一次性引导到 Corptie 隔离运行时。 |
| **OpenClacky** | 外部 REST + WebSocket 服务 | OpenClacky 服务已启动；默认地址为 `http://127.0.0.1:7070`。服务不可用时不会静默回退到其他 Provider。 |

### 安装依赖并启动 Development

在仓库根目录执行：

```sh
npm ci --prefix apps/backend
scripts/run-development.sh
```

`scripts/run-development.sh` 会：

1. 在 `127.0.0.1:47322` 启动 Development 后端；
2. 等待 `/health` 就绪；
3. 按需编译并以前台进程启动 Development macOS App；
4. 在该命令退出时清理由它启动的后端。

也可以使用等价入口：

```sh
make dev
```

### 验证基本运行

保持 Development App 运行，在另一个终端执行：

```sh
curl -fsS "http://127.0.0.1:47322/health"
curl -fsS "http://127.0.0.1:47322/providers"
curl -fsS "http://127.0.0.1:47322/sessions"
```

三个请求应分别返回健康状态、Provider catalog 和 Session 列表。Provider catalog 中的 `capabilities` 是 UI 判断可用操作的权威来源。

## 核心使用流程

### 最短可用流程：创建 Agent Session

1. 打开 **Agents**，点击 **新建 Agent**。
2. 选择 **Assistant**（直接对话）或 **Independent Contributor**（项目执行），填写名称和 System Prompt；需要时绑定 Skills。
3. 在 Agent 卡片中点击 **开始新会话**。
4. 选择可创建会话的 Provider、会话名称和工作目录后创建 Session。
5. 在 **Sessions** 中发送消息，按 Provider capability 使用模型切换、权限、审批、中断、恢复和改动审阅。

### 结构化流程：Objective 到 WorkItem

1. 在 **Console** 左侧点击 **New Objective**，填写目标与理想状态，并绑定 Workspace 和 Contributor Agent。
2. 进入该 Objective，点击 **新建工作项**；填写描述、验收标准和主 Workspace。Workspace 是可执行 WorkItem 的必填项。
3. 在 WorkItem 详情中选择 IC Agent 并开始执行。Corptie 会创建或复用逻辑 Session，并在需要隔离时为任务准备专用 Worktree。
4. 在 **Sessions** 跟进真实运行状态；需要输入或审批时处理对应卡片。
5. Agent 完成验证后提交逐条验收证据。只有可复现证据充分时，WorkItem 才应被判定通过。
6. 在 **Worktrees** 检查修改、提交和本地集成计划。该界面不会自动执行远程 push、删除、reset 或 force-clean。

### Agent 协作

受管 Session 可通过 Corptie Tool Host 发现其他 Agent 和服务，并发起带验收标准的点对点任务。新的协作请求先在发起者 Session 中显示确认卡片；用户确认后才投递。接收者可以交付 Artifact，发起者负责验证、请求修订或完成任务。

协议、状态流转、兼容迁移和开发使用说明见 [Agent 协作机制](docs/agent-collaboration.md)。

### 可选飞书网关

1. 安装 `lark-cli`，并在飞书开放平台准备已发布且启用机器人能力的企业应用。
2. 在设置页 **Feishu Gateway** 中使用 App ID/App Secret 或已有 `lark-cli` Profile 添加机器人。
3. 添加可信 Workspace，启用机器人并生成六位配对码。
4. 从需要授权的飞书账号向机器人发送配对码，再通过卡片创建或绑定 Session。

App Secret 交由 `lark-cli` 的加密存储处理，不写入 Corptie SQLite。卡片操作会验证配对用户、会话和权限。

## 配置与数据

优先通过 App 右上角齿轮打开设置页。这里可以配置数据与日志目录、默认 Session 参数、代码 Diff 工具、Agent 代理、结构化选项解析器和飞书网关。通常不需要手工编辑 `config.json`。

### 环境隔离

| 环境 | 后端地址 | 应用数据 | 日志 | Provider 运行时根目录 |
| --- | --- | --- | --- | --- |
| Production | `127.0.0.1:47321` | `~/Library/Application Support/Corptie/` | `~/Library/Logs/Corptie/` | `~/.corptie/runtimes/` |
| Development | `127.0.0.1:47322` | `~/Library/Application Support/Corptie Development/` | `~/Library/Logs/Corptie Development/` | `~/.corptie/development/runtimes/` |

默认数据库文件名为 `corptie.sqlite`。Development 和 Production 还使用不同的 `UserDefaults` suite，因此窗口、透明度和界面偏好不会互相污染。

Corptie 为 Codex、Claude Code 和 OpenClacky 创建独立运行时目录。首次初始化可从原生 Provider 目录一次性复制认证材料和 Corptie 已管理的会话记录；此后各环境独立演进，不会把运行状态写回 `~/.codex/`、`~/.claude/` 或原生 OpenClacky 配置。

### 常用环境变量

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `CORPTIE_ENV` | 选择 `development` 或 `production` 数据隔离域。 | `production`；仓库开发脚本会设置为 `development`。 |
| `CORPTIE_BACKEND_PORT` | 后端和 App 使用的本地端口。 | Development `47322`，Production `47321`。 |
| `CORPTIE_CODEX_PATH` | Codex 可执行文件的显式路径。 | 自动搜索登录 shell、常见工具目录和 Codex.app。 |
| `OPENCLACKY_BASE_URL` | OpenClacky 服务地址。 | `http://127.0.0.1:7070`。 |
| `OPENCLACKY_ACCESS_KEY` | OpenClacky 服务需要认证时使用的 access key。 | 未设置。 |
| `CORPTIE_LARK_CLI` | `lark-cli` 可执行文件的显式路径。 | 自动搜索本机 PATH 和常见工具目录。 |
| `CORPTIE_HOME` | Corptie 管理的 Provider 运行时、Skill cache 和 Agent 工作目录根目录。 | `~/.corptie`。 |
| `CORPTIE_CONFIG_PATH` | 高级场景下覆盖后端配置文件路径。 | 当前环境 Application Support 下的 `config.json`。 |
| `CORPTIE_DB_PATH` | 高级场景或测试中直接覆盖 SQLite 路径。 | 设置页数据目录下的 `corptie.sqlite`。 |

结构化选项解析器、表单辅助、Assistant 意图分析和记忆提取可使用设置页保存的 OpenAI-compatible 配置，也可读取 `OPENAI_API_KEY` 或 `CORPTIE_OPENAI_API_KEY`。这些增强能力是可选的，不是启动本地后端的前置条件。

## 设计与项目结构

Corptie 的设计围绕四个原则：任务状态必须真实可追踪；Agent 能力通过统一 Provider 合约接入；Session 在恢复、切换 Provider 或切换 Workspace 后仍保持稳定身份；高影响操作必须可审查、可确认，且不能覆盖未提交工作。

运行关系可以概括为：

```text
macOS App → 本地后端 → Provider（Codex / Claude Code / OpenClacky）
                      ↘ 本地数据、任务队列与 Git Worktree
```

代码主要分为以下几部分：

| 路径 | 主要职责 |
| --- | --- |
| `apps/macos/` | macOS 客户端、界面状态、后端 Client 与客户端测试。 |
| `apps/backend/src/agent-provider/` | Provider 合约、能力声明、会话生命周期和适配器。 |
| `apps/backend/src/application/`、`domain/`、`store/` | 业务用例、输入校验、SQLite 数据与迁移。 |
| `apps/backend/src/runtime/`、`collaboration/`、`feishu/` | 运行时隔离、Worktree 路由、Agent 协作和飞书网关。 |
| `apps/backend/tests/`、`apps/macos/Tests/` | 后端与客户端自动化测试。 |
| `scripts/`、`docs/`、`resources/` | 开发与打包脚本、专项文档和项目资源。 |

## 开发与验证

### 常用命令

```sh
# 后端完整测试
npm test --prefix apps/backend

# macOS 单元测试
swift test --package-path apps/macos

# 只构建 macOS Debug App
swift build --package-path apps/macos

# 检查后端入口语法
node --check apps/backend/src/server.mjs

# 修改项目文件后：构建、重启并验证 Development App 与后端
scripts/dev-rebuild-restart.sh
```

Makefile 提供相应快捷入口：

```sh
make help
make test
make build
make restart
```

`make test` 当前运行后端测试；需要同时验证客户端时请单独执行 `swift test --package-path apps/macos`。开发改动完成后，仓库要求使用 `scripts/dev-rebuild-restart.sh` 重建并确认 App 进程与 Development 后端都已启动，单独编译成功不等同于运行验证通过。

### Provider 开发约束

新增 Provider 时：

- 在 `agent-provider/providers/` 映射协议，在 `agent-provider/bootstrap/` 组合具体 SDK/Client；
- 只声明真实实现的 capability；
- 保留逻辑 Session 与原生 Session 的持久绑定和可恢复 alias；
- 不在 Application Service、通用路由或 SwiftUI 中引入具体 Provider 分支；
- 运行 Provider contract/boundary suite，并补充创建、历史、实时事件、审批、中断和失败诊断用例。

完整要求见 [Agent Provider 开发指南](docs/agent-provider-development.md)。

## 打包与本机安装

打包前先确保后端依赖已安装，因为安装包会把 `apps/backend/node_modules` 一并物化到 App bundle：

```sh
npm ci --prefix apps/backend
scripts/package-macos-installer.sh
```

脚本当前构建 Apple Silicon Release App，并在 `dist/` 生成带时间戳的 `.pkg` 和 `.dmg`。未指定签名身份时使用 ad-hoc 签名，仅适合本机开发与测试；重新构建后 macOS 可能要求再次授予隐私权限。

需要稳定保留屏幕录制等 TCC 权限时，使用固定的 Developer ID Application 身份：

```sh
CORPTIE_APP_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
  scripts/package-macos-installer.sh
```

从当前工作区构建、检查 Production 是否存在未完成 Session、安全替换 `/Applications/Corptie.app` 并重新打开：

```sh
scripts/rebuild-install-restart-production.sh
```

只做停机安全检查，不修改 Production：

```sh
scripts/rebuild-install-restart-production.sh --check-only
```

## 常见问题

### Development 后端没有就绪

查看直接启动脚本输出和日志：

```sh
tail -n 100 /tmp/corptie-backend-development.log
lsof -nP -iTCP:47322 -sTCP:LISTEN
```

使用 `scripts/dev-rebuild-restart.sh` 时，日志位于 `/private/tmp/corptie-dev/backend.log` 和 `/private/tmp/corptie-dev/app.log`。

### App 能打开，但创建 Codex Session 失败

确认 `codex` 可执行文件和原生认证可用：

```sh
command -v codex
codex --version
test -f "$HOME/.codex/auth.json"
```

GUI 环境找不到自定义位置的二进制时，启动前设置 `CORPTIE_CODEX_PATH=/absolute/path/to/codex`。

### 外置磁盘上的 Workspace 无法访问

在“系统设置 → 隐私与安全性 → 完全磁盘访问权限”中为 Corptie 授权，然后重新打开 App。不要通过修改 Workspace 路径绕过 macOS 权限错误。

### OpenClacky 显示不可用

先验证独立服务是否监听默认端口，或设置实际地址：

```sh
curl -fsS "http://127.0.0.1:7070"
OPENCLACKY_BASE_URL="http://127.0.0.1:7070" scripts/run-development.sh
```

OpenClacky 是外部生命周期 Provider；Corptie 不负责静默启动替代进程。

## 相关文档

- [Agent Provider 开发指南](docs/agent-provider-development.md)
- [Agent 协作机制](docs/agent-collaboration.md)
- [Codex Worktree Session 切换验收记录](docs/codex-worktree-session-switching-acceptance.md)
- [Session 生命周期监督器设计](docs/session-lifecycle-supervisor-design.md)
- [OpenClacky Provider 对齐审计](docs/openclacky-provider-parity-audit-and-remediation.md)

## License

[Apache-2.0](LICENSE)

---

最后核对：2026-08-20
