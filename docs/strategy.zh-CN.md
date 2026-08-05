# Digital Employee 产品策略

[English](strategy.md)

本文是开源 `digital-employee` 仓库的权威产品契约。[路线图](roadmap.zh-CN.md)负责把这个
稳定方向转化为里程碑和工作项。实现状态应记录在[验证账本](verification.md)，不能混入
产品能力承诺。

## North Star

> Digital Employee 是一套开源的 Agent-native CLI、本地执行框架和协议：让可移植、
> 可验证的员工包通过现有 Agent Host，在发布者自有机器上安全运行，并产出可供可选
> 私有控制面校验的标准事件和可验证执行证据；框架不托管员工，也不实现市场。

Digital Employee 不再实现另一套通用模型或工具循环。选定的 Agent Host 负责模型、
上下文和原生 Agent loop；本框架负责员工包、Adapter、策略和本地执行边界。
本机创建、校验和运行路径不依赖 marketplace。

`answer-agent` 是历史上的首个员工用例，不是产品定义。当前仓库中的实现属于
`standalone-v1`；真正 Agent-native 的 recipe 尚未 shipped，交付首个 recipe 是 M0
结果。`standalone-v1` 是兼容路径，不是新通用 Agent 能力的目标演进路径。

## 北极星指标：Verified Local Employee Run

一次 **Verified Local Employee Run（可验证本机员工执行）**必须同时满足：

1. 员工运行在发布者或运营者自己的电脑或服务器上；
2. 所选员工包身份、版本、摘要与实际执行的字节一致；
3. 已注册 Agent Host 满足员工要求的策略和能力门槛；
4. 执行只产生一个有效终态、有上限的标准事件链，以及可以用可信公钥验证的 Runner
   签名回执；
5. 平台没有收到员工包本地路径、员工包制品字节或 Agent Host 凭证。

这个指标衡量框架端到端执行契约。Runner 签名只证明来源和完整性，不能证明 token 或
成本声明可以计费。Runner 自报 usage 只有经过私有平台独立 `UsageVerifier` 核验，并
绑定不可变 Quote 后，才可能进入结算。Credit、价格和卖家应收都不属于这个指标。

## 三类直接用户与 JTBD

| 直接用户 | Job to be Done |
| --- | --- |
| 员工开发者/发布者 | 用可移植 Skill 指令、任务/结果 Schema、显式资产、eval 和能力要求定义一次岗位；校验后可在兼容 Agent Host 上运行，不把厂商命令写进员工包。 |
| Runner 运营者 | 员工包、Agent Host、凭证和执行都留在自己控制的机器上；通过仅出站 Runner 接收可信任务，强制绑定员工版本和策略，安全恢复并返回可验证证据。 |
| 私有平台集成者 | 登记不可变员工版本身份和摘要，分发签名任务，验证事件、回执和用量，同时不托管员工包，也不持有运营者的 Agent Host 凭证。 |

买家或最终用户会消费员工结果，但不是本开源框架的直接用户。买家账户、发现、租赁和
支付属于私有 marketplace。

## 产品范围

### 本开源仓库 In Scope

- 用于创建、校验、诊断、评测、打包和运行可移植员工的 `digital-employee` CLI；
- 宿主中立的员工包、Skill、Schema、显式资产、eval 和 MCP 声明契约；
- Agent Host Adapter、能力协商、版本门槛、标准事件和安全的外部 Adapter 扩展契约；
- 本机 one-shot 执行，以及运行在发布者或运营者机器上的长期卖家 `runner start`
  客户端；
- 该 Runner 客户端的本地部署绑定、员工包解析、设备密钥处理、持久 replay/outbox、
  断线重连、取消和进程生命周期；
- 包摘要、单次密封快照、签名任务和租约校验、hash-chain 事件与 Runner 签名回执；
- 供应商中立的原始 usage 声明与完整性验证原语；
- 为验证公开协议而提供的 mock/参考控制面 fixture，但不导入私有平台实现；
- 本地框架边界上的策略、审计元数据、脱敏、人工接力和可观测性。

### 本开源仓库 Out of Scope

- 替代 Claude Code、Qoder CLI、Codex、Qwen Code、CodeBuddy Code 或其他 Agent Host
  的模型和原生工具循环；
- 云端托管员工包、Agent Host、模型账号、凭证或应用/服务机器人；
- marketplace 账户、上架、搜索、排序、评价、租赁、动态定价或 Quote 创建；
- Credit 账本、可计费用量策略、支付、退款、分账、税务或结算；
- 设备注册和身份签发、任务分发、`UsageVerifier`、Quote、Credit 或结算的私有平台
  服务端实现；
- 在核心中硬编码文档、网盘、DWS、记忆或业务系统集成；这些能力通过显式 MCP、
  connector 或 adapter 边界接入；
- 在 runtime package 中引入 React、design system 或 marketplace UI。未来本地运维页
  可以消费公开运行时 API，marketplace UI 仍属于私有平台。

## 公开框架与私有 marketplace 的边界

所有应用/服务员工都在发布者或运营者自己的机器上运行。平台是控制面，绝不是员工
托管面。

| 开源 `digital-employee` 框架 | 私有 marketplace 控制面 |
| --- | --- |
| 员工源码包和本机确定性摘要 | 引用摘要的上架身份和不可变员工版本身份 |
| Host Adapter、本机凭证和进程/沙箱策略 | 服务端设备注册与可信公钥注册表 |
| 卖家自有 `runner start`、本地 replay/outbox 和出站客户端 | 任务创建、分发、租约服务和已认证服务端 API |
| 标准事件、usage 声明、事件链和签名回执 | 事件接收、独立 `UsageVerifier` 和争议策略 |
| 公开签名、租约和回执验证原语 | Quote、预留、Credit 账本、计费和结算 |

平台不能向 Runner 下发本地路径、任意命令、模块或凭证，不能接收员工包字节，也不能
把 Host 执行代码复制进控制面。所有网络连接都由 Runner 主动发起；发布者机器不向平台
开放入站端口。

## 实践路径

### 当前源码已经支持

1. 构建当前源码 checkout。
2. 用 `init` 创建员工包，编辑 `SKILL.md`、任务/结果 Schema、显式声明的资产和 eval
   用例。
3. 先执行静态 `validate`，再通过 `doctor --engine` 做有上限的本机 Host 诊断；这些步骤
   不能证明模型权益可用。
4. 显式提供部署凭证，再用 `run --engine` 发起一次真实、本机 one-shot Agent/模型
   执行；它可能消耗供应商额度。
5. 嵌入方可以使用预览 Runner 内核计算包摘要、校验签名任务和租约、执行一个本机任务、
   生成 hash-chain 事件流并签署回执。

当前源码没有交付可直接部署的长期 `runner start` 进程、本地持久 replay/outbox、可重连
平台客户端或公开平台网络 SDK。Adapter 专用确定性 fixture 不等于真实模型权益或商业
部署验收。精确证据以[验证账本](verification.md)为准。

### 目标端到端路径

1. 开发者创建、校验并评测宿主中立员工包。
2. 框架生成确定性员工包制品和摘要。
3. 运营者把员工版本绑定到本机安装的 Agent Host、合法服务凭证、沙箱和运行策略。
4. 运营者启动开源、仅出站的卖家 Runner。
5. 私有平台只登记员工版本身份、摘要、兼容 Engine 元数据和市场数据；买家接受不可变
   Quote 后，平台分发签名任务和租约。
6. Runner 校验任务、租约、设备身份、replay claim 和本机员工包精确字节，创建密封
   快照，再调用本机 Host。
7. 框架发送有上限的标准事件和 usage 声明，组成事件链并提交 Runner 签名终态回执。
8. 私有平台校验身份、签名、租约和事件链；独立 `UsageVerifier` 确认可计费事实后，才
   执行 Quote/Credit 结算。

## 里程碑契约

路线图负责日期和 Issue 归属。以下用户结果和 gate 定义稳定推进顺序。

### M0 — Builder Ready

**用户结果：**员工开发者可以安装 Agent-native 框架，创建一个不被答疑模板限定的
宿主中立员工，完成校验和评测，并按文档完成一次本机执行。

**Gate：**

- 全新机器上的 Agent-native 安装与 quickstart 可重复；
- 中立脚手架和至少两个实质不同的员工示例共用同一套员工包与运行时契约，不增加核心
  switch；
- eval 声明可校验、可执行，不是闲置文件；
- 员工包和 Host 失败信息可操作，并且 fail closed；
- 支持声明使用下文证据词汇，只有 fixture 的 Adapter 不得写成 live-qualified；
- 发布文档区分“源码可用”和“制品已发布”，不把未发布版本写成可安装。

**非目标：**长期 Runner、市场运营和可写业务动作。

### M1 — Seller Runner Ready

**用户结果：**卖家可以让员工长期运行在自己控制的机器上，不开放入站端口，也不上传
员工包或 Host 凭证，就能安全接收平台任务。

**Gate：**

- 开源框架提供 `runner init/doctor/start/status` 或等价生命周期命令；
- 本地员工版本/Engine 绑定、设备密钥、持久 replay/outbox、heartbeat、重连、取消和
  升级恢复在重启后仍 fail safely；
- 提交到仓库的 mock-control-plane 测试覆盖签名认领、本机 Host 执行、事件上传、回执
  校验和断网恢复；
- 重放或过期 attempt 不能启动任务，也不能完成更新的 attempt；
- 可观测证据证明控制面没有收到本地路径、员工包制品字节或 Host 凭证。

**非目标：**marketplace 定价、订单、支付、结算或生产私有平台 `UsageVerifier`。

### M2 — Framework v1 / Trust Ready

**用户结果：**第三方或企业 Host 与批准能力可以通过稳定契约接入，同时可移植员工制品和
有副作用动作拥有明确的信任与兼容边界。

**Gate：**

- 稳定的 employee-package、Agent Host、Runner task/event/receipt 和兼容契约包含 golden
  vector 与升级规则；
- 确定性 package、inspect、verify、provenance、升级和回滚流程无需执行员工包代码即可
  拒绝篡改；
- 显式外部 Adapter 协议和一致性套件可以在不修改核心分发逻辑的情况下接入一个示例
  Adapter；
- 供应商中立用量证据继续与 Quote/Credit 计算分离；
- 写工具默认拒绝；开放时遵循经过校验的 preview、approval、幂等执行和不可变审计语义。

**非目标：**marketplace UI、账户系统、价格算法、支付和机器人云托管。

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

1. 它是否帮助在发布者自有机器上定义、校验、打包、运行或观测员工？如果是，可能属于
   开源框架。
2. 它是否实现卖家自有 Runner 客户端、本地持久化或公开 task/event/receipt 契约？如果
   是，属于开源框架。
3. 它是否拥有 marketplace 身份、上架、发现、评价、租赁、Quote、Credit、计费、支付或
   结算状态？如果是，属于私有平台。
4. 它是否实现服务端设备注册、任务分发或 `UsageVerifier`？如果是，属于私有平台；本仓
   只保留互操作客户端/协议边界。
5. 它是否在 Agent Host 外再创建一套模型或工具循环？如果是，拒绝，或重构为员工包、
   Host Adapter 或外层运行时职责。
6. 它是否为厂商专用逻辑？把强制策略和投影放入版本锁定 Host Adapter，不能进入可移植
   员工包契约。
7. 它是否为文档、网盘、DWS、记忆或业务能力？优先使用显式 MCP/connector/adapter
   扩展，不能成为核心依赖。
8. 它是否是 UI？本机运维 UI 可以消费公开 API，但不能进入 runtime package；
   marketplace UI 属于私有平台。
9. 它当前属于哪个证据词汇，需要什么可观测 gate 才能晋级？没有答案，就不能宣称完成。
10. 它是否会把员工包字节、本地路径、Host 凭证或私有 chain-of-thought 发送给平台？
    如果是，拒绝。

跨边界需求应在公开协议处拆开，不能把卖家执行和 marketplace 业务状态放进同一个 Issue
或实现。
