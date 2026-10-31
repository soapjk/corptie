<p align="center">
  <img src="apps/macos/Sources/CopetsMac/Resources/AppIcon.png" alt="Corptie 应用图标" width="144">
</p>

<h1 align="center">Corptie</h1>

<p align="center">
  <strong>面向专业开发者的多 Agent 协同与并行开发工作台</strong>
</p>

<p align="center">
  <a href="https://github.com/soapjk/corptie/releases">下载最新版本</a>
  ·
  <a href="README.en.md">English</a>
</p>

Corptie 将项目、任务拆解、多 AI 会话与 Git 工具链深度整合。不仅能在桌面端通过独立的 Git Worktree 安全地并行推进多个任务，还支持在长时间任务中自动休眠与唤醒、跨会话直接协作；离座时，更能通过 iPhone 或 iPad 随时接续推进。

---

## 核心工作流

Corptie 围绕 **Work（项目/工作区）** 与 **Task（任务）** 建立清晰的开发闭环：

<p align="center">
  <img src="resources/workflow.svg" alt="Corptie 核心工作流" width="100%">
</p>

---

## 核心特性

### 🌲 Task Worktree 物理隔离与管理
告别单工作区频繁切换分支的混乱。Corptie 为每个开发任务（Task）分配独立的 Git Worktree 与工作分支：
* **多任务并行开发**：多个 Agent 可同时在不同任务中修改代码、运行依赖与构建，互不干扰、互不污染工作区。
* **原生 Git 集成管理**：内置完整的代码审查（Diff）、暂存、提交、分支同步、冲突协助与一键合并回主线。

### 🌿 子任务（Parent / Child Tasks）层级分发
面对复杂的大型需求，可以灵活创建多级子任务体系：
* **结构化拆解**：主任务负责整体方案与统筹，子任务聚焦具体模块与实现。
* **分发交付与集成**：子任务拥有独立开发空间，完成后安全交付并集成至父任务 Worktree，由父任务统一运行综合验证。

### 🔄 会话内无缝切换 Agent 与模型
同一个任务在不同阶段往往需要不同的专长角色或模型能力：
* **无缝切换 Agent 角色**：会话中随时切换不同的人设、工作指令与技能集合（Skills），无需重建会话或丢失历史上下文。
* **自由切换底层模型**：支持在 Codex、Claude Code、OpenClacky 等主流 AI 运行环境之间自由切换，复杂架构设计用强思考模型，机械代码搬运切高性价比模型。

### ⏰ 长任务自动唤醒（无需守着终端）
执行大工程编译、耗时测试或后台部署时，开发者和 AI 都不必在屏幕前干等：
* **主动休眠与唤醒**：配置自动化条件或监控进程，Agent 在脚本执行期间自动休眠，不空耗资源和轮询。
* **即时介入**：进程退出、测试完成或触发报错条件时，系统自动唤醒会话继续执行下一步，省心高效。

### 💬 跨会话原生通信与协作（Channel）
让多任务、多项目的 Agent 真正配合起来，告别开发者充当“人肉二传手”：
* **直连通信通道**：不同 Task 甚至不同 Work 绑定的会话之间，可直接建立受控的 Channel 通信。
* **自主接口联调**：前端会话可直接向后端会话提需求：“请把刚改的 API 契约同步过来”；后端会话改完即刻回传，协同完成端到端落地。

### 📱 苹果全家桶移动端支持（Mac 执行，移动端接续）
重度编译与模型运行在桌面端，移动端提供无缝的远程跟进体验：
* **随时随地跟进**：在 iPhone 或 iPad 上实时查看会话进展、发送文字与图片指导、查阅代码 Diff、停止异常任务。
* **安全灵活的连接**：
  * **局域网配对**：在工位通过扫码直接与 Mac 建立高速本地连接。
  * **Cloud 远程连接**：登录同一账号后，在外网也可通过端到端加密（E2EE）安全接入家中的 Mac。
* **状态即时触达**：任务完成、遭遇阻碍或需要审批时，移动端即时推送通知，点击直达会话。

### 🧠 分层记忆机制
既要让模型理解你，又要避免上下文爆炸：
* **三层独立记忆**：全局用户偏好、项目内长期背景、任务级短期上下文分层存储。
* **精准上下文命中**：仅在相关时轻量注入，保证 Agent 行为一致，同时最小化上下文占用。

### 📦 Artifacts 资料与成果管理
代码进入 Git，而设计草稿、接口文档、敏感临时数据不宜污染仓库：
* **独立版本追踪**：脱离 Git 目录，由 Corptie 本地统一管理带版本的资料文件与交付物。
* **安全物化机制**：仅在本地程序明确需要读取时才安全物化到受忽略目录，既保护数据隐私，又保证协作可追溯。

---

## 开始使用

### 运行环境要求
* **macOS 14 或更高版本**（推荐 Apple Silicon Mac）。
* 已安装并完成认证的 AI 运行环境（Codex、Claude Code 或 OpenClacky 至少一个）。

### 快速开始
1. 从 [GitHub Releases](https://github.com/soapjk/corptie/releases) 下载并安装 Corptie。
2. 打开应用，确认本地服务与已安装的 AI 运行环境状态正常。
3. 创建一个 **Work**，绑定你的本地代码仓库。
4. 创建 **Task** 明确开发目标，分配 Agent 并开启会话，开始并行研发。

---

## 源码运行与开发

### 编译依赖
* Node.js 22.13+（支持内置 `node:sqlite`）
* Swift 6 工具链
* Rust / Cargo
* Python 3
* （可选）移动端开发需要 Xcode 及对应调试证书

### 一键开发命令
项目根目录提供了便捷的 `Makefile` 指令：

```sh
# 安装依赖并构建原生模块
npm ci --prefix apps/backend
npm --prefix apps/backend run build:native

# 启动开发环境（自动启动后端服务与 macOS App）
make dev

# 修改代码后重新编译并重启开发 App
make restart

# 运行后端单元测试
make test

# 部署并调试移动端（iPhone / iPad）
make mobile
# 如有多台设备可指定设备：make mobile DEVICE="设备名或UDID"
```

更多开发脚本与高级配置说明，可查阅 [Makefile](Makefile) 与 [scripts](scripts) 目录。

---

## 开源协议

本项目采用 [Apache-2.0](LICENSE) 协议开源。
