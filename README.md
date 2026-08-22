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
corptie是一个以多项目并行协作为核心的Agent Harness app。基于此，corptie延伸出了多层记忆机制，跨会话协作工具，agent管理等特性。

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
| 两层极简分级，多个任务同时推荐 | objective管理大目标，workitem执行具体任务。用尽量少的操作流程，高效的进行多任务管理|
| 三层记忆机制，兼顾任务上下文与长期知识沉淀 | agent角色记忆，objective目标记忆，workitem具体任务记忆 分层维护。用最少的上下文发挥记忆作用|
| 跨任务分工协作 | 随时在不同会话之间让agent跨任务发送协作消息，跨项目对齐开发标准。 |
| coding角色与聊天角色隔离管理 | 直接创建 Assistant 或 Independent Contributor agent。咨询归咨询开发归开发 |

## 快速开始

### 前置条件

- macOS 14 或更高版本。
- Node.js 22.13 或更高版本；后端使用内置 `node:sqlite`。
- Swift 6 工具链（Xcode 16 或兼容的 Command Line Tools）。
- Git。
- 至少一个可用的 Agent Provider: codex cli, claude code, openclacky

### 直接下载安装release版本



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


## License

[Apache-2.0](LICENSE)

---

最后核对：2026-08-20
