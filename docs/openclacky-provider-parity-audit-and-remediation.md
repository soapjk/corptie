# OpenClacky Provider 能力一致性审计与改造方案

## 1. 文档信息

- 审计日期：2026-08-18
- Corptie 基线：`360c379716046180b5a0cd316c26906eeef17f65`
- OpenClacky 运行版本：`1.5.9`
- OpenClacky 上游审计基线：`26c91a1bf1f7b09169b13d2f41ac43271e8b2e28`
- 目标：使 OpenClacky 在 Corptie 中遵守与 Codex、Claude 相同的 Provider-neutral 产品契约，优先补齐 Objective / WorkItem 管理、Worktree 隔离、权限边界和会话可靠性。
- 方法：Corptie 本地代码审计、当前 Objective 内 OpenClacky Session 的只读运行样本、OpenClacky 官方 Host API 文档和上游源码交叉验证。

本文所说的“一致性”不是要求不同 Provider 输出完全相同，而是要求它们在 Corptie 的公共能力合同、权限、状态语义和失败行为上保持一致。Provider 特有能力仍通过 capability 显式声明。

## 2. 执行结论

OpenClacky 当前不会像 Codex Session 那样自行创建并切换 Worktree，直接原因不是 OpenClacky 模型“不会使用 Git”，而是 Corptie 的 OpenClacky adapter 只实现了最小会话与对话能力：它没有声明或挂载 `TOOL_HOST_ATTACH`、`WORKSPACE_TRANSITION`，也没有给 OpenClacky 注入 Corptie 的 Objective / WorkItem / Workspace 工具与会话身份。因此 OpenClacky 即使收到 Objective 文本，也无法可靠调用产品控制面创建 WorkItem、启动执行或完成逻辑 Workspace 切换。

审计同时确认：

1. OpenClacky 上游会读取目标目录内的 `AGENTS.md` 等项目规则，所以“完全遗漏仓库规则”不是准确结论；缺失的是 Corptie Agent 实体的系统提示词、运行时规则、会话级权限、Objective 身份以及 Provider-neutral 工具控制面。
2. OpenClacky 上游已有 Session、MCP、Skill、工具事件、Token 用量、Git 与文件 API 等基础能力，但 Corptie adapter 大量没有接入。
3. 上游创建 Session 的 API 目前没有会话级 system prompt append、MCP manifest、权限模式或 Corptie metadata 参数。若只靠普通用户消息注入上下文，不能形成可信权限边界。
4. 上游 `PATCH working_dir` 只改变工作目录并注入一条上下文，不会重建系统提示词、项目规则或 MCP 注册表。把它直接当成 Worktree 切换会让新 Worktree 的规则与工具状态不完整，不能作为正式实现。
5. 当前 OpenClacky 由外部原生配置启动，Corptie 没有像官方 Provider runtime 那样完整拥有其隔离状态目录和权限策略。这是安全与可复现性问题，必须先于“宣称能力一致”解决。

结论是：主要缺陷位于 Corptie 的 OpenClacky 集成层和双方缺少的会话级扩展协议，而不是单纯的 OpenClacky 推理质量问题。应优先建立隔离运行时、可信工具桥和 Workspace transition port，再补齐事件、历史、用量与生命周期能力。

## 3. 能力差距矩阵

| 能力 | Corptie OpenClacky 现状 | OpenClacky 上游基础 | 目标与优先级 |
| --- | --- | --- | --- |
| 创建、恢复、删除、重命名 Session | 已接入基础 REST | 支持 | 保持，补齐错误与状态语义 |
| 发送、打断、确认 | 已接入基础 WebSocket | 支持 | P1：增加投递确认、重连与幂等 |
| Model / reasoning 切换 | adapter 固定声明支持 | 部分 API 支持 | P0：改为版本探测后的真实 capability |
| Corptie Agent 系统提示词 | 未注入 | 创建 API 无对应参数 | P0：新增会话 bootstrap 协议 |
| Objective / WorkItem 工具 | 未挂载 | 原生 MCP / extension 可承载 | P0：接入 Provider-neutral Tool Host |
| Worktree 列表、创建、逻辑切换 | 未挂载；无 transition capability | 有 Git/工作目录基础能力 | P0：工具桥 + 新 Session handoff |
| Session 权限与 Workspace roots | 未传递；依赖外部原生配置 | 创建 API 无会话级权限参数 | P0：Corptie-owned 隔离运行时和强制执行层 |
| Skill 懒加载与 Agent memory | Corptie 工具未挂载 | 原生 Skill / MCP 可承载 | P1：复用统一工具服务 |
| Workspace transition | Provider 未实现 | `PATCH working_dir` 不足以安全切换 | P0：fresh-session transition port |
| Clear / restart / permissions update | 未声明、未实现 | 部分可组合 | P2：补齐合同或明确降级 |
| Background prompt | 未实现 | 可通过独立 Session 构建 | P2：接入 Provider-neutral 后台接口 |
| Usage | 忽略 `token_usage`；无统一聚合 | 有事件和 billing API | P1：映射统一 usage 模型 |
| History pagination | 固定读取 100 轮并忽略 `has_more` | 支持 `before` 分页 | P1：游标分页、去重和稳定排序 |
| Event identity / turn identity | 多数事件缺稳定 ID、turn ID、时间戳 | 上游事件字段不足 | P1：协议扩展或兼容层持久化 |
| Subagent / feedback / task finished | 大多忽略或降级为普通消息 | 上游有对应事件 | P1：映射统一事件和交互模型 |
| WebSocket 恢复 | 断开后被动等待下次操作；无自动重订阅 | 支持订阅与 ping | P1：退避重连、重订阅、补拉历史 |
| 能力协商 | capability 硬编码 | 有 `/health`、`/api/version` | P0：启动握手和版本门槛 |

## 4. 证据与根因

### 4.1 Objective 上下文存在，但不是完整运行合同

`objectiveChatContextService` 能生成 Objective 描述、验收标准、Workspace、贡献 Agent 与 WorkItem 摘要。对于不支持 Tool Host 的 Provider，`server.mjs` 会把它包装进首条普通用户消息；`sessionContextMessage.mjs` 再用 `CORPTIE_CONTEXT_V1` 包裹并从展示历史中隐藏。

这只能让模型“看到信息”，不能授予可验证的产品操作能力。当前 Objective Chat 提示使用的是“可以拆解和创建 WorkItem”的建议语气，也不是每项开发工作必须隔离 Worktree 的强制状态机。Codex 的表现来自额外加载的 Host Tools、runtime instructions 和 workspace transition 能力，不能期待只有文本上下文的 OpenClacky自动等价复现。

### 4.2 Provider-neutral 控制面已经存在，但 OpenClacky 未接入

Corptie 已有 `collaborationMcpServer.mjs`，提供 Workspace、Objective Chat、协作、Memory、Skill 和 WorkItem 验收工具，并通过 Session / Agent / Objective / WorkItem 环境身份限制作用域。`workspaceDynamicTools.mjs` 已定义 `corptie_list_workspaces`、`corptie_create_worktree` 和 `corptie_switch_workspace`。

`toolHostService.mjs` 会在 Provider 没有声明 `TOOL_HOST_ATTACH` 时直接返回空 Tool Host。OpenClacky Provider 当前恰好没有该 capability，所以现成的控制面从未进入 OpenClacky Session。这是 WorkItem 与 Worktree 行为差异的直接代码根因。

### 4.3 不能用 `PATCH working_dir` 冒充 Workspace transition

OpenClacky 上游 `change_working_dir` 只更新内部目录并注入 Session context；系统提示词、目标仓库规则和 MCP registry 在 Session 初始化时生成。直接切目录会留下旧目录规则，且无法证明新 Worktree 的 `AGENTS.md` 已加载。

OpenClacky 的正确切换语义应为：在目标 Worktree 创建 fresh provider Session，重新加载目标目录规则和会话级工具，验证 bootstrap 成功，再原子提交 Corptie logical binding。源 Session 在历史已被 Corptie可靠保留前不得删除。失败时保持源 binding active，并清理或标记孤立的目标 Session。

### 4.4 权限与运行时隔离不满足生产合同

当前 adapter 只向 OpenClacky 创建 API 传递名称、工作目录、`coding` profile 和可选模型，没有传递 runtime roots、approval policy、sandbox profile、Agent identity 或 Objective scope。运行实例使用外部原生状态，而不是明确的 Corptie-owned Provider 状态目录。

因此，即使通过项目 `.clacky/mcp.json` 或用户级 `~/.clacky/mcp.json` 快速挂载工具，也会产生跨 Session 配置碰撞、作用域泄漏、不可审计修改和污染用户原生配置的风险。正式方案不得写入用户原生配置；工具授权必须由 Corptie 的会话身份和服务端强制校验，而不是相信模型传入的 Objective 或 Agent ID。

### 4.5 会话历史与事件映射明显不完整

当前 Objective 内一个 OpenClacky 运行样本返回 413 个历史事件（100 轮）：其中含 70 个 `token_usage`、1 个 `subagent_start`、1 个 `subagent_end`、137 个 `tool_call` 和 137 个 `tool_result`。adapter 未映射 Token 与 Subagent 事件。该样本的大多数事件也没有上游 event ID、turn ID 或时间戳，只有用户事件带时间；现有兼容映射会合成不稳定标识。

此外，manager 固定调用 `/messages?limit=100` 并忽略 `has_more`，长会话恢复会截断；WebSocket close 后没有自动退避重连和补拉窗口；`send` 在没有 provider ack 时即返回 queued。这些问题会造成历史遗漏、重复、顺序不稳定和虚假投递成功。

## 5. 目标架构

### 5.1 不改变 Provider-neutral 边界

前端继续只读取统一 Session detail、actions 与 capabilities；业务服务不得按 `openclacky` 名称实现 WorkItem 或 Git 行为。新增能力应进入公共 Provider contract，再由 OpenClacky adapter 实现。Provider 名称判断仅用于品牌和真正特有的协议提示。

### 5.2 增加 OpenClacky 启动握手与能力探测

Provider runtime 启动或注册时读取 `/health`、`/api/version` 和 Corptie bridge protocol version，生成一次真实 capability snapshot。未达到最低协议时：

- 不声明 `TOOL_HOST_ATTACH` 或 `WORKSPACE_TRANSITION`；
- UI 显示明确的受限模式和缺少能力；
- 禁止把需隔离 Worktree 的开发 WorkItem 分配给该 Session，或要求用户明确选择只读/受限运行；
- 记录可审计的版本、探测结果与降级原因。

### 5.3 建立会话级可信工具桥

优先推动或实现以下两种等价协议之一：

1. OpenClacky Host API 原生支持创建 Session 时传入 `system_prompt_append`、会话级 MCP/tool manifest、权限模式和不可由模型伪造的 Corptie metadata；或
2. 在 Corptie-owned 隔离状态目录中安装并启动受管 OpenClacky extension / hidden profile，暴露单一 `corptie_call` 工具，把调用转发到现有 Provider-neutral Tool Host。

第二种方案必须满足：不修改 `~/.clacky`；不写项目级全局 MCP 配置；opaque token 由宿主进程注入且不出现在模型可编辑参数中；token 绑定 Session、Agent、Objective、WorkItem、Workspace roots，具有过期、撤销和轮换；服务端再次进行作用域与权限校验；Tool Host 握手完成后才声明 capability。

现有 `collaborationMcpServer` 和 Host Tool catalog 继续作为唯一业务实现，OpenClacky bridge 只是协议 adapter，不复制 Objective、Memory、Skill 或 Workspace 逻辑。

### 5.4 实现 fresh-session Workspace transition port

OpenClacky `WORKSPACE_TRANSITION` 的建议流程：

1. Corptie 创建并验证 Git Worktree；
2. 记录 `preparing` transition 和目标路径，保持源 binding active；
3. 在目标路径创建 fresh OpenClacky Session，注入 Agent / Objective / WorkItem 身份、权限和 Tool Host；
4. 校验目标 `AGENTS.md` 规则摘要、bridge protocol、目标 cwd 与 capabilities；
5. 迁移允许的标题和指令摘要，不把切换伪装为普通 `cd`；
6. 用 routing version 原子交换 active binding，Session 逻辑 workspace 指向目标 Worktree；
7. 记录 switched 事件并由 Corptie切换逻辑 Workspace；
8. 历史已可靠持久化后再按保留策略 supersede 源 provider Session。

任何步骤失败都不得把 logical workspace 更新成目标，也不得删除源 Session。恢复任务应能识别 `preparing`、`bindingCreated` 和 `switched` 中间态并幂等收敛。

### 5.5 补齐事件、历史和连接可靠性

- 使用上游 `before` + `has_more` 完成全量或按需历史分页；
- 建立 provider event cursor 和 Corptie stable event ID，重复订阅与补拉不得重复写入；
- 为每个发送请求分配 Corptie turn ID，并通过 bridge metadata 关联上游事件；
- 映射 `token_usage`、Subagent、feedback、task finished、tool error 和 approval；
- WebSocket 使用指数退避、抖动、ping/pong、重订阅，恢复后从最后 cursor 补拉；
- 只有收到 provider ack 或可核验历史事件后才确认投递，超时返回结构化未知状态；
- usage 统一进入 Provider-neutral usage 模型，不把 billing API 直接暴露给前端。

## 6. 分阶段实施

### Phase 0：守卫、探测和诚实降级

- 新增 OpenClacky version / bridge feature probe；
- 根据探测结果生成 capability，不再硬编码夸大能力；
- UI 显示受限模式，阻止需要 Worktree 隔离却无 transition capability 的自动启动；
- 增加 Provider contract 测试，确保 capability 与可调用操作一致。

### Phase 1：Corptie-owned 运行时与可信 Tool Host

- 为 OpenClacky 建立隔离配置、状态、日志和扩展目录；
- 实现 Session bootstrap，传递 Agent system prompt、runtime instructions、作用域身份和权限；
- 实现 `TOOL_HOST_ATTACH` bridge，复用现有 Host Tool / MCP 服务；
- 首先开放 Objective / WorkItem、Workspace、Memory、Skill 和验收工具；
- 增加 token 生命周期、审计、拒绝和越权测试。

### Phase 2：Objective / WorkItem 与 Workspace transition

- OpenClacky Objective Chat 可真实 list/create/update/start WorkItem；
- 开发 WorkItem 默认通过工具创建专用 Worktree；
- 实现 fresh-session transition port 和失败恢复状态机；
- macOS UI 依据公共 action/capability 展示 pending、switched、failed 状态。

### Phase 3：会话与事件完整性

- 历史分页、稳定 ID、turn 关联、断线重连和投递确认；
- Token、Subagent、feedback、task finished 与工具错误映射；
- clear、restart、permissions update、background prompt 和 usage 按公共合同逐项补齐；无法支持的能力保持显式不可用。

### Phase 4：一致性回归与渐进发布

- 建立 Codex、Claude、OpenClacky 共用的 Provider contract suite；
- 运行 Objective Chat 到 WorkItem / Worktree 的端到端测试；
- 先对测试 Agent 启用，再按 bridge protocol 版本灰度；
- 保留关闭 OpenClacky bridge 和 transition capability 的独立开关。

## 7. 预计代码范围

- `apps/backend/src/agent-provider/providers/openClackyProvider.mjs`：真实 capability、公共操作实现。
- `apps/backend/src/adapters/openClackyManager.mjs`：bootstrap、bridge handshake、事件游标、分页、重连与投递确认。
- `apps/backend/src/agent-provider/contracts.mjs` 及相关 ports：必要的 Provider-neutral 能力与状态，不引入具体 Provider 业务分支。
- `apps/backend/src/application/toolHostService.mjs`：OpenClacky bridge attachment 与健康状态。
- `apps/backend/src/application/sessionWorkspaceCoordinator.mjs`、`apps/backend/src/runtime/forkingWorkspaceTransitionManager.mjs`：可配置的 fresh-session transition、源历史保留和恢复。
- `apps/backend/src/mcp/collaborationMcpServer.mjs`：仅在公共鉴权/握手确有缺口时扩展，不复制工具实现。
- OpenClacky 受管 runtime / extension 资产：放入 Corptie 管理目录，安装到隔离状态，不触碰用户原生配置。
- macOS Session detail / action UI：只依据公共 capabilities/actions 和 transition state 渲染。
- `apps/backend/tests/openClackyProvider.test.mjs`、Objective Chat、Workspace transition、Provider contract 和 macOS 测试：补齐端到端覆盖。

## 8. 安全、原子性与兼容性要求

- 不向模型暴露长期 access key、backend token 或可自行修改的 Agent / Objective / WorkItem identity；
- 所有工具调用服务端重新验证绑定、Workspace root、Agent 可分配性和 Objective scope；
- 不写用户级或仓库级 OpenClacky 原生 MCP/extension 配置；
- transition 中任一步失败不得产生半切换、错误 cwd 回执或删除源历史；
- API 返回稳定错误码、provider version、缺失 capability 和可恢复状态，不泄漏底层密钥；
- 老版本 OpenClacky 保持基础聊天可用，但不能伪装成支持 Worktree / Tool Host；
- 与 Provider live switch 共存时，workspace/provider transition 复用 routing version 和互斥机制；
- 所有新行为具有 feature flag 和可审计事件，回滚只关闭新 bridge/capability，不破坏已有历史。

## 9. 验证矩阵

1. OpenClacky Objective Chat 读取当前 Objective 后，通过公共工具创建、查询、更新并启动 WorkItem。
2. 开发 WorkItem 启动后创建专用 Git Worktree，Session 逻辑 Workspace 切到该 Worktree，主 checkout 不被修改。
3. 目标 OpenClacky Session 重新加载目标 Worktree 的 `AGENTS.md` 和 Corptie runtime instructions；仅 `PATCH working_dir` 的实现必须被测试拒绝。
4. Tool Host token 不能跨 Session、Agent、Objective、WorkItem 或 Workspace root 使用；撤销后立即失败。
5. 外部路径写入、未批准危险操作和伪造资源 ID 被结构化拒绝。
6. 目标 Session 创建或 bootstrap 失败时，源 Session/binding 仍 active，logical workspace 不变，无 Worktree 泄漏。
7. 超过 100 轮的历史可分页恢复；断线重连、重订阅和补拉后无重复、遗漏或乱序。
8. User、assistant、tool、approval、feedback、token usage、subagent 和 task finished 正确映射并具有稳定 identity。
9. Provider 不返回 ack、返回 5xx、版本过旧或 bridge 不健康时不产生虚假成功，capability 自动降级。
10. Codex、Claude 原有 Tool Host、Objective Chat、Workspace transition 和 Provider switch 回归测试不受影响。
11. macOS UI 只依据公共 capability/action 呈现可用、受限、pending、switched 和 failed 状态。
12. 实现阶段完成相关单元、集成与端到端测试后，执行 `scripts/dev-rebuild-restart.sh`，确认 Development macOS App 与开发后端均成功启动并通过健康检查。

## 10. 修复 WorkItem 验收标准

1. OpenClacky 启动时完成版本与 bridge capability 握手；未支持能力不会被声明或显示为可用。
2. OpenClacky Session 运行在 Corptie-owned 隔离配置/状态中，不修改用户原生 OpenClacky 配置，并获得 Agent system prompt、runtime instructions、Session/Objective/WorkItem 身份与权限边界。
3. OpenClacky 通过 Provider-neutral Tool Host 使用 Objective、WorkItem、Workspace、Memory、Skill 和验收工具；业务逻辑中不新增基于 Provider 名称的实现分支。
4. OpenClacky Objective Chat 能创建并启动当前 Objective 内的 WorkItem，越权资源被拒绝且操作可审计。
5. 开发 WorkItem 能创建专用 Worktree 并通过 fresh OpenClacky Session 完成逻辑切换；不得以 `cd` 或单独 `PATCH working_dir` 代替 transition。
6. Workspace transition 重新加载目标 Worktree 规则；失败时源 binding 与 logical workspace 保持不变，源历史不丢失，中间态可幂等恢复。
7. Workspace roots、approval policy 和工具权限在服务端强制执行，工具凭据不可由模型读取、伪造或跨 Session 重用。
8. 历史支持完整分页，事件具有稳定 ID/turn 关联；断线重连与补拉后无重复、遗漏或顺序漂移。
9. Token usage、Subagent、feedback、task finished、approval 和 tool error 映射到统一 Session 模型，投递失败不返回虚假成功。
10. OpenClacky、Codex、Claude 的 Provider contract、Objective Chat、Workspace transition、Provider switch、后端与 macOS 回归测试全部通过。
11. 老版本或 bridge 不健康时基础聊天保持兼容，UI 明确显示受限原因，并可通过 feature flag 安全回滚。
12. 完成 Development 重建与启动验证，macOS App 进程和开发后端健康检查均成功。

## 11. 发布与回滚

- 默认关闭新 bridge，仅测试 Agent 打开；收集握手失败、工具拒绝、transition 恢复和重连指标。
- capability 必须来自当次运行实例，不从 Agent 配置静态推断。
- 灰度顺序：只读工具 → Objective/WorkItem 写工具 → Worktree create → workspace transition → 其余生命周期能力。
- 任一阶段可关闭相应 feature flag，使 OpenClacky 回到明确受限的基础聊天；不回滚已持久化的统一事件和历史。
- 不执行远程推送、部署或修改上游 OpenClacky；若需要上游协议变更，另行评审并取得远程写入授权。

## 12. 主要参考

### Corptie 本地代码

- `apps/backend/src/agent-provider/providers/openClackyProvider.mjs`
- `apps/backend/src/adapters/openClackyManager.mjs`
- `apps/backend/src/agent-provider/providers/codexAppServerProvider.mjs`
- `apps/backend/src/application/toolHostService.mjs`
- `apps/backend/src/application/sessionWorkspaceCoordinator.mjs`
- `apps/backend/src/runtime/workspaceDynamicTools.mjs`
- `apps/backend/src/runtime/forkingWorkspaceTransitionManager.mjs`
- `apps/backend/src/application/objectiveChatContextService.mjs`
- `apps/backend/src/mcp/collaborationMcpServer.mjs`
- `apps/backend/src/utils/sessionContextMessage.mjs`
- `apps/backend/src/server.mjs`
- `apps/backend/tests/openClackyProvider.test.mjs`
- `apps/backend/tests/objectiveChat.test.mjs`

### OpenClacky 官方与上游

- Host API 文档：https://www.openclacky.com/docs/extend-host-api
- 上游仓库：https://github.com/clacky-ai/openclacky
- 审计 commit：https://github.com/clacky-ai/openclacky/commit/26c91a1bf1f7b09169b13d2f41ac43271e8b2e28

