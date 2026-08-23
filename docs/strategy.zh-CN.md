# Digital Employee 产品策略

[English](strategy.md)

本文是开源 `digital-employee` 仓库的权威产品契约。[路线图](roadmap.zh-CN.md)负责把这个
稳定方向转化为里程碑和工作项。实现状态应记录在[验证账本](verification.md)，不能混入
产品能力承诺。

## North Star

> Digital Employee 是一个本地优先、对话优先的数字组织工作区：把一个业务目录变成一支
> 可直接点名、具有长期 Context 和权限边界的 AI 团队。

工作区模型才是产品本身，而不是一堆命令：

| 对应关系 | 含义 |
| --- | --- |
| 一个目录 = 一项业务 | `workspace init` 把一个本地目录初始化为带组织树、岗位和业务 Context 目录的业务工作区。 |
| 一个岗位 = 一个可寻址数字员工 | `chat @岗位` 直接点名某个岗位；岗位 id 是跨会话、跨 Host 保持不变的稳定身份。 |
| 一次对话 = 带岗位 Context 与权限边界的工作 | 每轮对话只加载该岗位的 Context 切片，并在其 Authority Scope 内执行；越权请求被拒绝，而不是静默扩权。 |
| 组织层级 = 业务负责人 → 数字员工 | 负责人看到业务全局，负责委派与汇总并对结果负责；具体员工只看到自己职责范围内的切片。 |
| 长期 Context 底座 = mem + context | 决策与任务状态写入记忆平面（`mem`），会话原文进入 context 图谱蒸馏；新会话无需 Host 原生续接即可召回续接。 |
| 开源打品牌、交易留在公司内 | 开源仓库拥有工作区框架与公开叙事；marketplace、计费、结算和公司内交易属于私有工作，不进入本仓库。 |

Digital Employee 不再实现另一套通用模型或工具循环。选定的 Agent Host 负责模型、
上下文和原生 Agent loop；本框架负责工作区、岗位通讯录、权限边界和长期 Context 路径。
本机创建、校验和运行路径不依赖 marketplace。

`answer-agent` 和 `standalone-v1` 兼容运行时是历史上的首个员工用例，不是产品定义。
已发布的 `init` / `doctor` / `validate` / `eval` / one-shot `run` / `setup` /
package-bound `deploy` 负责校验员工包并执行有边界的本机运行；它们是工作区主线的基础，
不是工作区本身。

## 北极星指标：数字组织工作回路（Digital-Organization Work Loop）

一次**数字组织工作回路**必须同时满足：

1. `workspace init` 创建业务工作区，且生成的每个员工包通过 `validate`；
2. `org tree` 渲染带父子关系的组织层级；
3. `chat @岗位` 在该岗位的 Context 切片与 Authority Scope 内完成一次有边界的对话，
   产出带出处的机器可读结果；如有委派，任务责任链可追踪；
4. 决策与任务状态写入 `mem` 记忆平面（带 source 与 task 出处），会话原文进入
   context 采集；
5. 新会话（可换 Host）召回同一岗位记忆并可以续接工作；
6. 组织调整后 `org apply` 保留 Context、重算权限范围，且不静默扩权。

这个指标衡量工作区闭环。离线 fixture 上的 `eval` 通过只证明契约一致性，不证明真实
模型权益或回答质量；所有关于回路的宣传都必须遵守下文证据词汇。

## 三类直接用户与 JTBD

| 直接用户 | Job to be Done |
| --- | --- |
| 业务负责人 | 把一个业务目录变成工作区，看到整个组织，向具名岗位委派工作，并对结果负责。 |
| 岗位员工 | 被按角色点名时作答，只在其 Context 切片与 Authority Scope 内操作；越权时把升级交还给负责人，而不是自己扩权。 |
| 集成者/运营者 | 把岗位绑定到已安装的 Agent Host，让决策与任务状态落在记忆平面，并在组织变化时重算权限。 |
| 开源贡献者 | 知道哪些能力已发布、哪些在规划中，以及与新主线之外旧 Runner/deploy 路线的边界。 |

买家或最终用户会消费员工结果，但不是本开源框架的直接用户。marketplace 账户、发现、
租赁、支付与结算仍是公司内部私有工作。

## 产品范围

### 本开源仓库 In Scope

- 工作区命令面：`workspace init`、`org tree` / `org apply`、`chat @岗位`
  （首个里程碑见 [Epic #155](https://github.com/fullstack-ai-infra/digital-employee/issues/155)）；
- 组织模型 `organization.v1alpha1`、工作区元数据与岗位员工包引用；
- 岗位权限边界：Context Scope（岗位可召回的业务切片）与 Authority Scope（岗位可调用
  的工具），owner/worker 两档默认值，不允许静默继承；
- 长期 Context 集成：`mem` R1 级记忆平面写入与召回，加 `context` 规则版事实蒸馏，
  把连续性从 Host 原生会话续接中解耦出来；
- 已发布的员工包、Skill、Schema、eval 与 Host Adapter 契约，以及 `init` / `doctor` /
  `validate` / `eval` / one-shot `run` / `setup` / package-bound `deploy`；工作区在此之上构建；
- 包摘要、单次密封快照、标准事件、签名回执，以及本地框架边界的审计/脱敏/可观测性；
- 保证每一项公开声明诚实的验证账本与证据词汇。

### 本开源仓库 Out of Scope

- 替代某个 Agent Host 的模型和原生工具循环；
- 云端托管员工包、Agent Host、模型账号、凭证或应用/服务机器人；
- marketplace 账户、上架、搜索、排序、评价、租赁、动态定价、Quote、Credit、计费、
  结算或任何公司内交易——这些属于私有工作（见下方边界）；
- 首个里程碑不做渠道扩展（飞书 #77 / 企微 #78）；首个里程碑只走 CLI；
- 全量 RBAC；首个里程碑只做 owner/worker 两档默认值加显式权限白名单推导；
- 把 Host 原生会话续接作为需求；长期连续性每轮由 `mem` + `context` 重建（#102）；
- 在核心中硬编码文档、网盘、DWS、记忆或业务系统集成；这些能力通过显式 MCP、
  connector 或 adapter 边界接入；
- 在 runtime package 中引入 React、design system 或 marketplace UI。

## 与旧主线（Runner / 安全 / 部署治理）的边界

旧公开主线是 **Builder → Seller Runner → Trusted execution**
（[Epic #25](https://github.com/fullstack-ai-infra/digital-employee/issues/25)）。
2026-08-14 战略决策把产品主线转向**本地数字组织工作区**
（[Epic #155](https://github.com/fullstack-ai-infra/digital-employee/issues/155)）。

- 旧路线**收尾、不扩展**：已发布的底座（`init`/`validate`/`eval`/`run`、员工包契约、
  Host Adapter、预览 Runner 内核）继续受支持，并作为新主线的基座。旧路线剩余 issue
  （deploy 治理、Host/Runner 资格验收、安全审计）只按收尾需要完成，不再新增能力。
- 每个 open 旧路线 issue 在[路线图](roadmap.zh-CN.md)中都有明确的
  **KEEP / REPURPOSE / PARK** 处置：KEEP 并入新主线，REPURPOSE 重新落到工作区命令面，
  PARK 在旧路线收尾后冻结。处置是记录性的，不是破坏性的：不批量改写 issue，也不由本
  策略关闭 issue。
- 私有 marketplace 故事不变，仍留在公司内：开源仓库绝不实现上架、定价、计费、结算或
  公司内交易。

## 实践路径

### 当前源码已经支持

1. 构建当前源码 checkout，或安装公开 `0.4.0` 版本。
2. 用 `init` 创建员工包，用 `validate` 校验，再通过 `doctor --engine` 做有上限的本机
   Host 诊断；这些步骤不能证明模型权益可用。
3. 显式提供部署凭证后，用 `run --engine` 发起一次真实、本机 one-shot Agent/模型执行；
   它可能消耗供应商额度。
4. 用 package-bound `deploy` 把经过校验的员工包绑定到可验证的本地部署结果，且只在其
   文档化的 fail-closed 边界内。

当前源码**没有** `workspace init`、`org tree` / `org apply`、`chat @岗位` 命令；
它们处于 **design** 状态，由 [Epic #155](https://github.com/fullstack-ai-infra/digital-employee/issues/155)
跟踪。不要把这些能力描述为可用。精确证据以[验证账本](verification.md)为准。

### 目标端到端路径（新主线）

1. 用户运行 `workspace init ./<业务> --template oss-maintainer`（或 `minimal` /
   `org-root`），得到带组织树和逐岗位员工包的工作区。
2. 用户用 `org tree` 查看组织，知道谁可被点名、每个岗位能看什么、能做什么。
3. 用户通过 `chat @repo-owner`（负责人委派、员工执行）或 `chat @issue-researcher`
   （窄 Context、窄权限）获得带出处与责任链的结果。
4. 决策与任务状态写入 `mem` 记忆平面；会话原文进入 `context` 采集。
5. 新会话或换 Host 后召回同一岗位记忆，继续工作。
6. 组织变化走 `org apply`：Context 不丢失，权限范围重算且不静默扩权。

## 里程碑契约

路线图负责日期和 Issue 归属。以下用户结果和 gate 定义稳定推进顺序。

### M1 — 数字组织工作区（首个里程碑）

**用户结果：**用户把一个业务目录变成一支可直接点名的 AI 团队，并端到端复现首个
展示案例（oss-maintainer）：`workspace init` → `org tree` → `chat @岗位`（负责人与
员工两条路径）→ `mem` 持久化 → 新会话召回。

**Gate：**

- 干净机器上 `workspace init ./oss-maintainer --template oss-maintainer` 成功，且生成
  的每个员工包通过 `validate`；
- `org tree` 渲染层级，JSON 输出通过 `org-tree.v1` schema 校验；
- `chat @repo-owner` 产生 `user → owner → worker` 任务链，`chat @issue-researcher`
  证明 Context 切片很窄（`contextUsed` 中不出现业务全局事实）；
- 越权请求被拒绝并给出稳定错误，提示改问负责人；未绑定 Host 的岗位 fail closed；
- 对话结束后 `mem` 中存在带 source/task 出处的岗位决策记录，新会话可召回并复述；
- `org apply` 保留 Context、重算权限范围；
- 所有声明使用下文证据词汇，只有 fixture 的路径不得写成 live-qualified。

**非目标：**渠道（只走 CLI）、marketplace/交易工作、全量 RBAC、Host 原生会话续接。

### M2 — Context 深度与组织生命周期

**用户结果：**工作区持续学习：会话原文被蒸馏为规则版实体图谱，`org apply` 成为组织
变化的可信方式。

**Gate：**规则版 `context` 蒸馏（#162）幂等且可驱动窄切片召回；`org apply` 审计组织
变化。渠道输出渲染（#160）由本次转向之外负责，不作为这里的门槛。

**非目标：**渠道扩展、marketplace/交易工作、全量 RBAC。

### 旧路线收尾

旧 Runner/deploy/安全路线不是新主线上的里程碑。其 open issue 在
[路线图](roadmap.zh-CN.md)中带有明确处置——KEEP（并入新主线）、REPURPOSE（重新落到
工作区命令面）或 PARK（收尾后冻结）。不再安排任何旧路线新能力。

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
| **private** | 在本公开仓库之外实现或规划。公开接口可以引用它，但本仓库不得宣称或吸收其实现。 |

适用时继续使用 `unsupported` 或 `probe-only`；它们不是 preview 的同义词。即使达到
live-qualified，无人值守运行或转售的法律权限仍是独立商业 gate。

## 新需求归属判断

新增需求或 Issue 前，按顺序回答：

1. 它是否帮助用户把目录变成业务工作区、点名岗位、按 Context 与权限边界约束对话，
   或跨会话保持长期 Context？如果是，可能属于新主线。
2. 它是否属于已发布底座的本机定义、校验、打包、运行或观测？如果是，属于开源框架。
3. 它是否拥有 marketplace 身份、上架、发现、评价、租赁、Quote、Credit、计费、支付、
   结算状态，或任何公司内交易？如果是，属于私有工作。
4. 它是否实现服务端设备注册、任务分发、`UsageVerifier` 或结算？如果是，属于私有
   工作；本仓只保留互操作客户端/协议边界。
5. 它是否在 Agent Host 外再创建一套模型或工具循环？如果是，拒绝，或重构为员工包、
   Host Adapter 或外层运行时职责。
6. 它是否为厂商专用逻辑？把强制策略和投影放入版本锁定 Host Adapter，不能进入可移植
   员工包契约。
7. 它是否为渠道（飞书/企微）、文档、网盘、DWS、记忆或业务能力？优先使用显式 MCP、
   connector 或 adapter 扩展，不能成为核心依赖；首个里程碑不扩展渠道。
8. 它是否是 UI？本机运维 UI 可以消费公开 API，但不能进入 runtime package；
   marketplace UI 属于私有工作。
9. 它当前属于哪个证据词汇，需要什么可观测 gate 才能晋级？没有答案，就不能宣称完成。
10. 它是否会把员工包字节、本地路径、Host 凭证或私有 chain-of-thought 发送给私有
    服务？如果是，拒绝。

跨边界需求应在公开协议处拆开，不能把开源框架工作和公司内交易状态放进同一个 Issue
或实现。
