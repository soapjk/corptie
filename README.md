<p align="center">
  <img src="apps/macos/Sources/CopetsMac/Resources/AppIcon.png" alt="Corptie 应用图标" width="144">
</p>

<h1 align="center">Corptie</h1>

<p align="center">
  <strong>让你更高效地燃烧 token</strong>
</p>

<p align="center">
  <a href="https://github.com/soapjk/corptie/releases">下载与版本记录</a>
  ·
  <a href="README.en.md">English</a>
</p>

Corptie 将项目、任务、Agent 和 Git 工具进行恰到好处的融合，形成一个效率极高的开发工作闭环。建立项目 → 绑定本地仓库 → 创建具体任务派发 Agent 执行 → Git 合并回原仓库。极简的工作闭环配合完善的效率工具。

## 核心能力

| 能力 | 介绍 |
| --- | --- |
| **Work 与 Task** | 极简的两层项目单位，灵活到极致。 |
| **协作工具** | 所有在模型中创建的会话相互之间都能建立通信机制，合作完成任务。这意味着无需手动在多个窗口之间切换搬运上下文。典型场景：在 Project A 的会话中让 Project B 适配一下我们刚改的最新接口。 |
| **Agent 与 Skills** | 配置角色、工作方式和可用 Skills，按工作需要选择参与的 Agent。 |
| **Artifacts** | 管理可检索、带版本的资料文件。 |
| **分层记忆机制** | 全局用户偏好、项目内记忆和任务短期记忆分层管理，在最小化上下文占用的同时，让模型获取有用信息。 |
| **计划任务** | 可被模型主动使用的创建计划任务的工具。让模型无需等待轮询长时间脚本任务，而是在需要的时候自主唤醒。 |
| **Workspace 与 Worktree** | 将工作关联到本地项目；通过 Task 工作目录准备、Git Worktree 管理和代码检索支持并行开发。 |
| **IM 支持** | 支持快捷接入飞书机器人，并对机器人提供 `/sessions` 会话管理工具。 |

## 如何组织工作

| 概念 | 含义 |
| --- | --- |
| **Work** | 持续工作的组织单元，可以近似等同于 Project 概念。你必须创建一个 Work 才能真正开始你的工作。Work 必须与一个本地的文件夹所绑定，建议是绑定一个 Git 仓库。 |
| **Task** | Task 表示 Work 下面的一项具体任务，如一个需求或者一个持续迭代的模块。每一个 Task 都天然绑定一个 Agent 的会话。这是用户的主要交互入口，用户通过与该 Task 的会话交互来完成其任务。 |
| **Agent** | 可复用的角色资源，用户可以自主创建 Agent，其可概括为技能类记忆、人设，还有 Skill 的集合。然后在 Task 中指定 Agent 来进行任务推进。 |
| **Provider** | 模型能力提供方（如 Codex、Claude），Provider 提供的是最核心的模型的能力，上面的 Agent 角色只是上下文定义，指定了 Provider 才会让具体的模型来使用 Agent 资源执行任务。 |
| **Artifact** | 与 Work 和 Task 相关的资源文件，其不进入 Workspace 目录，由用户通过本项目直接管理。其主要是一些不需要进入项目结果，但却需要在中间进行记录的一些资源，如一些可能包含隐私数据的文档，或用户不希望将其推送到 GitHub 的设计文档。有简单的版本管理功能。 |
| **Corptie 工具集** | 在本项目平台中，所有创建的会话都会通过其上下文注入来给其提供 Corptie 相关的基础工具，包括前述核心能力中的协作工具、计划任务工具等等。 |

## 快速开始

### 运行条件

- macOS 14 或更高版本。
- Node.js 22.13 或更高版本，支持内置 `node:sqlite`。
- 至少一个可用且已完成认证的 Provider 运行环境：Codex、Claude Code 或 OpenClacky。

从 [GitHub Releases](https://github.com/soapjk/corptie/releases) 选择安装包，安装并打开 Corptie，然后检查本地后端与所选 Provider 的可用状态。Provider 的模型访问与认证由对应运行环境提供。

### 第一个 Work

1. 准备一个 Contributor Agent，配置角色和需要使用的 Skills。
2. 创建 Work，填写名称和背景，选择参与的 Agent；涉及本地项目时关联 Workspace。
3. 在 Work Chat 中讨论需求，再创建 Task，写清具体目标、验收标准与验证方式。
4. 为 Task 启动执行 Session。Corptie 会准备并绑定任务工作目录；代码任务在相应的 Workspace / Worktree 边界内执行。
5. 查看 Session 的实际运行状态，按需回复、审批或中断；将长期资料保存为 Artifact，需要后续触发时配置 Automation。
6. 检查实现、交付物和验证证据，再确认任务是否达到完成条件。

需要另一个 Session 协助时，可以发起 Channel 通信并确认首次授权，后续继续使用该 Channel 交流。

## 本地数据与运行边界

Corptie 的后端、SQLite 状态、工作队列和资料存储默认运行在本机。应用管理的 Provider 使用专用运行时配置与状态目录；具体隔离能力取决于 Provider。

“本地优先”不代表模型离线运行。模型请求、认证以及启用的外部工具仍可能访问网络，具体取决于 Provider、工具与用户配置。Session 通信授权也不会替代其他操作所需的权限。

正式版后端默认使用 `127.0.0.1:47321`，开发版默认使用 `127.0.0.1:47322`。开发重建脚本按 Worktree 隔离后端数据、展示数据和前端偏好；它的路径与端口配置见下文。

## 源码开发

除运行条件外，需要 Swift 6 工具链、Rust / Cargo，以及开发启动脚本使用的 Python 3。Rust 用于编译后端原生模块。

在仓库根目录安装依赖并构建原生模块：

```sh
npm ci --prefix apps/backend
npm --prefix apps/backend run build:native
```

首次前台运行：

```sh
scripts/run-development.sh
```

该入口会检查开发后端，并在 macOS 调试产物不存在时构建应用；已有产物时直接运行。修改实现后，使用重建入口更新并重启开发版：

```sh
scripts/dev-rebuild-restart.sh
```

**重建脚本当前要求外置卷路径。** `CORPTIE_DEVELOPMENT_RUNTIME_ROOT` 默认是 `/Volumes/T9/CorptieData/development-launcher`，自定义值也必须位于 `/Volumes/` 下。请先按本机实际卷名配置，例如：

```sh
CORPTIE_DEVELOPMENT_RUNTIME_ROOT="/Volumes/YourVolume/CorptieData/development-launcher" \
  scripts/dev-rebuild-restart.sh
```

脚本会编译 Swift 应用和 Rust 模块，启动由开发 App 管理的后端，并检查健康状态和进程。日志与数据按 Worktree 存放在上述目录中，最终日志位置由脚本输出。并行运行不同 Worktree 时，可用 `CORPTIE_DEVELOPMENT_BACKEND_PORT` 为该重建入口指定空闲端口。

常用验证命令：

```sh
npm test --prefix apps/backend
swift test --package-path apps/macos
curl --fail http://127.0.0.1:47322/health
```

后端测试会先构建原生模块。使用自定义端口时，同步调整健康检查地址。

### 打包

安装依赖并构建原生模块后执行：

```sh
scripts/package-macos-installer.sh
```

产物写入 `dist/`。当前脚本使用 `arm64-apple-macosx` 构建产物路径；未设置 `CORPTIE_APP_SIGNING_IDENTITY` 时使用 ad-hoc 应用签名。有 Developer ID Application 证书时，可通过该变量指定签名身份。

## 代码导航

| 入口 | 内容 |
| --- | --- |
| [macOS 前端](apps/macos/Sources/CopetsMac) | 原生界面、Work / Task 管理、Session、资料与自动化交互。 |
| [后端应用服务](apps/backend/src/application) | 工作和任务、会话启动、Artifacts、记忆、Automation 等业务流程。 |
| [Provider 层](apps/backend/src/agent-provider) | 统一契约、会话绑定和各 Provider 适配。 |
| [Session Channel 服务](apps/backend/src/collaboration/sessionChannelService.mjs) | 通信授权、消息投递与 Channel 生命周期。 |
| [项目代码服务](apps/backend/src/project-code) | 代码快照、索引、检索和读取。 |
| [后端原生模块](apps/backend/native) | Rust 原生能力。 |
| [开发与打包脚本](scripts) | 本地运行、开发重建、验证辅助与安装包生成。 |

前端通过共享模型和声明的能力访问 Provider；后端业务通过统一 Provider 抽象组织执行。扩展能力时应保持前端、后端与 Provider 实现之间的边界。

## License

[Apache-2.0](LICENSE)
