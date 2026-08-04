# Agent Host 状态与接入策略

- 状态日期：2026-08-04
- 适用范围：当前源码树中的 `employee-package.v1alpha1`、`agent-host.v1`
- 相关文档：[架构说明](architecture.md)、[员工包规范](employee-package.md)、[ADR 0001](decisions/0001-agent-host-boundary.md)

## 结论先行

`digital-employee` 不实现另一套通用 Agent loop。模型推理、上下文窗口、原生工具循环和宿主会话由 Agent Host 负责；本项目负责员工包、Host Adapter、能力协商、策略、标准事件，以及后续的通道、队列、审计和人工接力。

当前源码中只有 **Qoder CLI 1.1.x Adapter 是 runnable**，而且只是一条 one-shot、无状态、只读、本机/单租户技术预览：不支持 MCP、附件、会话恢复、写工具或审批回调。Claude Code、Codex、Qwen Code 与 CodeBuddy Code 已进入内置目录，但都只有安装/版本探测和文档能力声明，属于 **probe-only**；后两者同时还是待实现的 Adapter candidates。

官方产品文档只能证明某个宿主值得适配，不能把 `documented` 提升为本仓库的 `supported`。只有版本锁定、Adapter 实现和一致性测试全部通过后，一项能力才能参与运行前兼容性判断。

这里的 **probe-only** 不是“不启动任何进程”，而是“没有可启动模型或 Agent loop 的 runnable Adapter”。`doctor` 只会用过滤后的环境、固定 `--version` 参数和 10 秒超时执行受限版本探测；它不会验证登录、发起模型调用或执行工具。

当前 `capabilitySource: conformance_test` 指仓库内针对特定 Adapter 和锁定 Host 版本的确定性子进程 fixture。它不是可供第三方 Adapter 复用的认证 harness，也不是厂商认证或真实模型额度验证。

## 名词边界

- **Employee Package（员工包）**：宿主中立的员工源码，核心是 `employee.json`、`SKILL.md`、输入/输出 Schema、显式资产，以及可选 MCP 声明。它声明能力要求，但不选择某个厂商 Host。
- **Agent Host**：真正运行模型和 Agent loop，并提供非交互调用、机器可读事件、权限边界和取消语义的执行宿主。
- **Host Adapter**：把员工包和 `agent-host.v1` 请求投影成某个 Host 的指令、工作目录、工具/MCP 配置和原生协议，再把原生事件归一化。
- **Workbench / Channel**：任务创建、用户交互、上下文管理、定时任务或 IM 接入层。它可以调用 `digital-employee`，但不会因为有 GUI、Skills 或 MCP 就自动成为 Host。

本文中的 WorkBuddy 指 **腾讯 WorkBuddy**；它与互联网上其他同名 `work-buddy` 项目无关。

## 当前支持矩阵

| 产品 | 当前源码状态 | 官方接口证据 | 本项目结论 |
| --- | --- | --- | --- |
| Qoder CLI 1.1.x | `runnable`；内置、版本锁定、只读 one-shot Adapter | 当前实现与测试见 [`qoder-agent-host.ts`](../apps/cli/qoder-agent-host.ts) 和 [验证账本](verification.md) | 当前唯一可由 `run --engine` 启动的 Agent Host；仍不是多租户在线服务 |
| Claude Code | `probe-only`；仅检查本机命令和版本 | 官方提供 [`claude -p` 与 `--bare`](https://code.claude.com/docs/en/headless)、JSON/stream-json、[权限](https://code.claude.com/docs/en/permissions)、[沙箱](https://code.claude.com/docs/en/sandboxing)、[MCP](https://code.claude.com/docs/en/mcp)、[Skills](https://code.claude.com/docs/en/skills) 和 [Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript) | 高优先级候选；尚无运行 Adapter，不得称为已支持 |
| Codex CLI | `probe-only`；仅检查本机命令和版本 | 官方提供 [`codex exec`](https://learn.chatgpt.com/docs/non-interactive-mode)、[JSONL 与输出 Schema](https://learn.chatgpt.com/docs/developer-commands?surface=cli#cli-codex-exec)、[MCP](https://learn.chatgpt.com/docs/extend/mcp)、[Skills](https://learn.chatgpt.com/docs/build-skills)；[App Server](https://learn.chatgpt.com/docs/app-server) 另有事件与 `turn/interrupt` | 高优先级候选；当前工具收窄等能力仍按 `unknown` 处理，不得称为已支持 |
| Qwen Code | `probe-only`；内置 `qwen --version` 探测，无运行 Adapter | 官方提供 [headless JSON/stream-json](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/)、[权限与沙箱](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/)、[MCP](https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/)、[Skills](https://qwenlm.github.io/qwen-code-docs/en/users/features/skills) 和 [TypeScript SDK](https://github.com/QwenLM/qwen-code/blob/main/packages/sdk-typescript/README.md) | 候选；优先评估 SDK。CLI 的 stream-json 输入仍在建设中，`qwen serve` 仍是 [v0.16-alpha / Stage 1 experimental](https://qwenlm.github.io/qwen-code-docs/en/users/qwen-serve/) |
| CodeBuddy Code | `probe-only`；内置 `codebuddy --version` 探测，无运行 Adapter | 官方提供 [headless JSON/双向 JSONL](https://www.workbuddy.ai/docs/cli/headless)、[权限与沙箱](https://www.workbuddy.ai/docs/cli/settings)、[MCP](https://www.workbuddy.ai/docs/cli/mcp)、[Skills](https://www.workbuddy.ai/docs/cli/skills)、[Python SDK](https://www.workbuddy.ai/docs/cli/sdk-python) 和 [Beta HTTP API](https://www.workbuddy.ai/docs/cli/http-api) | 候选；优先评估 SDK。headless 文档对授权操作要求 `-y`，permission prompt tool 又标为不支持，必须先实测真正的策略收窄与取消 |
| QwenWork（千问办公） | 不在 Host registry | 官方定位是[办公工作台](https://qwenwork.cn/docs)，提供[定时任务](https://qwenwork.cn/docs/desktop/scheduled-tasks)、[IM 渠道](https://qwenwork.cn/docs/desktop/im-channels)和 [Skills](https://qwenwork.cn/docs/features/skills) | Workbench / Channel，不是当前 Agent Host；官方文档尚未给出本项目所需的稳定 headless 事件与取消契约 |
| 腾讯 WorkBuddy GUI | 不在 Host registry | 官方定位是[全场景 AI Agent 桌面工作站](https://www.workbuddy.ai/docs/workbuddy/)，并提供 GUI [权限模式](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Permission-Modes)与 MCP/Skill 市场 | Workbench / Channel，不直接自动化 GUI。腾讯方向的可编程候选是上面的 CodeBuddy Code |

“命令已安装”也不等于“可以运行员工”。`doctor` 的受限版本探测不会验证账号登录、模型额度、运行期协议、包级权限或真实沙箱；这些必须由 runnable Adapter 的 preflight 和 Adapter 专用 fixture 确认。

## 三层接入策略

### 1. Verified built-in Adapter

内置 Adapter 由本仓库维护，进入发布物，并对明确的 Host 版本范围做一致性测试。它必须：

- 把宿主原生事件完整映射为 `agent-host.v1`，且每次运行只有一个可信终态；
- 在提交任务前验证真实工具集合、目录、网络、MCP、Skill/插件加载状态和输出契约；
- 区分“允许后免确认”和“从工具表中真正移除”，不能用 Prompt 代替安全边界；
- 支持 deadline/cancel，并确认子进程、临时凭证、工作目录和会话资源已经清理；
- 固定兼容版本，版本或协议超出验证范围时 fail closed。

当前只有 Qoder 属于这一层，且能力范围仍受前述只读技术预览限制。

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

## 候选 Adapter 的验收门槛

新增 runnable Adapter 前，至少验证：

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
