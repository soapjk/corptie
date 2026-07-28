# Codex Worktree / Workspace 适配验收记录

日期：2026-07-28

分支：`feature/codex-worktree-adaptation`

设计基线：`docs/codex-worktree-session-switching-design.md`

## 结论

设计文档中的 T01–T28 已由实现、自动化测试和 Development 运行检查覆盖。默认模型为“一
个 provider thread 绑定一个 worktree”；同仓切换优先 `thread/fork(cwd)`，fork 不可用或
跨仓时使用新 thread + 有界上下文 handoff，同一 worktree 仅在路径移动恢复时使用
`thread/settings/update`。

创建与切换不要求专用 picker：Agent 通过一等动态工具列出、创建和切换 worktree。任意
Shell 新增的 worktree 会在 turn 结束后被发现，客户端提示用户可让 Agent 列出或切换。

## 自动化与运行验证

- 后端：`npm test`，165/165 通过。
- macOS：`swift test`，120/120 通过。
- 静态检查：`git diff --check` 通过。
- Development 重建：`scripts/dev-rebuild-restart.sh` 成功。
- Development 运行：macOS `CorptieMac` 进程存活，后端
  `http://127.0.0.1:47322/health` 返回 0.5.2 健康状态。
- 重启恢复：重启前后 3 个现存会话的 logical session、provider thread、workspace 和
  routing version 完全一致。
- 隔离：生产后端仍由原进程监听 47321，Development 使用 47322。

## T01–T28 验收矩阵

| 编号 | 状态 | 证据 |
|---|---|---|
| T01 | 通过 | `GitWorkspaceManager` 参数化创建 worktree 并等待 active turn；transition manager fork 后原子提交 logical route。 |
| T02 | 通过 | turn 完成后刷新全量 inventory，`WorkspaceInventoryChanged` 携带新增 worktree；macOS 提示交由 Agent 列出或切换，不自动切换。 |
| T03 | 通过 | NUL porcelain parser 覆盖空格与换行；Git 使用 `execFile` 参数数组；Swift/后端路径投影保留原字符串。 |
| T04 | 通过 | active turn 时 transition 停在 `waitingForTurn`，仅在 completed turn ID 到达后继续。 |
| T05 | 通过 | `thread/fork` 固定 completed source turn，logical route 只替换 active binding，source binding 和历史保留。 |
| T06 | 通过 | instruction source 校验要求 target `AGENTS.md`，拒绝 source 专属或未知作用域。 |
| T07 | 通过 | 已知 global/shared instruction sources 被显式允许。 |
| T08 | 通过 | 指令校验失败不提交 route，候选 thread 记录为 `invalid`，active source 不变。 |
| T09 | 通过 | macOS `GitBranchResolver` 每 3 秒读取 active workspace 实时 HEAD，普通 `git switch` 不触发 thread 切换。 |
| T10 | 通过 | `GitBranchResolverTests.testReportsDetachedHead` 验证 `detached@<shortOid>`。 |
| T11 | 通过 | `GitBranchResolverTests.testReportsAnUnbornBranch` 验证 unborn 分支。 |
| T12 | 通过 | route guard 对 missing/identity-changed worktree fail closed，禁止发送和 Diff apply，不回退 cwd。 |
| T13 | 通过 | worktree identity 基于 git-dir；moved path 通过 settings/update、resume、指令校验和原子 rebind 恢复。 |
| T14 | 通过 | transition journal 恢复测试覆盖 fork 后提交前恢复、handoff turn 恢复和模糊 fork 标记失败。 |
| T15 | 通过 | SQLite 路由持久化测试与实际 Development 后端重启前后快照比对通过。 |
| T16 | 通过 | session 设置中可只读打开历史 thread；旧 detail 强制 source cwd/branch，成功与回退读取路径都禁用发送。 |
| T17 | 通过 | superseded thread 通知标记为 historical；active UI 不同步；历史 Diff 只允许在验证过的 source worktree review，undo 禁止。 |
| T18 | 通过 | permission snapshot 随 fork；workspace-write 根切换到 target，source 不被隐式保留为写根。 |
| T19 | 通过 | sandbox 类型不改变，路径重写只替换同一 moved-worktree 前缀；read-only/full-access 不扩大。 |
| T20 | 通过 | 历史 command 标记 `old workspace`；设置页说明旧命令/终端留在 source，新 turn 从 active target cwd 启动。 |
| T21 | 通过 | 保守识别 fork unsupported，回退新 thread + 有界 handoff；UI 显示 Context handoff。 |
| T22 | 通过 | moved worktree 使用 settings/update + resume，不 fork；校验新 cwd、sandbox roots 和 target instructions。 |
| T23 | 通过 | repository 不同直接选择 handoff，不尝试 fork；新 thread 仅验证 target/global instructions。 |
| T24 | 通过 | 自动化测试证明创建后 transition 失败仍保留 worktree，重复创建被拒绝，source route 未提交。 |
| T25 | 通过 | snapshot 始终登记 porcelain 返回的全部 worktree；`corptie_list_workspaces` 返回全部 opaque IDs，不猜“最新一个”。 |
| T26 | 通过 | 顶部分支来自 active workspace 路径的实时 Git 查询，不使用 App Server 持久化 gitInfo。 |
| T27 | 通过 | routingVersion 乐观并发检查与 workspace transition queue barrier 保证新消息只进入确定 route。 |
| T28 | 通过 | branch resolver 对非 Git 返回 No Git；cwd RPC 与 branch 展示解耦，非 Git thread 仍可按 cwd 启动。 |

## 主要实现位置

- `apps/backend/src/runtime/codexWorkspaceTransitionManager.mjs`
- `apps/backend/src/runtime/gitWorkspaceManager.mjs`
- `apps/backend/src/runtime/workspaceRouteGuard.mjs`
- `apps/backend/src/runtime/workspaceTransitionBarrier.mjs`
- `apps/backend/src/utils/gitWorktreeInventory.mjs`
- `apps/backend/src/store/corptieStore.mjs`
- `apps/backend/src/server.mjs`
- `apps/macos/Sources/CopetsMac/BackendClient.swift`
- `apps/macos/Sources/CopetsMac/FloatingRootView.swift`
- `apps/macos/Sources/CopetsMac/SessionSettingsWindow.swift`
