# engine.v1 ↔ codex Op/Event 语义映射（clean-room 设计文档）

状态：设计参照文档（landed；§4 approval.* 词表行已随 issue #187 审批契约实施 PR 定稿）
日期：2026-08-25
作者：技术 P9
指令来源：战略 CEO（胡总定 github.com/openai/codex 为参照系）
配套契约：approval 三事件契约（terminal-and-resume，Option 1）已实施——词表单一来源 contracts.ts，结算码 engine.approval_required / engine.approval_denied / engine.approval_expired / engine.approval_preview_invalid

## 0. Clean-room 声明

- 参照对象：openai/codex 公开仓库（Apache-2.0）`codex-rs/protocol` 的**类型形态**（Op / EventMsg / approval 相关结构），仅借形态、不抄代码、不复制字段序列化细节。
- engine.v1 词表是独立定义的自有词汇（见 contracts.ts 协议头注释）；本文是 repo 规范所指的"覆盖映射仅维护在内部设计文档"的那份文档。
- 本文不引入任何对 codex 运行时行为的依赖或兼容承诺；对位关系只服务于团队内部的设计沟通与词表演进决策。

## 1. 双方通信模型对比（形态层）

| 维度 | engine.v1（本仓） | codex（参照） |
| --- | --- | --- |
| 入站 | 密封 turn envelope，一次性，stdin | Op 枚举，持续双向通道（TurnInput / ExecApproval / …） |
| 出站 | EngineEvent NDJSON 流 | Event{EventMsg} 流 |
| 终态 | 恰好一个可信终态（completed/failed） | TurnComplete / TurnAborted（另有挂起/恢复语义） |
| 裁决回注 | 无运行中通道；经下一次密封 envelope（见 approval 草案 Option 1） | 运行中 Op::ExecApproval / PatchApproval 直接回注 |

**核心形态差异**：codex 是会话式双向协议；engine.v1 是批处理式单向协议。所有映射以该差异为前提，不做等价假设。

## 2. 事件对位表

| engine.v1 | codex 参照形态 | 语义对位说明 |
| --- | --- | --- |
| run.started | EventMsg::TurnStarted | run/turn 开始声明。codex 附带更多会话上下文，engine 只声明 runId |
| model.delta | EventMsg::AgentMessageContentDelta | 增量文本。engine 不区分 message/reasoning 两路 delta |
| usage | EventMsg::TokenCount | token 计量。engine 绑定预算账本（turn/position 双维） |
| run.completed | EventMsg::TurnComplete | 成功终态。engine 携带 output + terminalReason=goal_met |
| run.failed | EventMsg::Error / TurnAborted | 失败终态。engine 用自有 TerminalReason 枚举，见 §3 |
| （无） | EventMsg::SessionConfigured / EnvironmentConnected | codex 有会话/环境生命周期事件；engine 无会话概念，不借 |
| （无） | EventMsg::AgentReasoning* | 推理流；engine 当前不建模，非目标 |
| （无） | EventMsg::ContextCompacted | 上下文压缩；engine 的对应能力在 context-assembler，暂不发事件 |
| （无） | EventMsg::ExecCommandBegin/End、PatchApply* | 工具执行生命周期；engine 经 agent-host 适配器侧事件表达，不在 engine 词表 |

## 3. TerminalReason 对位（自有枚举，不翻译外部枚举）

contracts.ts 已声明 TerminalReason 是本仓自有枚举、不是外部枚举的翻译。以下为**覆盖关系**（coverage）而非翻译：

| engine.v1 TerminalReason | codex 最近似形态 |
| --- | --- |
| goal_met | TurnComplete（正常完成） |
| invalid_output_exhausted | 无直接对应（codex 无同步 outputSchema 校验环） |
| turn_budget_exceeded / position_budget_exceeded | TokenCount 超限后的 TurnAborted（codex 不区分 turn/position 两级账本） |
| iteration_cap | 无直接对应 |
| doom_loop | 无直接对应（本仓 doom-loop 检测为自有能力） |
| deadline_exceeded | TurnAborted（超时路径） |
| cancelled | TurnAborted / Op::SuspendTurnAndShutdown |
| permission_denied | 无直接对应（#159 权限强制：越权请求在模型消耗前失败关闭） |
| memory_unavailable | 无直接对应（codex 无持久记忆平面；required 模式持久记忆不可用的可重试结算） |
| memory_denied | 无直接对应（召回被拒/作用域不匹配/记录畸形/配置无效的双模式 fail-closed 结算） |
| engine_internal_error | StreamError / Error |

结算语义注记（权限强制，#159）：权限强制在引擎执行链两层执行（模型消耗前预检 + 派发时检查），消费 `org apply` 重算的单一强制件 `permissions.json`（org-permissions.v1）。越权上下文读以 `workspace_org_context_denied` 结算、越权工具调用以 `workspace_org_authority_denied` 结算、未知岗位以 `workspace_org_position_unknown` 在生命周期事件发出前结算；拒绝一律携带 `redirectTo=owner`。拒绝尝试入回合证据（positionId、请求的路径或工具名、稳定码、指向），绝不携带被拒资源的内容；重复拒绝不升级、不自动重试。权限拒绝族（`workspace_org_*`）与审批结算族（`engine.approval_*`）正交并存。工件缺失/畸形以 `engine.permissions_invalid` 在模型消耗前失败关闭。

结算语义注记（memory 接缝，#180）：记忆召回接缝在任何 model 消耗之前执行，默认停用、显式启用才召回，作用域由钉住的 MemoryPort 绑定透传、不接受回合输入供给或放宽。optional 模式仅把类型化 `MEMORY_UNAVAILABLE` 故障转为空召回 + 一条警告、回合照常进行；required 模式故障以 `engine.memory_unavailable`（retryable=true）结算；拒绝/作用域不匹配/记录畸形/配置无效/线协议版本异常在两种模式下统一 `engine.memory_denied`（retryable=false）fail-closed。证据仅记召回条目摘要/定位符/状态版本/字节计数，绝不记原文。

## 4. approval 语义对位（已实施词表，单一来源 contracts.ts）

| engine.v1（已实施） | codex 参照形态 | 差异说明 |
| --- | --- | --- |
| approval.requested | EventMsg::ExecApprovalRequest、ApplyPatchApprovalRequest、ElicitationRequest（部分） | codex 按动作类型分多个事件并带 call_id/approval_id 双层标识；engine 用单一事件 + 单层 approvalId + action.kind 判别。请求 turn 以 run.failed(engine.approval_required, retryable=true) 结算；preview 前置 fail-closed（engine.approval_preview_invalid） |
| approval.granted | Op::ExecApproval 携带 ReviewDecision::Approved / ApprovedForSession | codex 是入站回注；engine 是恢复 turn 的出站权威记录（单向模型决定），裁决经下一次密封 envelope 的 pendingApproval 传入，消费在任何 model 消耗之前 |
| approval.denied | Op::ExecApproval 携带 ReviewDecision::Denied / Abort | codex 的 Abort（放弃整个会话回合）不单独建模；engine deny 后按 engine.approval_denied（retryable=false）结算，不降级为未审批写入，证据记录携带 approvalRef |
| （不做） | ReviewDecision::ApprovedExecpolicyAmendment（批准并修订策略） | 策略修订超出本 slice；engine 侧策略变更走组织模型决议链，不走运行时事件 |
| （不做） | EventMsg::GuardianAssessment（安全评估中间层） | 非目标；engine 的 fail-closed 由 policy 投影承担 |

结算语义注记：approval 族终态复用既有 TerminalReason 枚举（cancelled，操作方可见的受治理停止），不新增终态原因；过期/缺失/畸形裁决统一 fail-closed 于 engine.approval_expired，与 denied 同族但错误码可区分（便于上报统计）。

## 5. 明确不借的形态（非目标清单）

realtime 语音会话、Thread 回滚（ThreadRollback/TurnDiff）、计划流（PlanUpdate/PlanDelta）、MCP 生命周期（McpStartup*/McpToolCall*）、协作代理事件（Collab*）、Review 模式（Entered/ExitedReviewMode）、Hook 事件、RawResponseItem 透传。以上 codex 形态在 engine.v1 演进中被显式排除出本参照系借用范围；未来如需引入，单独立 issue 并更新本文。

## 6. 治理结论

1. engine.v1 保持自有词表与单向批处理模型；codex 仅作为 approval 三事件的**语义参照**。
2. 双向回注通道（codex Op 模型）不在当前演进路线内——对应 approval 草案 Option 2 被暂挂。
3. 本文作为设计参照先行落库（战略 CEO 派单：文档先行）。约束保持：任何 engine.v1 词表变更（含 approval 三事件实施）必须在同一 PR 内同步更新本文对应行，维持"词表变更与映射文档同 PR"的单一来源纪律。
