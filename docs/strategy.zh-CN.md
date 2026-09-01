# Digital Employee 产品策略

[English](strategy.md)

本文是开源 `digital-employee` 仓库的权威产品契约。[路线图](roadmap.zh-CN.md)负责把这个
稳定方向转化为里程碑和工作项。实现状态应记录在[验证账本](verification.md)，不能混入
产品能力承诺。

## North Star

> Digital Employee 是一个本地优先、对话优先的数字组织工作台：把一个业务目录变成
> 一支可直接寻址的 AI 团队，拥有长期 Context 与权限边界。

工作台模型是产品本身，而不是一组命令的集合：

| 映射 | 含义 |
| --- | --- |
| 一个目录 = 一家企业 | `workspace init` 把本地目录变成业务工作区：组织树、岗位和业务 Context 区域。 |
| 一个岗位 = 一名可寻址数字员工 | `chat @position` 直接按名称寻址岗位；岗位 id 是跨会话、跨 Host 不变的稳定身份。每个新招岗位必须先配预算，变更才能生效。 |
| 一次对话 = 带岗位 Context 与权限边界的工作 | 对话只加载该岗位的 Context 切片，并在其 Authority Scope 内运行；越界请求被拒绝，而不是被悄悄放宽。 |
| 组织层级 = 业务负责人 → 数字员工 | 负责人看到业务全局、委派工作并对结果负责；员工只看到岗位被允许看到的切片。预算超限沿汇报线升级——汇报链与预算治理共用同一套升级机制。 |
| 长期 Context 地基 = mem + context | 决策和任务状态持久化到记忆平面（`mem`），会话文本被蒸馏进 context 图；新会话可以召回并继续，不依赖 Host 原生会话恢复。 |
| 内建引擎 = 默认 Host | 岗位运行在内建的、TypeScript 原生执行引擎上；外部 Agent Host 适配器只是选项，不是依赖。 |
| 开源塑造品牌；交易留在公司内部 | 开源仓库拥有工作台框架和对外叙事；市场、计费、结算和公司内部交易属于私有工作，不进入本仓库。 |

Digital Employee 不再实现另一套通用模型。岗位运行在内建的、TypeScript 原生执行
引擎上，它是工作台的默认 Host
（[Epic #165](https://github.com/bytefolk/digital-employee/issues/165)）；
外部 Agent Host 适配器只是选项，不是依赖。本仓库拥有工作台、岗位地址簿、权限边界、
长期 Context 通路和内建引擎。本机创建、校验和运行路径不依赖 marketplace。

`answer-agent` 与 `standalone-v1` 兼容运行时是历史上的首个员工用例，不是产品定义。
已发布的 `init` / `doctor` / `validate` / `eval` / one-shot `run` / `setup` /
绑定员工包的 `deploy` 命令校验员工包并执行有上限的本机运行；它们是工作台主线赖以
构建的地基，不是工作台本身。

### 内建执行引擎（默认 Host）

岗位运行在内建的、TypeScript 原生执行引擎上——独立设计的 clean-room 实现，覆盖
五层能力模型（prompt / context / harness / loop / graph），由
[Epic #165](https://github.com/bytefolk/digital-employee/issues/165)
跟踪。

- **S1 — 只读引擎核心：**回合契约执行、逐回合 Context 组装、带安全终止的 loop
  控制、结构性失败关闭和逐回合证据记录，已作为预览随公开根包 `0.6.0` 发布
  （最初随 `0.5.0` 发布）。`0.6.1` 源码包版本不增加运行时声明，也不能证明发布渠道
  可用；可用性必须以 release receipt 为准。
- **S2 — harness 层（M2–M3）：**审批事件、组织权限强制及可选 Context/Memory
  端口已有已发布预览切片；更广的工具分发、MCP 与沙箱仍在规划中。所有扩展都不得
  削弱 S1 的失败关闭基线。
- **S3 — graph 层（M4+）：**负责人到一个直接下属的显式委派已有 deterministic E3
  已发布预览；通用跨岗位路由、并行、递归与自主编排仍在规划中。

引擎叙事纪律：引擎独立原创。本仓库公开文档不点名任何第三方 agent 框架；能力决策
只引用本仓库自己的需求记录。

## 北极星指标：数字组织工作回路（Digital-Organization Work Loop）

一次**数字组织工作回路**是如下的经验证端到端回路：

1. `workspace init` 创建业务工作区，且每个生成的员工包通过 `validate`；
2. `org tree` 渲染带父子岗位的组织层级；
3. `chat @position` 在该岗位的 Context 切片与 Authority Scope 内完成一次有上限的
   对话，产出带引用的机器可读结果；有委派时产出可追溯的任务链；
4. 决策和任务状态带来源/任务出处持久化到记忆平面（`mem`），会话文本被收集用于
   context 蒸馏；
5. 新会话（可以在另一个 Host 上）召回同一岗位的记忆并能继续工作；
6. 组织变更后的 `org apply` 保留 Context 并重算权限 Scope，不发生静默扩张。

这个指标衡量工作台闭环。离线 fixture 上的 `eval` 通过只证明契约一致性，不证明真实
模型权益或响应质量；下文证据词汇约束关于该回路的一切声明。

## 三类直接用户与 JTBD

| 直接用户 | Job to be done |
| --- | --- |
| 业务负责人 | 把业务目录变成工作区，看到整个组织，向点名的岗位委派工作，并对结果负责。 |
| 岗位员工 | 被按角色寻址时响应，只在自己的 Context 切片与 Authority Scope 内操作，越界时把升级交回负责人而不是放宽范围。 |
| 集成者/运营者 | 把岗位绑定到已安装的 Agent Host，把决策和任务状态保存在记忆平面，并在组织变化时重算权限。 |
| 开源贡献者 | 理解哪些能力已发布、哪些是规划中，以及旧 Runner/部署轨的边界在哪里。 |

买家或最终用户会消费员工结果，但不是本开源框架的直接用户。市场账户、发现、租赁、
支付和结算仍属于公司内部私有工作。

## 产品范围

### 本开源仓库 In Scope

- 工作区命令面：`workspace init`、`org tree` / `org apply`、`chat @position`
  （第一里程碑由
  [Epic #155](https://github.com/bytefolk/digital-employee/issues/155)
  跟踪）；
- 组织模型 `organization.v1alpha1`、工作区元数据和岗位包引用；目录树就是组织结构
  图——工作区目录是企业，每个岗位是持有员工包的子目录，目录的父子关系就是汇报关系
  （#157）；
- 岗位预算治理：每个新招岗位必须先配预算，变更才能生效；预算上限由引擎 loop 层
  执行；预算超限沿汇报线升级（#157）；
- 岗位权限边界：Context Scope（岗位可以召回的业务切片）与 Authority Scope（岗位
  可调用的工具），owner/worker 默认档位，无静默继承；
- 长期 Context 集成：`mem` R1 级记忆平面写入与召回，加上基于规则的 `context` 事实
  蒸馏，将持续性与 Host 原生会话恢复解耦；
- 作为默认 Host 方向的内建 TypeScript 原生执行引擎（S1/turn 核心已有已发布预览；
  完整 Workbench 路径仍在交付），外部 Agent Host 适配器保留为选项（#165）；
- 已发布的员工包、Skill、Schema、eval 与 Host Adapter 契约，以及 `init` /
  `doctor` / `validate` / `eval` / one-shot `run` / `setup` / 绑定员工包的
  `deploy`，工作台在其之上构建；
- 包摘要、单次密封快照、标准事件、签名回执，以及本地框架边界上的审计/脱敏/
  可观测性；
- 让每条公开声明保持诚实的验证账本和证据词汇。

### 本开源仓库 Out of Scope

- 替代 Agent Host 的模型接入与商业服务；内建引擎在本机执行岗位，外部 Host 适配器
  保留为选项；
- 云端托管员工包、Agent Host、模型账号、凭证或应用/服务机器人；
- marketplace 账户、上架、发现、排序、评价、租赁、动态定价、Quote、Credit、计费、
  结算或任何公司内部交易——这是私有工作（见下方边界）；
- 第一里程碑的渠道扩张（Lark #77 / WeCom #78）；第一里程碑只有 CLI；
- 完整 RBAC 系统；第一里程碑交付 owner/worker 默认档位加显式权限白名单派生；
- 把 Host 原生会话恢复作为必要条件；长期连续性每回合从 `mem` + `context` 重建
  （#102）；
- 在核心中硬编码文档、网盘、DWS 或业务系统集成；这些能力通过显式 MCP、connector
  或 adapter 边界接入；长期 Context 通过显式记忆平面边界接入；
- 在 runtime package 中引入 React、design system 或 marketplace UI。

## 与旧主线（Runner / 安全 / 部署治理）的边界

此前的公开主线是 **Builder → Seller Runner → Trusted execution**
（[Epic #25](https://github.com/bytefolk/digital-employee/issues/25)）。
2026-08-14 的战略决策把产品主线切换到**本地数字组织工作台**
（[Epic #155](https://github.com/bytefolk/digital-employee/issues/155)），
2026-08-23 的决策记录
[#164](https://github.com/bytefolk/digital-employee/issues/164)
确定了旧轨处置台账。

- 旧轨道**已收尾，不再扩展**：已发布的地基（`init`/`validate`/`eval`/`run`、员工包
  契约、Host Adapter、预览 Runner 内核）继续受支持，是新主线的底座。旧轨不再新增
  能力。
- 每个 open 旧轨 issue 都在[路线图](roadmap.zh-CN.md)中拥有明确的
  **KEEP / REPURPOSE / PARK** 处置，以 #164 批准的台账为准：**KEEP 11 /
  REPURPOSE 9 / PARK 5**。执行已完成：PARK issue 已以 not planned 关闭；
  REPURPOSE issue 已附处置评论并保持开放；KEEP issue 未做任何动作。处置是记录，
  不是破坏：不批量改写 issue，也不悄悄丢弃任何 issue。
- 私有市场叙事不变，留在公司内部：开源仓库永不实现上架、定价、计费、结算或公司
  内部交易。

## 实践路径

### 当前源码已经支持

1. 构建 `0.6.1` 源码 checkout，或安装已记录的公开 `0.6.0` 版本；源码和打包制品
   不能证明 `0.6.1` 可用，可用性必须以 release receipt 为准。
2. 用 `init` 创建并校验员工包，再用 `doctor --engine` 做有上限的本机 Host 诊断；
   这些步骤不能证明模型权益可用。
3. 显式提供部署凭证后，用 `run --engine` 发起一次真实的本机 one-shot Agent/模型
   执行；它可能消耗供应商额度。
4. 用绑定员工包的 `deploy` 命令，在文档化的失败关闭边界内，把经过校验的员工包绑定
   到诚实的本地部署结果。
5. 用 `workspace init --template oss-maintainer` 创建工作区骨架（`0.6.0` 已发布
   预览，最初随 `0.5.0` 发布；目标目录必须不存在或为空，其他情况失败关闭）。
6. 用已发布预览 `org tree` / `org apply` 查看并应用组织；turn 引擎、有界显式
   委派、权限强制及可选 Memory/Context 端口只能在各自文档化预览边界内使用。

`chat @position`、持久化 Workbench/UI、可生产使用的长期记忆与 context 蒸馏，以及
完整默认 Host 旅程仍由
[Epic #155](https://github.com/bytefolk/digital-employee/issues/155) 和
[Epic #165](https://github.com/bytefolk/digital-employee/issues/165)
规划。已发布的 Memory/Context 接缝为可选能力，不代表完整产品闭环。精确证据以
[验证账本](verification.md)为准。

### 目标端到端路径（新主线）

1. 用户运行 `workspace init ./<business> --template oss-maintainer`，得到带组织树和
   岗位员工包的工作区。（`0.6.0` 已发布预览。）
2. 用户用 `org tree` 查看组织：谁可寻址、每个岗位能看到什么、能做什么。
   （`0.6.0` 已发布预览；完整 Workbench 展示仍在规划中。）
3. 用户向 `chat @repo-owner`（owner 委派、worker 执行）或 `chat @issue-researcher`
   （窄 Context、窄权限）提问，得到带引用和可追溯委派链的结果。（`chat` 仍在
   规划中；底层显式单跳委派接缝已有已发布预览。）
4. 决策和任务状态持久化到 `mem` 记忆平面；会话文本被收集用于 `context` 蒸馏。
   （可选召回接缝已有已发布预览；持久化与蒸馏仍在规划中。）
5. 新会话或新 Host 召回同一岗位的记忆并继续工作。（有界引擎召回接缝已发布；
   端到端 Workbench 连续性仍在规划中。）
6. 组织变更通过 `org apply` 完成：Context 保留，权限 Scope 重算且不发生静默扩张；
   没有配齐预算的招聘失败关闭。（`org apply`、权限派生和静态招聘校验已有已发布
   预览；完整变更工作流仍在规划中。）

## 里程碑契约

路线图负责日期和 Issue 归属。以下用户结果和 gate 定义稳定推进顺序。

### W1 — Workspace closed loop（第一里程碑，截止 2026-09-30）

引擎 S1（#165）与工作区子项 I-01..I-07 对齐到本里程碑。

**用户结果：**用户把一个业务目录变成可直接寻址的 AI 团队，并端到端复现首个
showcase 案例（oss-maintainer）：`workspace init` → `org tree` →
`chat @position`（owner 与 worker 路径）→ `mem` 持久化 → 新会话召回。

**Gate：**

- `workspace init ./oss-maintainer --template oss-maintainer` 在干净机器上成功，且
  每个生成的员工包通过 `validate`；
- `org tree` 渲染层级，其 JSON 输出通过 `org-tree.v1` schema 检查；
- `chat @repo-owner` 产出 `user → owner → worker` 任务链，且
  `chat @issue-researcher` 证明其 Context 切片是窄的（业务全局事实不泄漏进
  `contextUsed`）；
- 越界请求被拒绝，返回把用户指回负责人的稳定错误；未绑定岗位失败关闭；
- 对话结束后，`mem` 中存在带来源/任务出处的岗位决策记录，且新会话能召回并复述；
- `org apply` 保留 Context 并重算权限 Scope；没有配齐预算的招聘以稳定错误失败
  关闭；
- 四个 oss-maintainer 员工包在内建引擎上端到端运行，零外部 Host、零凭证，演示一次
  强制的预算/doom-loop 终止，每个回合携带符合 #140 标准的证据记录
  （#165 AC-001..AC-004）；
- 所有声明使用下文证据词汇，只有 fixture 的路径不得写成 live-qualified。

**非目标：**渠道（只有 CLI）、市场/交易工作、完整 RBAC、Host 原生会话恢复，以及
任何削弱 S1 结构性保证的行为。

### M2–M3 — Context 深度、组织生命周期与引擎 harness

**用户结果：**工作台持续学习：会话文本被蒸馏成基于规则的实体图，`org apply` 成为
变更组织的可信方式，引擎在只读核心之上长出 harness 层。

**Gate：**基于规则的 `context` 蒸馏（#162）幂等并驱动窄切片召回；`org apply` 审计
组织变更；mem 召回进入生产使用（#161）；引擎 S2 harness 层（工具分发、MCP client、
审批门、沙箱、岗位权限边界的运行时强制）在 S1 零工具基线之上扩展而不削弱它
（#165）。渠道输出渲染（#160）由本次 pivot 之外负责，不是这里的门槛。

**非目标：**渠道扩张、市场/交易工作、完整 RBAC。

### M4+ — 引擎 graph 层

引擎 S3 graph 层提供组织模型之上的跨岗位路由、并行与委派编排，每一跳都带权限检查
（#165）。规划中；范围在 M2–M3 关闭后才锁定。

### 旧路线收尾

旧 Runner/部署/安全轨道不是新主线上的里程碑。其 open issue 在
[路线图](roadmap.zh-CN.md)中拥有明确处置——KEEP（加入新主线）、REPURPOSE（改道到
工作台/引擎线）或 PARK（以 not planned 关闭，保留复活条件）。#164 批准的台账已经
执行完毕；不再安排新的旧轨能力。

## 证据成熟度词汇

文档、Issue 和 release note 必须明确使用下列一个或多个词，不能从较弱证据推断更强
状态。

| 词汇 | 含义 |
| --- | --- |
| **shipped** | 已实现并存在于明确的源码版本或已发布制品中。必须说明是哪一种；shipped 不代表完成真实供应商验收或已达生产级。 |
| **preview** | 已实现，可用于评估，但仍有明确生产属性缺口、兼容范围限制或变更风险。 |
| **fixture-conformant** | 锁定版本的 Adapter/协议路径通过仓库维护的确定性 fixture；它不是厂商认证、真实认证、模型权益验证或商业资质。 |
| **live-qualified** | 一个明确、锁定的集成路径已在批准环境中使用真实供应商/服务凭证完成有记录的测试，并覆盖声明的策略和清理 gate；它不授予转售权，也不代表所有版本。 |
| **design** | 已评审目标、契约或决策，不代表存在可执行实现。 |
| **private** | 在本公开仓库之外实现或规划。公开接口可以引用它，但本仓库不得宣称或并入其实现。 |

适用时继续使用 `unsupported` 或 `probe-only`；它们不是 preview 的同义词。即使达到
live-qualified，无人值守运行或转售的法律权限仍是独立商业 gate。

## 新需求归属判断

新增需求或 Issue 前，按顺序回答：

1. 它是否帮助用户把目录变成业务工作区、寻址岗位、用 Context 与权限约束对话，或在
   会话之间保持长期 Context？如果是，可能属于新主线。
2. 它是否作为已发布的地基工作，在本机上定义、校验、打包、运行或观测员工？如果是，
   属于开源框架。
3. 它是否拥有 marketplace 身份、上架、发现、评价、租赁、Quote、Credit、计费、支付
   或结算状态，或任何公司内部交易？如果是，属于私有工作。
4. 它是否实现服务端设备注册、任务分发、`UsageVerifier` 或结算？如果是，属于私有
   工作；本仓库只保留互操作客户端/协议边界。
5. 它是否创建另一套模型或工具循环？内建引擎是工作台的默认执行路径；不要在它外面
   再加一层循环。新的岗位能力通过引擎能力模型切片进入（先 S1 只读核心）；外部
   Agent Host 集成通过版本锁定适配器进入，不能进入可移植员工包契约。
6. 它是否为厂商专用逻辑？把强制策略和投影放入版本锁定 Host Adapter，不能进入可移植
   员工包契约。
7. 它是否为渠道（Lark/WeCom）、文档、网盘、DWS 或业务能力？优先使用显式
   MCP/connector/adapter 扩展，不能成为核心依赖，渠道扩张不进入第一里程碑；长期
   Context 通过记忆平面边界接入。
8. 它是否是 UI？本机运维 UI 可以消费公开 API，但不能进入 runtime package；
   marketplace UI 属于私有平台。
9. 它当前属于哪个证据词汇，需要什么可观测 gate 才能晋级？没有答案，就不能宣称完成。
10. 它是否会把员工包字节、本地路径、Host 凭证或私有 chain-of-thought 发送给私有
    服务？如果是，拒绝。

跨边界需求应在公开协议处拆开，不能把开源框架工作和公司内部交易状态放进同一个 Issue
或实现。
