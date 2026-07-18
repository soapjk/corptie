---
title: Corptie Session 生命周期监督器设计
date: 2026-07-18
updated: 2026-07-18
tags:
  - Corptie
  - 产品设计
  - Agent 生命周期
  - 持续运行
  - Codex
status: proposed
---

# Corptie Session 生命周期监督器设计

## 1. 文档结论

Corptie 应把“持续运行”实现为一个全局的 **Session Lifecycle Supervisor（会话生命周期监督器）**。

它是全局服务，但不是常驻、可对话的“总 Agent”。监督器监听所有 Session 的生命周期，只在需要判断任务是否完成时临时启动一次只读的 Codex 评审；如果任务尚未完成，就通过现有统一工作队列让原 Agent 继续执行。

~~~text
用户打开“持续运行”
        │
        ▼
记录监督策略与原始目标
        │
        ▼
原 Agent 正常执行一个 Turn
        │
        ▼
收到 turn/completed
        │
        ▼
创建一次临时监督评估
        │
        ├─ COMPLETE ───────► 关闭本轮监督，通知用户
        ├─ CONTINUE ───────► 生成下一步指令并进入原 Agent 队列
        ├─ WAITING_USER ───► 暂停持续运行，等待用户
        ├─ BLOCKED ────────► 暂停并展示阻塞原因
        └─ LIMIT_REACHED ──► 停止并提示达到运行上限
~~~

只有原 Session 执行实际任务。监督器不修改代码、不调用业务工具、不替用户批准任何操作。

## 2. 为什么不创建常驻总 Agent

常驻总 Agent 会产生以下问题：

- 需要维护所有 Session 的长上下文，成本持续增长；
- 成为所有 Agent 的单点瓶颈；
- 重启后难以保证内部记忆与数据库一致；
- 容易与现有 Agent 身份、Session 和 collaboration task 混淆；
- 用户难以判断是谁修改了任务或发出了指令。

更合适的结构是“确定性状态机 + 临时智能判断”：

- 全局部分负责生命周期、幂等、排队、预算和恢复；
- 临时 Agent 只负责语义化的完成判断；
- 每次评估都从数据库重建必要上下文；
- 临时评估失败不污染原 Session；
- 多个 Session 独立运行，不共享认知状态。

这里的“全局”指全局调度与策略，不是一个全局聊天人格。

## 3. 与现有系统的关系

监督机制复用现有统一 `agent_work_items` 队列，但不复用 peer collaboration task 的业务语义。

原因是：

- peer collaboration 表达两个独立 Agent 之间的责任协作；
- lifecycle supervision 表达 Corptie 对同一个 Session 的执行控制；
- 临时评审器不是服务所有者，也不是协作任务参与者；
- continuation 不应伪装成用户消息或另一个 Agent 的请求。

Codex App Server 已提供可靠的 `turn/completed`、thread resume、turn ID、结构化 item、文件变化与 diff 信息，可以作为第一版接入点。

## 4. 生命周期状态机

用户界面可以只显示一个开关，但后端必须保存完整状态：

~~~text
disabled
armed
evaluating
continuation_queued
running
waiting_user
blocked
completed
stopped
exhausted
error
~~~

典型流转：

~~~text
disabled → armed → running → evaluating
evaluating → continuation_queued → running
evaluating → completed
evaluating → waiting_user
evaluating → blocked
evaluating → exhausted
~~~

用户关闭开关时：

- 状态变为 `stopped`；
- 取消尚未开始的监督评估；
- 取消尚未执行的自动 continuation；
- 不影响用户消息和 Agent collaboration 消息；
- 不默认中断已经运行的主 Agent Turn。

“停止持续运行”和“中断当前 Agent”应保持为两个不同操作。

## 5. 数据模型

### 5.1 session_supervisions

保存一个 Session 当前的监督策略：

~~~sql
CREATE TABLE session_supervisions (
  session_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,

  objective TEXT NOT NULL,
  objective_source_turn_id TEXT,
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',

  cycle_count INTEGER NOT NULL DEFAULT 0,
  max_cycles INTEGER NOT NULL DEFAULT 12,
  max_duration_seconds INTEGER,
  started_at TEXT,
  deadline_at TEXT,

  last_evaluated_turn_id TEXT,
  last_verdict TEXT,
  last_reason TEXT,
  last_error TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
~~~

`generation` 用于处理竞态。每次用户关闭、重新打开或修改任务目标时递增；迟到的评估结果如果 generation 不匹配，必须直接丢弃。

### 5.2 supervision_evaluations

保存评估记录、审计信息与幂等状态：

~~~sql
CREATE TABLE supervision_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  target_turn_id TEXT NOT NULL,

  status TEXT NOT NULL,
  verdict TEXT,
  confidence REAL,
  reason TEXT,
  remaining_work_json TEXT,
  next_instruction TEXT,

  evaluator_thread_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  error TEXT,

  UNIQUE(session_id, generation, target_turn_id)
);
~~~

同一个 `turn/completed` 即使重复通知，也只能产生一次评估。

### 5.3 agent_work_items

现有 `kind` 应增加：

~~~text
lifecycle
~~~

不要把监督指令伪装成用户消息。建议优先级：

| 来源 | 优先级 |
|---|---:|
| 用户消息 | 100 |
| Agent collaboration | 50 |
| 生命周期 continuation | 20 |

生命周期消息使用 `local_visibility = status_only`，不作为普通用户对话气泡展示，但应进入可审计的运行记录。

## 6. 临时 Codex 评审

每次评估创建一个短生命周期、用户不可见的 Codex thread，输入只包含完成判断所需的信息：

- 原始任务目标；
- 明确的验收条件；
- 本轮 Agent 最终回复；
- 最近几轮关键消息；
- 本轮文件变更摘要；
- 测试和命令结果；
- 当前待审批、待选择或阻塞状态；
- 已执行轮数和剩余预算。

不应默认发送整个仓库、完整聊天历史或所有文件内容。

临时评审应使用：

- 只读 sandbox；
- 禁止写文件；
- 禁止发送 collaboration 消息；
- 禁止外部发布或上传；
- 禁止代替用户批准；
- 较低成本模型或推理级别；
- 强制结构化 JSON 输出。

建议输出协议：

~~~json
{
  "verdict": "continue",
  "confidence": 0.91,
  "reason": "Implementation exists, but tests have not been run.",
  "evidence": [
    "Agent reports three files changed",
    "No successful test result is present"
  ],
  "remaining_work": [
    "Run the relevant backend tests",
    "Fix failures if any"
  ],
  "next_instruction": "Continue the original task. Run the relevant backend tests, fix failures, and verify the requested behavior before concluding."
}
~~~

允许的裁决值：

~~~text
complete
continue
waiting_user
blocked
failed
~~~

评审 thread 不注册为普通 Corptie Agent，也不出现在 Session 列表中。完成后可以归档其本地展示记录。

由于临时评审意味着额外把任务摘要发送给模型服务，产品应在首次启用该能力或全局设置中明确说明数据范围和服务目的。完成一次授权后，日常使用仍然可以只是一个开关。

## 7. 完成判断原则

不能只看 Agent 是否声称“完成”。评审应按以下证据判断：

1. 用户明确的验收条件是否全部满足；
2. 请求的文件或功能是否确实存在；
3. 是否有测试、构建或其他验证证据；
4. 是否仍有 TODO、已知失败或未处理步骤；
5. Agent 是否正在询问一个必须由用户决定的问题；
6. 是否需要审批、授权、密码或外部发布确认；
7. 是否只完成了计划中的中间步骤。

以下输出通常应判为 `continue`：

- “我已经完成第一步”；
- “接下来可以运行测试”；
- “实现已完成，但尚未验证”；
- “还需要更新前端”；
- “由于时间原因先到这里”。

以下情况应判为 `waiting_user`：

- 存在多个会显著改变结果的产品选择；
- 等待用户审批或凭据；
- 请求执行外部上传、推送、部署或发送消息；
- 需要扩大原始任务范围；
- Agent 遇到无法自行解除的业务阻塞。

## 8. Continuation 协议

监督器不应只发送“请继续”，而应给出已完成部分、未完成部分、本轮动作和验证要求。

~~~text
<corptie_lifecycle_event>
type: continue_task
supervision_id: ...
generation: 3
previous_turn_id: ...

Continue toward the original user objective.

Verified progress:
- Backend endpoint has been implemented.
- Store migration has been added.

Remaining work:
- Add the macOS toggle.
- Add restart-recovery tests.
- Run the backend and Swift test suites.

Do not repeat completed work. Stop and wait for the user if approval,
credentials, external publishing, or a material product decision is required.
</corptie_lifecycle_event>
~~~

目标 Agent 的 developer instructions 应声明：该事件来自 Corptie 生命周期机制，是任务延续信号，不是新的用户授权。

## 9. 用户消息抢占

用户消息到达时：

1. 用户消息正常以优先级 100 入队；
2. 监督 generation 加一；
3. 取消旧 generation 尚未运行的 continuation；
4. 正在执行的旧评估返回后因 generation 失效而被丢弃；
5. 用户新消息作为目标补充或修正；
6. 新 Turn 完成后再基于更新后的目标继续监督。

这可以避免用户已经纠正方向，旧评估却仍要求 Agent 按旧目标继续执行。

## 10. 熔断与预算

持续运行不能等于无限运行。默认应提供：

- 最大自动续跑次数，例如 12 次；
- 最大持续时间，例如 2 小时；
- 连续两轮没有文件、测试或其他有效进展时暂停；
- 连续两次生成高度相似的 continuation 时暂停；
- 同一错误连续出现 3 次时暂停；
- 临时评审连续失败 3 次时关闭自动续跑；
- 上下文或用量接近限制时暂停；
- Session 被用户中断、删除或归档时立即停止；
- 出现审批或外部操作时立即等待用户。

## 11. 用户界面

开关可放在 Session 详情页顶部和 Session 右键菜单中：

~~~text
持续运行
让 Corptie 在每个步骤完成后检查任务，并在尚未完成时自动继续。
~~~

开启后不创建新的聊天窗口，只展示轻量状态：

- 持续运行已开启；
- 正在检查是否完成；
- 已自动继续第 3 次；
- 等待你的决定；
- 任务已验证完成；
- 已达到运行上限。

监督判断不进入普通对话气泡，但应提供可展开的运行记录，使用户能够理解自动续跑原因。

## 12. API 与事件

最小 API：

~~~http
PUT /sessions/:sessionId/supervision
Content-Type: application/json

{
  "enabled": true,
  "maxCycles": 12
}
~~~

查看评估记录：

~~~http
GET /sessions/:sessionId/supervision/evaluations
~~~

Session snapshot 和 SSE 中应包含监督状态。建议事件：

~~~text
SessionSupervisionEnabled
SessionSupervisionEvaluationStarted
SessionSupervisionVerdictProduced
SessionSupervisionContinuationQueued
SessionSupervisionPaused
SessionSupervisionCompleted
SessionSupervisionStopped
SessionSupervisionExhausted
~~~

## 13. 第一版范围

第一版只支持 Corptie 管理的 Codex App Server Session，因为它已经具备可靠的：

- `turn/completed`；
- thread resume；
- turn ID；
- structured item；
- file change 与 diff 信息；
- 统一消息队列。

PTY Session 对回合结束的判断更依赖终端提示符和文本启发式，容易过早触发。Claude SDK 可以在第二阶段接入其明确的 turn completion 回调。

## 14. 实施顺序

### 第一阶段：确定性基础设施

- 新增监督数据表和状态机；
- 新增开关 API；
- 在 `turn/completed` 后创建评估；
- 使用固定规则模拟 verdict；
- 验证幂等、重启和竞态。

### 第二阶段：临时 Codex 评审

- 接入临时 Codex 评审；
- 强制结构化输出；
- 生成 `lifecycle` continuation；
- 加入次数、时间和无进展熔断。

### 第三阶段：产品界面

- macOS 开关和状态展示；
- 运行记录；
- 用户消息抢占和目标修正。

### 第四阶段：扩展能力

- 支持 Claude SDK；
- 评估成本策略；
- 可配置验收条件和高级运行预算。

## 15. 必测场景

- 未完成时只续跑一次，不重复入队；
- 完成时不再创建 Turn；
- 等待审批时不自动回答；
- 用户纠正指令能使旧评估失效；
- 后端重启后不会重复续跑；
- 重复 `turn/completed` 保持幂等；
- 达到次数上限后可靠停止；
- 主 Agent 失败和评审 Agent 失败互不污染。

## 16. 最终原则

这套机制在产品上表现为一个开关；内部实现是：

> 持久化状态机 + 回合完成事件 + 临时语义评审 + 现有统一工作队列。

它提供全生命周期管理能力，但不引入难以控制的常驻总 Agent，也不改变现有对等 Agent 协作机制的责任边界。
