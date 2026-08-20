# Agent Host 状态与接入策略

- 状态日期：2026-08-19
- 适用范围：当前源码树中的 `employee-package.v1alpha1`、`agent-host.v1`
- 相关文档：[架构说明](architecture.md)、[员工包规范](employee-package.md)、[ADR 0001](decisions/0001-agent-host-boundary.md)

## 结论先行

`digital-employee` 不实现另一套通用 Agent loop。模型推理、上下文窗口、原生工具循环和宿主会话由 Agent Host 负责；本项目负责员工包、Host Adapter、能力协商、策略、标准事件，以及后续的通道、队列、审计和人工接力。

当前源码中有四条版本锁定的 **runnable** 路径：Qoder CLI 1.1.x、Claude Code `>=2.1.214 <2.2.0`、Qwen Code `0.17.1` 和 CodeBuddy Code `2.106.4`。它们都是 one-shot、无状态、POSIX 本机/单租户技术预览；Qoder 只获得最小只读文件投影，另外三个是不暴露原生工具的 context-only Adapter。四条路径都不支持 MCP、附件、会话恢复、写工具或审批回调，也都没有使用真实模型权益验收。Windows 因尚无经过验证的 Job Object 进程树清理而 fail closed。Codex 仍是 **probe-only**：Codex CLI 0.148.0 无法可靠移除所有模型可见的内建工具，其中包括 `apply_patch`，详见 [0.148.0 复审](research/codex-cli-0.148.0-default-deny-audit.md)。

官方产品文档只能证明某个宿主值得适配，不能把 `documented` 提升为本仓库的 `supported`。只有版本锁定、Adapter 实现和仓库内 Adapter 专用确定性 fixture 全部通过后，一项能力才能参与运行前兼容性判断。

这里的 **probe-only** 不是“不启动任何进程”，而是“没有可启动模型或 Agent loop 的 runnable Adapter”。`doctor` 只会用过滤后的环境、固定 `--version` 参数和 10 秒超时执行受限版本探测；它不会验证登录、发起模型调用或执行工具。

当前 `capabilitySource: conformance_test` 指仓库内针对特定 Adapter 和锁定 Host 版本的确定性子进程 fixture。它不是可供第三方 Adapter 复用的认证 harness，也不是厂商认证或真实模型额度验证。Qoder 的 capability 声明来自 Adapter 专用确定性 fixture；本轮没有生成通用 qualification record，`liveQualified` 为 false。

`structured_output` 统一表示 **Adapter 保证终态有效**，而不是 Host 原生约束生成：有 `outputSchema` 时，`run.completed` 必须携带原值通过调用方同步 Schema 的终态 JSON；修复、强制转换、默认值、删字段或脱敏都不得制造一个合格值，校验后的安全检查若需要改写 schema-bound 值也必须 fail closed。无效 JSON、异步 Schema、Schema 不匹配、取消、超时或清理失败同样必须 fail closed。事件流本身是 JSON 不构成该能力。四个 runnable Adapter（Qoder、Claude、Qwen、CodeBuddy）共用同一个前置守卫 `output-schema-guard.ts`：Schema 限 16 KiB、必须同步，`$async:true` 与任何非法 Schema 在受限版本探针、投影或模型进程之前即被拒绝；每次运行只编译一份 prepared Schema 快照，投影与终态校验复用同一快照，终态阶段不再重新编译或重新接受 Schema。

## `structured_output` 资格证据（精确版本）

Issue #113 的四个 runnable Adapter 以如下精确版本证据报告
`structured_output: supported`（`capabilitySource: conformance_test`）：

| Adapter | 锁定的 Host 版本 | 确定性 fixture 版本 | 备注 |
|---|---|---|---|
| Qoder CLI | 合规家族 `1.1.x`（代码只锁定 major.minor） | `1.1.12` | 本机受限探针另观察到 `1.1.17`；裸 `1.1.x` 之外的任何形式（`1.2.0`、`v1.1.12`、`1.1.12-beta.1`、`1.1.012`）以 `qoder_version_not_conformance_verified` fail closed |
| Claude Code | `>=2.1.214 <2.2.0` | `2.1.214` | 区间外版本保持 not_ready |
| Qwen Code | `0.17.1` | `0.17.1` | 精确版本锁定 |
| CodeBuddy Code | `2.106.4` | `2.106.4` | 精确版本锁定 |

证据边界：

- 上述全部是 **fixture conformance**（E3）：仓库内确定性子进程 fixture，`fixtureConformant: true`、`liveQualified: false`；`liveQualified` 只允许由带校验 `liveEvidence`（环境标识 + sha256）的记录翻转，默认 CI 不产生真实模型或付费调用。
- Schema 字节只出现在受限 stdin/context 通道：四家 Adapter 的投影测试都以独立 marker 断言 Schema 字节不出现在 argv、进程环境变量取值或公开事件流（含序列化事件）中。
- 资格不授予任何新的 tool、MCP、写、网络或审批权限；`structured-action.v1` 一类包仅通过普通 registry 与包绑定协商能力。
- AC-004 要求的“后续版本化发布证明通用下游选择且不修改应用状态”是发版门禁，不由本证据表替代。

## 名词边界

- **Employee Package（员工包）**：宿主中立的员工源码，核心是 `employee.json`、`SKILL.md`、输入/输出 Schema、显式资产，以及可选 MCP 声明。它声明能力要求，但不选择某个厂商 Host。
- **Agent Host**：真正运行模型和 Agent loop，并提供非交互调用、机器可读事件、权限边界和取消语义的执行宿主。
- **Host Adapter**：把员工包和 `agent-host.v1` 请求投影成某个 Host 的指令、工作目录、工具/MCP 配置和原生协议，再把原生事件归一化。
- **Workbench / Channel**：任务创建、用户交互、上下文管理、定时任务或 IM 接入层。它可以调用 `digital-employee`，但不会因为有 GUI、Skills 或 MCP 就自动成为 Host。

本文中的 WorkBuddy 指 **腾讯 WorkBuddy**；它与互联网上其他同名 `work-buddy` 项目无关。

## `agent-host.v1` 兼容性语料修订

[`fixtures/agent-host-vectors/v1`](../fixtures/agent-host-vectors/v1) 是最初合入的
44-vector 基线。它保持冻结，aggregate `corpusDigest` 固定为
`2ac92b971c5131b9b3076d0052809592fc9f3d05716c2dfceb8dd27fe745ecf0`；不能为补测试而
原地改写其行为 fixture。

[`fixtures/agent-host-vectors/v2`](../fixtures/agent-host-vectors/v2) 是当前完整修订，仍使用
`agent-host-vectors.v1` JSON schema 和 `agent-host.v1` 协议。它继承 44 个 v1 向量并新增
6 个稳定 ID：unknown capability key、`not_ready`、`adapter_declaration`、
`probe_only`、unavailable，以及 completed+failed 双终态歧义。其 aggregate
`corpusDigest` 为
`74c13ac0d3036e11dae0e248e9950a9799e7181dfe0582167e44c7aa869a6864`。

| 冻结规则 | 验证行为 |
| --- | --- |
| 协议版本 | 只接受精确的 `agent-host.v1`；不降级、不推断迁移 |
| 能力对象 | key 必须精确来自 `AGENT_HOST_CAPABILITIES`，缺失或额外 key 都拒绝 |
| Probe 形状 | 顶层与 `issues[]` 只接受冻结 key；wire 和进程内 result validator 都 fail closed |
| Migration | not-ready、仅声明未验证、probe-only 或 unavailable Host 都不兼容 |
| 终态 | 每次运行只有一个最终 `run.completed` 或 `run.failed`；两者同时出现仍是协议违例 |

语言中立 consumer 应选择一个完整 revision，逐项校验 manifest 的 file digest 和
vector count，再按文件名排序的 `file:sha256` 列表计算
`sha256(entries.join("\n"))` 并与 `corpusDigest` 比较。不得把 v1/v2 文件混装成第三套
未声明语料。仓库集成测试在同一次运行中验证两套 revision、两个 probe validator 和
v2 的全部 50 个向量；这些 fixture 不启动真实 Agent Host，也不构成 Host 认证。

## 当前支持矩阵

| 产品 | 当前源码状态 | 官方接口证据 | 本项目结论 |
| --- | --- | --- | --- |
| Qoder CLI 1.1.x | `runnable`；内置、版本锁定、只读 one-shot Adapter | 当前实现与测试见 [`qoder-agent-host.ts`](../apps/cli/qoder-agent-host.ts) 和 [验证账本](verification.md) | 最小只读文件投影，运行时校验精确的读/搜索工具集；`structured_output` 由 Adapter 严格终态校验，Schema 限 16 KiB 且必须同步；无效、超限或异步 Schema 在运行工作区投影、受限 `--version` 探针和模型进程前即拒绝；仍不是多租户在线服务 |
| Claude Code `>=2.1.214 <2.2.0` | `runnable`；内置、版本锁定、context-only one-shot Adapter | 官方提供 [`claude -p` 与 `--bare`](https://code.claude.com/docs/en/headless)、JSON/stream-json、[权限](https://code.claude.com/docs/en/permissions)、[沙箱](https://code.claude.com/docs/en/sandboxing)、[MCP](https://code.claude.com/docs/en/mcp)、[Skills](https://code.claude.com/docs/en/skills) 和 [Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript) | `--bare --tools "" --strict-mcp-config --disable-slash-commands --no-session-persistence`，资产经 stdin 内联；只支持显式 `ANTHROPIC_API_KEY` |
| Codex CLI | `probe-only`；仅检查本机命令和版本 | 官方提供 [`codex exec`](https://learn.chatgpt.com/docs/non-interactive-mode)、[JSONL 与输出 Schema](https://learn.chatgpt.com/docs/developer-commands?surface=cli#cli-codex-exec)、[MCP](https://learn.chatgpt.com/docs/extend/mcp)、[Skills](https://learn.chatgpt.com/docs/build-skills)；[App Server](https://learn.chatgpt.com/docs/app-server) 另有事件与 `turn/interrupt` | 已审计 0.148.0（[复审记录](research/codex-cli-0.148.0-default-deny-audit.md)，前次 0.147.0 记录见 [research](research/codex-cli-0.147.0-default-deny-audit.md)）；即使禁用 shell/unified exec，`apply_patch` 等模型可见内建工具仍无法可靠全部移除，候选移除配置也未被 `--strict-config` 接受，上游禁用 `apply_patch` 的请求已按 NOT_PLANNED 关闭（[openai/codex#8161](https://github.com/openai/codex/issues/8161)），所以 `tool_allowlist` 保持 `unknown` |
| Qwen Code `0.17.1` | `runnable`；内置、精确版本锁定、context-only one-shot Adapter | 官方提供 [headless JSON/stream-json](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/)、[权限与沙箱](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/)、[MCP](https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/)、[Skills](https://qwenlm.github.io/qwen-code-docs/en/users/features/skills) 和 [TypeScript SDK](https://github.com/QwenLM/qwen-code/blob/main/packages/sdk-typescript/README.md) | 密封 UTF-8 资产经 stdin 内联，工具/MCP/slash-command 集为空；锁定 0.17.1 的不可调用内建 Agent 目录；要求显式 `OPENAI_API_KEY` 与 `OPENAI_MODEL`，可选 `OPENAI_BASE_URL` |
| CodeBuddy Code `2.106.4` | `runnable`；内置、精确版本锁定、context-only one-shot Adapter | 官方提供 [headless JSON/双向 JSONL](https://www.workbuddy.ai/docs/cli/headless)、[权限与沙箱](https://www.workbuddy.ai/docs/cli/settings)、[MCP](https://www.workbuddy.ai/docs/cli/mcp)、[Skills](https://www.workbuddy.ai/docs/cli/skills)、[Python SDK](https://www.workbuddy.ai/docs/cli/sdk-python) 和 [Beta HTTP API](https://www.workbuddy.ai/docs/cli/http-api) | 密封 UTF-8 资产经 stdin 内联；空 `--tools` 不足以清空 2.106.4，Adapter 额外逐项 deny 该版本全部内建工具并校验最终工具/MCP 集为空；要求显式 `CODEBUDDY_API_KEY` 与 `CODEBUDDY_MODEL` |
| QwenWork（千问办公） | 不在 Host registry | 官方定位是[办公工作台](https://qwenwork.cn/docs)，提供[定时任务](https://qwenwork.cn/docs/desktop/scheduled-tasks)、[IM 渠道](https://qwenwork.cn/docs/desktop/im-channels)和 [Skills](https://qwenwork.cn/docs/features/skills) | Workbench / Channel，不是当前 Agent Host；官方文档尚未给出本项目所需的稳定 headless 事件与取消契约 |
| 腾讯 WorkBuddy GUI | 不在 Host registry | 官方定位是[全场景 AI Agent 桌面工作站](https://www.workbuddy.ai/docs/workbuddy/)，并提供 GUI [权限模式](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Permission-Modes)与 MCP/Skill 市场 | Workbench / Channel，不直接自动化 GUI。腾讯方向的可编程候选是上面的 CodeBuddy Code |

“命令已安装”也不等于“可以运行员工”。`doctor` 会执行受限的本地版本子进程探测，但不会认证、调用模型或执行工具；它不会验证 API Key、模型额度、运行期协议、包级权限或真实沙箱。这些必须由 runnable Adapter 的 preflight 和 Adapter 专用确定性 fixture 确认。当前 Adapter 只使用操作方显式传入的服务 API Key/Token，不复用个人登录态。

## 三层接入策略

### 1. Verified built-in Adapter

内置 Adapter 由本仓库维护，进入发布物，并用仓库内 Adapter 专用确定性 fixture 覆盖明确的 Host 版本范围。它必须：

- 把宿主原生事件完整映射为 `agent-host.v1`，且每次运行只有一个可信终态；
- 在信任任何模型输出前验证真实工具集合、目录、网络、MCP、Skill/插件加载状态，并在本地验证输出契约；
- 区分“允许后免确认”和“从工具表中真正移除”，不能用 Prompt 代替安全边界；
- 支持 deadline/cancel，并确认子进程、临时凭证、工作目录和会话资源已经清理；
- 固定兼容版本，版本或协议超出验证范围时 fail closed。

当前 Qoder CLI、Claude Code、Qwen Code 和 CodeBuddy Code 的上述版本属于这一层，且能力范围仍受前述 one-shot 上下文/只读技术预览限制。它们的模型控制面网络保持可达，而员工 tool/MCP 数据面网络被禁止；这不是多租户 OS 隔离。

### 2. Explicit external stdio Adapter

这是面向第三方或企业私有 Host 的扩展层。未来由操作方显式配置并信任一个本地 Adapter 可执行文件，通过版本化 stdio/JSONL 协议与 `digital-employee` 通信；外部 Adapter 再负责调用真实 Host。

这一层必须保持显式和可审计：

- 不扫描插件目录，不自动执行包内脚本，不接受远程 URL，也不隐式运行 `npx`；
- 配置必须锁定可执行文件、参数、版本/摘要、允许的环境变量和工作目录；
- stdout 只承载协议消息，日志走 stderr；未知字段、重复终态、越界事件和协议版本不匹配全部拒绝；
- 外部声明的能力仍需本地策略检查和一致性证明，不能因为 Adapter 自称 `supported` 就获得权限；
- Adapter 进程必须处于操作方提供的 OS/容器隔离中，stdio 协议本身不是租户隔离。

当前源码已有显式、无自动发现的 [`AgentHostRegistry`](../packages/core/src/agent-host-registry.ts)，但 **尚未提供外部 stdio Adapter 的线协议、配置加载或 CLI 入口**。因此这一层是确定的接入策略，不是当前已交付功能。

当前已经交付的是受信任 Embedder API：根包的 `./host-runtime` 导出员工包 runner 和内置 Registry factory，`./core` 导出 `AgentHostRegistry`。部署代码可以显式 `register()` 一个随自身发布、由操作方信任的 Adapter，再把 Registry 传给 `runEmployeePackage`。这不会修改员工包，也不会自动加载 npm 模块；被注册的进程内 Adapter 属于部署 TCB，不等同于未来面向第三方制品的隔离 stdio 插件层。

源码预览中的最小接法如下；`createAdapter` 必须返回实现 `agent-host.v1` 的受信任对象：

```ts
import { createBuiltInAgentHostRegistry, runEmployeePackage } from "@fullstack-ai-infra/digital-employee/host-runtime"

const hosts = createBuiltInAgentHostRegistry()
hosts.register({
  id: "company-agent",
  aliases: ["company"],
  probe: () => companyAdapter.probe(),
  createAdapter: () => companyAdapter,
})

await runEmployeePackage({
  directory: "./employees/team-answer",
  engine: "company",
  hostRegistry: hosts,
  input: { message: "问题" },
})
```

### 3. Workbench Bridge

QwenWork、腾讯 WorkBuddy GUI、DWS Workbench、钉钉/飞书机器人或未来管理页面位于执行层之上。Bridge 负责创建任务、绑定员工包与部署、传递用户上下文、展示进度、接管确认和回传结果；真正的 Agent 运行仍交给第一层或第二层 Host Adapter。

Workbench Bridge 不得：

- 通过 GUI 自动化假装获得稳定 Host 协议；
- 把 Workbench 自己的 Skill、账号或本地私有文件写回可发布员工包；
- 绕过员工包能力协商，直接开启 Full Access；
- 把通道会话 ID 当作 Host 原生 session，或把一个租户的会话/凭证复用给另一个租户。

只有当某个 Workbench 官方稳定提供非交互执行、机器事件、程序化取消、权限收窄、目录授权和能力探测时，才把它作为新的 Host 候选重新评估。

## 员工包不绑定 Host

市场或 Git 仓库中发布的是员工包，不是某台机器上的 Agent 配置。员工包：

- 使用 `SKILL.md` 描述角色与工作流，使用 Schema 描述任务和结果；
- 只声明抽象能力要求与最大权限，不写 `claude`、`codex`、`qwen`、`codebuddy` 等启动参数；
- 可以声明 MCP 能力，但只保存环境变量名，不保存 Token、Cookie 或账号；
- 不包含用户级 Host 配置、登录态、会话文件、私有索引或绝对路径；
- 由部署绑定选择 Host、Adapter、模型账号、隔离环境、通道和队列策略。

因此同一员工包可以部署到不同 Host；如果某个 Host 无法强制满足要求，该部署不兼容，而不是修改员工包来降低策略。

## Adapter 的验收门槛

新增 runnable Adapter 或扩大现有 Adapter 能力前，至少验证：

1. 非交互启动不会等待 TTY，且可隔离用户级/项目级隐式配置；
2. 事件流有稳定 framing、run/session 标识、用量信息、错误和唯一终态；
3. 工具 allow/deny 的真实语义已经测试，尤其不能把 auto-approve 误当 allowlist；
4. 文件和网络边界对宿主工具及其子进程都有效，越界操作会被强制阻止；
5. MCP/Skills 的加载集合可证明，失败的必需服务不会被静默忽略；
6. 取消、超时和父进程退出会清理完整进程树，并产生可区分的终态；
7. 输入/输出 Schema、附件和会话恢复按能力逐项验证，未知能力保持 `unknown`；
8. 认证可在无人值守环境安全注入，凭证不会进入参数、事件、日志或员工包；
9. 固定版本范围的正常、拒绝、协议损坏、取消和资源清理测试全部通过。

## 商业嵌入与转售

技术上可以调用某个 CLI/SDK，不代表有权把它打包、代管账号、共享席位或转售模型服务。员工包许可证、`digital-employee` 许可证、Host 客户端/SDK 许可证和模型/API 服务条款是四个独立层次。

平台上线前必须逐个确认：

- 是否允许服务器无人值守运行、为第三方用户执行任务和商业转售；
- 是否允许分发 Host 二进制或 SDK，还是只能由操作方自行安装；
- 账号、席位、API Key、Token、额度和输出的归属及隔离要求；
- 审计、数据驻留、隐私、内容政策和品牌展示要求。

例如，[腾讯 WorkBuddy Acceptable Use Policy](https://www.workbuddy.ai/document/acceptable-use-policy) 对未经 API 条款明确授权的自动化 bot/scraper 有限制；这不能由技术 Adapter 绕过。Claude Agent SDK、Codex、Qwen/阿里和其他 Host 也必须分别以届时适用的官方商业/API 条款为准。即使客户端代码是开源的，也不能据此推断模型服务或账号可以转售。

默认商业部署模式应是操作方显式选择 Host 并提供合法凭证（或后续经条款确认的 BYOK），而不是把维护者个人订阅随员工包发布。
