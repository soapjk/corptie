<p align="center">
  <img src="apps/macos/Sources/CopetsMac/Resources/AppIcon.png" alt="Corptie 应用图标" width="144">
</p>

<h1 align="center">Corptie</h1>

<p align="center">
  <strong>面向多项目、多任务与多 Agent 并行工作的本地优先工作台</strong>
</p>

<p align="center">
  <a href="https://github.com/soapjk/corptie/releases/latest">下载最新版</a>
  ·
  <a href="docs/product-showcase.md">产品展示</a>
  ·
  <a href="README.en.md">English</a>
</p>

Corptie 把分散的 Agent 会话、具体任务、worktree和上下文组织在一个持续工作、持续进化的系统中，最大程度的让个人能管理更复杂的项目架构。

## 核心能力

| 能力 | 为你解决什么问题 |
| --- | --- |
| **多项目并行工作台** | 在一个统一界面中查看和管理多个 Agent Session，只在需要关注时介入。 |
| **Objective 与 WorkItem** | 用 Objective 管理长期目标，用 WorkItem 承载具体任务、验收标准和执行状态。 |
| **分层记忆** | 分别沉淀 Agent、Objective 和 WorkItem 层级的长期知识与任务上下文，在控制上下文占用的前提下让模型知道项目偏好。 |
| **跨 Session 协作** | 不同的会话/任务之间可以通过完善的通信机制进行自动化的交互与协作，完全避免人类成为传话员。 |
| **Worktree管理** | 为并行开发任务维护清晰的项目和 Git Worktree 边界，完善的一键化 worktree合并，清理功能，无需担心并行太多worktree的管理问题。 |
| **Agent Provider 接入** | 核心agent依赖codex/claude code/openclaky,直接使用你熟悉的模型|
| **skill管理** | 支持为不同创建的Agent指定其可用的Skill集合，在启动会话时做到只启用需要使用Skill，避免多余的上下文占用。|
| **计划任务** | 所有会话都可以由模型自主创建计划任务，包括自定义的脚本监控以及定时任务，在合适的时候自动激活会话及时处理。|
| **本地优先** | App、后端、任务状态和 SQLite 数据全部运行并保存在本地。 |

## 为什么需要 Corptie

单个 Agent 会话很容易开始，但真实项目通常不会停留在一个会话里：多个需求同时推进、不同仓库相互依赖、新问题在执行过程中不断出现，Session 和 Worktree 的数量也随之增长。

当这些工作缺少统一组织时，用户往往需要亲自承担额外的协调成本：

- 在多个窗口和项目之间频繁切换，逐个确认 Agent 是否在运行、等待输入或已经失败；
- 为新会话重复描述项目背景，并在长时间工作后重新寻找上下文；
- 把一个任务发现的问题手动转述给另一个项目，再把处理结果带回原任务；
- 同时管理目标、具体任务、代码 Worktree、审批与验收结果，避免不同工作相互覆盖；
- 在 Agent 输出“已完成”之后，仍然需要判断功能是否真的实现、测试是否真的通过。

Corptie 的目标不是再增加一个聊天窗口，而是为持续、异步、相互依赖的 Agent 工作建立统一的组织和协作方式。


## 一个典型的工作流

1. 创建一个 Agent角色，定义工作方式和可用能力。也可以直接使用内置Agent
2. 为长期目标创建 Objective，并把不同需求拆成带有验收标准的 WorkItem。
3. 为 WorkItem 启动 Session；需要代码隔离时，让任务使用独立 Worktree。
4. 多个 Session 在后台并行推进，你只处理输入、审批、异常和关键决策。
5. 如果任务依赖另一个项目，来源 Session 可以向目标 Session 发起协作，由对方交付结果。
6. Agent 完成后逐条提交可复现证据，再由你确认是否真正满足验收标准。

也可以跳过结构化任务管理，直接创建 Assistant Agent 和 Session，把 Corptie 当作低打扰的多 Agent 桌面工作台使用。

## Corptie 如何组织工作

| 概念 | 在产品中的作用 |
| --- | --- |
| **Agent** | 定义角色、长期工作方式以及可以使用的 Skills。 |
| **Session** | 真正执行工作、发送消息、接收审批和参与协作的主体。 |
| **Objective** | 描述一个需要持续推进的目标和理想状态。 |
| **WorkItem** | 描述一项可执行、可验收的具体工作。 |
| **Workspace** | 将工作关联到明确的本地项目或 Git 仓库。 |
| **Worktree** | 为并行代码任务提供独立工作目录，避免相互覆盖。 |

简单问题可以直接对话，长期目标和跨项目开发则可以逐步引入 Objective、WorkItem、Worktree 与 Session 协作。

## 快速开始

### 前置条件

- 当前版本支持 macOS 14 或更高版本；
- Node.js 22.13 或更高版本，并支持内置 `node:sqlite`；
- 至少一个已安装、可用并完成认证的 Agent Provider，例如 Codex CLI、Claude Code 或 OpenClacky。

### 安装 Corptie

1. 前往 [GitHub Releases](https://github.com/soapjk/corptie/releases/latest) 下载最新的 DMG 或 PKG；
2. 打开 Corptie，按界面提示检查本地后端和 Agent Provider；
3. 当前发布包使用 ad-hoc 签名，PKG 尚未签名。如果 macOS 阻止首次启动，请确认文件来自本仓库的官方 Release，并在 **系统设置 → 隐私与安全性** 中手动允许。

### 第一次使用

1. 打开 **Agents**，创建 Assistant 或 Independent Contributor Agent；
2. 从 Agent 卡片启动新 Session，选择 Provider、工作目录和可用模型；
3. 在 **Sessions** 中发送第一条消息，并在需要时处理输入、审批、中断或恢复；
4. 需要管理长期目标时，再创建 Objective 和 WorkItem，并为任务选择 Workspace 与执行 Agent。

## 本地数据与安全

- Corptie 的本地后端、任务状态、队列和 SQLite 数据默认保存在你的设备上；
- Corptie 自己管理的 Provider 运行时使用独立状态目录，减少应用环境与 Provider 原生用户配置相互污染；具体隔离范围以所选 Provider 的能力为准；
- 审批、协作请求、Workspace 切换以及其他高影响操作通过明确的界面和能力契约执行；
- Git 修改、Worktree 和未提交内容不会因为 Agent 声称“完成”而被视为已验证；
- 实际模型请求、账号认证和外部网络行为仍由你选择的 Agent Provider 及其配置决定。

## 进一步了解

| 你想了解的内容 | 文档 |
| --- | --- |
| Agent、Session、Objective、WorkItem 与 Workspace 的准确关系 | [领域模型与能力边界](docs/domain-model-and-capability-boundaries.md) |
| Session 如何跨任务协作、交付和验收 | [Agent 协作机制](docs/agent-collaboration.md) |
| 如何接入新的 Agent Provider | [Agent Provider 开发指南](docs/agent-provider-development.md) |
| 产品界面与功能截图 | [产品展示](docs/product-showcase.md) |
| 产品演示 | [YouTube 视频](https://youtu.be/OqqVC_ITiYc) |
| 版本下载与变更 | [GitHub Releases](https://github.com/soapjk/corptie/releases) |

README 只介绍产品价值和最短使用路径。源码构建、测试、打包、内部架构与贡献流程应在独立的开发文档中维护。

## License

[Apache-2.0](LICENSE)
