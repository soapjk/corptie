# Agent Provider 开发指南

Corptie 的产品能力只依赖统一 Session、逻辑身份、标准事件和 capability。Provider 名称、原生 Session ID、协议事件以及具体 Client/Manager 都属于适配层，不能进入 Application Service、通用 HTTP API 或 macOS 通用 UI。

## 边界

- `agent-provider/contracts.mjs` 定义小型可选能力以及能力到方法的映射。
- `agent-provider/agentProviderRegistry.mjs` 校验声明、执行 capability dispatch，并为 Session 生成标准 action 状态。
- `agent-provider/sessionApplicationService.mjs` 是会话生命周期、对话、配置及 Provider 可选能力的产品入口。
- `agent-provider/providers/` 只负责把具体协议映射成标准 Provider。
- `agent-provider/bootstrap/` 可以持有具体 Client/Manager，并在 composition root 注册 Provider。
- `application/`、`runtime/project*`、通用 Controller 和 Swift UI 不得导入具体 Provider，也不得根据 Provider 名称或 Session ID 前缀选择行为。

Project、Worktree、Git 和 Development Service 以 `projectId`/`workspaceId` 为主键。它们不能要求先存在 Session。Session 与 Worktree 的关系通过逻辑 Session binding 表达。

## 新增 Provider

1. 在 `providers/` 增加协议适配器，提供 descriptor、`listSessions()`、`readSession()`，并只声明真正实现的 capability。
2. 在 `bootstrap/` 创建具体运行时，持有 SDK、CLI 或协议 Client/Manager；不要把它传给产品服务。
3. 在 `agentProviderBootstrap.mjs` 注册适配器。产品 Controller 和 Swift UI 不应发生变化。
4. 将原生事件映射为标准 Session snapshot/event，并保存逻辑 Session 与原生 Session 的 binding。旧 ID 必须作为 alias 可恢复，不能静默丢弃。
5. 为 Provider 运行共享 contract suite，并增加该 Provider 的 bootstrap/adapter 测试。

若协议不支持某项能力，不要模拟成功，也不要在 UI 中检查 Provider 名称。省略 capability 后，统一 action 会给出 `CAPABILITY_UNSUPPORTED`，UI 据此隐藏或禁用入口。

## Capability 规则

- capability 应描述协议真实能力；临时离线、没有 active turn 等运行状态由 Session action 表达。
- 每项 capability 必须在 `AGENT_PROVIDER_METHOD_BY_CAPABILITY` 中映射到单一方法，并由契约校验保证实现存在。
- Provider 专属的产品功能必须先抽象成语义能力。例如单轮改动操作使用 `turn.changes.manage`，HTTP API 使用 `/sessions/:id/turns/:turnId/changes/:action`，不能暴露 Codex thread 路由。
- 后台操作使用 `BackgroundAgentService` 和独立 operation event，不得写入用户 transcript。
- Tool Host 通过标准 catalog/attachment 注入；不支持动态工具的 Provider 不声明 `tools.attach`。

## API 与前端

新增功能优先扩展统一 `/sessions`、`/projects` 和 `/providers` API。不得新建 `/codex/*`、`/claude/*` 等 Provider 路由。前端只消费标准 DTO 中的 `actions`、`capabilities` 和不可用原因。

当前 `/codex/pty-sessions` 与 `/pty/*` 仅是待整体移除的 PTY 兼容面，不应作为新实现范例，也不应扩展。

## 提交前检查

- Provider contract、Session Application Service、迁移和项目服务测试通过。
- 架构测试保持零新增具体 Provider 依赖和零 Provider 名称行为分支。
- 新 Provider 使用统一 API 完成 create/read/resume/send/approve/interrupt/delete 的适用项；不适用项返回结构化 capability 错误。
- Development App 重建并启动，后端健康检查通过；受支持 Provider 完成本地冒烟。
