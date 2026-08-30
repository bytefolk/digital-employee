# Digital Employee：本地数字组织工作区

[English](README.md)

**产品方向：**[产品策略](docs/strategy.zh-CN.md) · [路线图](docs/roadmap.zh-CN.md)

Digital Employee 是一个本地优先、对话优先的数字组织工作区。长期方向（由
[Epic #155](https://github.com/fullstack-ai-infra/digital-employee/issues/155)
跟踪）：把一个业务目录变成一支可直接点名的 AI 团队——一个目录 = 一项业务，一个岗位 =
一个可寻址数字员工，一次对话 = 带岗位 Context 与权限边界的工作。岗位运行在内建的、TypeScript 原生
执行引擎之上，它是默认 Host
（[Epic #165](https://github.com/fullstack-ai-infra/digital-employee/issues/165)，
产品方向）。引擎/turn 核心已在 `0.6.0` 发布预览；完整默认 Host Workbench 路径仍在
交付中，外部 Agent Host 适配器只是选项，不是依赖。

## Digital Employee 处在哪一层

Agent 框架（Claude Code、Qoder、Qwen Code、CodeBuddy、Codex……）回答**怎么工作**；
多 Agent 系统回答**怎么操作**；Digital Employee 回答**该找谁、谁负责**：它把一项业务
映射成可点名的岗位，每个岗位有可见的 Context 与权限边界，用户直接点名正确的数字员工，
而不是手工编排一堆工具。

我们正在靠拢的卖点：**门槛很低、不用敲命令**——业务负责人不需要写 prompt 模板、不需要
手动配置 Agent Host；说一句话、喊一个岗位名，就能拿到带出处的结果，整个组织仍由负责人
兜底。**完整的无命令 Workbench 方向仍在规划中**。当前公开 `0.6.0` 已把
`workspace init`、`org tree` 与 `org apply` 作为预览能力发布；`chat @岗位` 与持久化
Workbench 集成仍在规划中（见下方状态表）。

## 能力状态

> [!WARNING]
> Digital Employee 正在积极开发中。接口与员工包格式在稳定版发布前可能变化。

| 能力 | 状态 |
| --- | --- |
| `init`、`doctor`、`validate`、`eval`、one-shot `run`、`setup` | **已发布**于当前公开 npm `0.6.0`（最初随 `0.4.0` 发布）；fixture `eval` 不代表真实模型权益已验证 |
| package-bound `deploy` | **已发布**于当前 `0.6.0`（最初随 `0.4.0` 发布），仅限文档化 fail-closed 边界（HTTP 可到 `ready`；钉钉对账外部 HOLD） |
| 员工包 / Skill / Schema / eval 契约与 Agent Host Adapter | **已发布**于当前 `0.6.0`（初始公开基线为 `0.4.0`）；Host Adapter 为 `preview` 与 `fixture-conformant`，未 live-qualified |
| `standalone-v1` 兼容运行时 | **已发布**兼容路径；不是新主线能力的目标路径 |
| 2026-08-23 pivot 之后的旧轨 issue | 按 #164 批准的台账处置——KEEP 11 / REPURPOSE 9 / PARK 5；见[旧轨处置台账](docs/roadmap.zh-CN.md#旧轨收尾与-issue-处置) |
| `workspace init`（oss-maintainer 模板） | 当前 `0.6.0` 的**已发布预览**（最初随 `0.5.0` 发布，#156） |
| `org tree` / `org apply` | 当前 `0.6.0` 的**已发布预览**（最初随 `0.5.0` 发布）；应用权限失败关闭 |
| 负责人 → 一个直接下属的显式委派 | 当前 `0.6.0` 的**已发布预览** / deterministic E3（最初随 `0.5.0` 发布）；Workbench 持久化/UI 与逐 Host E4 尚未验证（见[边界](docs/delegation.md)） |
| `chat @岗位` | **规划中**的 Workbench 集成（Epic #155 第一里程碑） |
| 可选 Memory/Context 召回与权限强制 | `0.6.0` **已发布预览**：绑定 scope 的引擎接缝，默认关闭，不代表持久化产品闭环 |
| 持久长期 Context、Workbench 连续性与 context 蒸馏 | **规划中**；未随 v0.6.0 召回接缝发布 |
| 内建执行引擎 | 已通过安装后 root 包的 `./engine` 导出与 `turn run` **发布预览**；完整默认 Host Workbench 旅程仍在规划中（Epic #165） |
| oss-maintainer 展示案例（quickstart 形态） | **规划中**（Epic #155 M1） |
| 渠道扩展（飞书/企微） | **规划中更后期**；不属于首个里程碑 |

规划中的行今天都不可用。不要把源码 `main` checkout、PR 或候选制品当作已发布能力。

## 运行

需要 Node.js 20 或更高版本。

### 从 npm 安装

从精确的公开版本开始：

```bash
mkdir digital-employee-workspace
cd digital-employee-workspace
npm init -y
npm install @fullstack-ai-infra/digital-employee@0.6.0
npx digital-employee doctor --json
npx digital-employee init ./my-employee \
  --recipe minimal-answer.v1 \
  --author your-team
npx digital-employee validate ./my-employee --json
npx digital-employee eval ./my-employee --json
```

`doctor`、`init`、`validate`、`eval` 不会发起模型调用。真实 `run` 需要一个受支持的
Agent Host 及其服务凭证：

| Engine | 凭证 |
| --- | --- |
| `qoder` | `QODER_PERSONAL_ACCESS_TOKEN` |
| `claude-code` | `ANTHROPIC_API_KEY` |
| `qwen-code` | `OPENAI_API_KEY`、`OPENAI_MODEL` |
| `codebuddy` | `CODEBUDDY_API_KEY`、`CODEBUDDY_MODEL` |

### 从源码运行

```bash
git clone https://github.com/fullstack-ai-infra/digital-employee.git
cd digital-employee
npm ci
npm run build
node ./dist/apps/cli/bin.js init ./my-employee \
  --recipe minimal-answer.v1 \
  --author your-team
node ./dist/apps/cli/bin.js validate ./my-employee
node ./dist/apps/cli/bin.js eval ./my-employee --json
```

### 试一下 setup 命令

`setup` 把无模型 Host 探测与员工包脚手架合并为一步。在干净工作区中：

```bash
cd /path/to/empty/workspace
node /path/to/reviewed/digital-employee/dist/apps/cli/bin.js setup --json
```

### 试一下 deploy 命令

`deploy` 把经过校验的员工包绑定到可验证的本地部署结果。下面的 HTTP 示例同时需要所选
Agent Host 凭证与显式 HTTP bearer token，并要求已安装 Qoder CLI 1.1.x：

```bash
export QODER_PERSONAL_ACCESS_TOKEN='...'
export DIGITAL_EMPLOYEE_HTTP_TOKEN='...'
node ./dist/apps/cli/bin.js deploy ./my-employee \
  --channel http \
  --engine qoder \
  --runtime agent-native \
  --port 3000 \
  --yes
```

只有 HTTP 当前可到 `ready`。Console 返回 `pending_external_action`；钉钉在外部供应商
契约验证前保持 fail-closed，不做真实创建或对账声明；飞书与企微不受支持。不要把 fixture
支撑的供应商测试说成真实租户验证。完整的结果、锁定、恢复与密钥处理契约见
[Deploy](docs/deploy.md)。

## 发布者自有机器上的 Runner 路径

所有应用/服务机器人都必须在发布者或运营者自己的电脑或服务器上运行。私有平台只保存
上架身份、包摘要、Quote、租约、事件和结算记录；它不保存员工包本地路径、包内容或
Agent Host 凭证，也不会反向连接用户机器。

V0.3 源码已经提供可嵌入的 one-shot Runner 执行内核和签名续租状态机。一个长期在线
Runner 应当只做出站操作：拉取并认领任务、接收平台签名租约、按身份从本机解析员工包、
调用本机 Agent Host、上传 hash-chain 事件和签名回执。平台必须再通过独立 `UsageVerifier`
核验用量，Runner 自报 token 不能直接扣 Credit。

完整接入顺序、伪代码和生产缺口见 [Runner 实践路径](docs/runner.md)，信任边界见
[ADR 0002](docs/decisions/0002-runner-execution-boundary.md)。当前没有对外宣称可直接
部署的 `runner start` 网络服务；卖家自有长期进程、本地持久 replay/outbox、断线重连和
出站平台客户端属于旧路线能力；旧轨已收尾而非扩展，保留范围见[旧轨处置台账](docs/roadmap.zh-CN.md#旧轨收尾与-issue-处置)。服务端设备注册、任务分发、
`UsageVerifier`、Quote、Credit 和结算 API 属于私有平台。

每条 runnable Adapter 都是无状态、one-shot，要求操作方显式提供服务 API Key/Token，
不会复用个人 CLI 登录态。下面的 `run` 会发起真实模型调用，可能消耗所选供应商额度；
前面的 `init`、静态 `validate`、`doctor` 不会。以 Qoder 为例：

```bash
export QODER_PERSONAL_ACCESS_TOKEN='...'
node ./dist/apps/cli/bin.js validate ../team-answer --engine qoder
printf '%s\n' '{"message":"批准资料里怎么说？"}' | \
  node ./dist/apps/cli/bin.js run ../team-answer --engine qoder --stdin
```

`QODER_PERSONAL_ACCESS_TOKEN` 需要在 Qoder 账号设置中生成 Personal Access Token，它是
部署用的服务凭证，不是个人 CLI 登录态。Token 缺失、无效或过期时，`run` 会在产出任何
可信输出前 fail closed，分别报 `qoder_service_token_not_configured` 或
`qoder_access_token_invalid`。

Claude Code、Qwen Code 或 CodeBuddy 使用同样的 `validate/run` 命令，改为对应 `--engine`
并配置该 Adapter 的服务 API Key 即可。`--stdin`/`--input-file` 让任务数据不进入外层进程
参数。Claude Code、Qwen Code 和 CodeBuddy 只接收由 manifest 显式选中、有上限的密封
UTF-8 资产投影，并在空白且隔离的工作目录、HOME 和配置目录中运行；输出被信任前必须确认
模型可见 tools 与 MCP 均为空。Claude 还会确认 plugins、Skills 和 slash commands 为空；
Qwen 会禁用 slash commands 并锁定不可调用的内建 Agent 目录；CodeBuddy 则会显式拒绝
已验证版本的每一个内建工具，因为单独使用空 `--tools` 并不能真正清空工具。Qoder 使用
最小只读文件投影，并确认精确的读取/搜索工具集以及空 MCP/Skill/plugin 集；回答文本会
等进程与凭证清理成功后再整体按真实服务 Token 脱敏。工具值会在截断前脱敏，包含服务
Token 的工具标识或键会被拒绝，需要凭证或通用模式脱敏的 schema 结构化输出会 fail closed。

四条链路仍是本机/单租户技术预览，不是已经可供市场租赁的在线员工服务；都会 fail-closed
拒绝 MCP、附件、会话恢复、写操作与审批回调。模型认证/推理控制面保持可达，员工
tool/MCP 数据面网络被禁止。当前只完成了一致性 fixture，没有使用真实模型权益验收。
当前 runnable 预览仅支持 POSIX 系统：Adapter 会在发布终态前终止并确认整个进程组退出；
Windows 还没有经过验证的 Job Object 等价实现，因此会 fail closed。

员工包规范见 [Portable employee package](docs/employee-package.md)，双运行时决策见
[ADR 0001](docs/decisions/0001-agent-host-boundary.md)。[Agent Host 状态与接入策略](docs/agent-hosts.md)
记录了精确边界：Qoder CLI 1.1.x、Claude Code `>=2.1.214 <2.2.0`、Qwen Code `0.17.1` 与
CodeBuddy Code `2.106.4` 的 Adapter 可运行。Codex 仍仅探测：Codex CLI 0.146.0 无法可靠
移除每一个模型可见的内建工具，其中包括 `apply_patch`，因此不能满足默认拒绝的工具契约。

| 可运行 Engine | 一致性版本门槛 | 必需的部署配置 |
| --- | --- | --- |
| `qoder` | Qoder CLI 1.1.x | `QODER_PERSONAL_ACCESS_TOKEN` |
| `claude-code` | Claude Code `>=2.1.214 <2.2.0` | `ANTHROPIC_API_KEY` |
| `qwen-code` | Qwen Code `0.17.1` | `OPENAI_API_KEY`、`OPENAI_MODEL` |
| `codebuddy` | CodeBuddy Code `2.106.4` | `CODEBUDDY_API_KEY`、`CODEBUDDY_MODEL` |

## 绑定员工包的本地部署

源码 CLI 可以把经过校验的员工包绑定到可验证的本地部署结果。完整的无提示 HTTP 调用示例：

```bash
node ./dist/apps/cli/bin.js deploy ../team-answer \
  --channel http \
  --engine qoder \
  --runtime agent-native \
  --locale zh-CN \
  --port 3000 \
  --yes
```

只有持久化状态与在线端点精确回读均通过时，`ready` 才以 0 退出；等待供应商或前台操作时
以 2 退出，不支持或失败时以 1 退出。状态与锁只适用于本机，钉钉创建采用"先持久化操作标识、
重试只对账"的防重复机制。当前安装的 DWS 列表投影会丢失必需的分页元数据，因此真实钉钉
对账处于失败关闭的外部集成 HOLD。详见[部署契约、生命周期、文件系统范围与恢复规则](docs/deploy.md)。

## 版本状态

标签版本 `0.6.0` 已通过 root/core npm 包、GHCR 和 GitHub Releases 公开发布：

| 渠道 | 安装或下载方式 |
| --- | --- |
| npm（CLI） | `npm install --global @fullstack-ai-infra/digital-employee@0.6.0` |
| npm（core） | `npm install @fullstack-ai-infra/digital-employee-core@0.6.0` |
| GHCR | `docker pull ghcr.io/fullstack-ai-infra/digital-employee:0.6.0` |
| GitHub Release | 从 [`v0.6.0`](https://github.com/fullstack-ai-infra/digital-employee/releases/tag/v0.6.0) 下载 root/core 包和校验文件 |

独立的 `@fullstack-ai-infra/digital-employee-core@0.6.0` npm 包已经公开。一次性 registry
bootstrap 已完成，后续版本由 `release.yml` 通过 npm Trusted Publishing 发布。当前 `main`
已包含标签之后的改动，本身不代表一个已发布版本。不要覆盖或重新标记任何已发布版本，
包括 `0.6.0`、`0.5.0`、`0.4.0`、`0.3.0` 或 `0.1.0`。

冻结的 `0.1.0` 兼容版本通过三个公开渠道分发：

| 渠道 | 安装或下载方式 |
| --- | --- |
| npm | `npm install --global @fullstack-ai-infra/digital-employee@0.1.0` |
| GHCR | `docker pull ghcr.io/fullstack-ai-infra/digital-employee:0.1.0` |
| GitHub Release | 从 [Releases](https://github.com/fullstack-ai-infra/digital-employee/releases) 下载软件包和校验文件 |

这个版本只有历史答疑运行时；容器默认启动旧 HTTP 演示，不包含 Qoder，也没有新的员工包
命令：

```bash
docker run --rm -p 3000:3000 \
  ghcr.io/fullstack-ai-infra/digital-employee:0.1.0
```

当前源码的 `Dockerfile` 只安装已经验证的 npm 候选制品，不会重新从源码树构建，默认只
显示帮助。先按[候选制品构建与暂存步骤](docs/distribution.md)准备同一个 tarball；只有
明确测试兼容运行时时才进入 `legacy`：

```bash
docker build -t digital-employee:candidate .
docker run --rm digital-employee:candidate
docker run --rm -p 3000:3000 digital-employee:candidate \
  legacy serve \
  --config ./node_modules/@fullstack-ai-infra/digital-employee/dist/configs/demo.json \
  --host 0.0.0.0 --port 3000
```

## 不是只开源一个机器人，也不是再造一个 Agent

`answer-agent` 是历史员工用例，不是当前源码已经 shipped 的 Agent-native recipe，也不是
整个产品。员工包负责定义：

- 它是谁、服务什么领域；
- 可以读取哪些知识和调用哪些 MCP 能力；
- 对 Agent host 有哪些强制能力要求；
- 哪些目录只读，哪些操作必须审批；
- 没把握时交给谁。

同一个员工包后续可以投影到不同 Agent host；同一个外层运行时也可以承载项目助理、运营
员工等岗位，而不需要复制消息、记忆、权限和审计代码。新主线的目标是更进一步：把岗位
放进组织树，用 `chat @岗位` 直接点名，让长期 Context 由 `mem` + `context` 承载。

Agent-native 新路径使用 `employee-package.v1alpha1`；其中 `SKILL.md` 是角色和工作流
真源，JSON Schema 是输入输出契约，MCP 是文档、网盘、DWS 等外部能力的通用接口。
`AGENTS.md`、Claude/Qoder 配置和启动参数只是 Host Adapter 生成的投影。

原 `employee-profile.v1` 继续服务 `standalone-v1` 兼容路径。契约与迁移方式见
[Profile manifest 说明](docs/profile-manifest.md)。

## 五分钟跑通 `standalone-v1` 演示

需要 Node.js 20 或更高版本。默认演示只读取仓库里的公开示例资料，不需要模型密钥、钉钉
应用或 DWS 登录。

```bash
git clone https://github.com/fullstack-ai-infra/digital-employee.git
cd digital-employee
npm install
npm run legacy:demo -- --question "What should I include in an incident report?"
```

它会从批准的示例手册中提取相关段落，并附带来源：

```text
Based on the approved source “Example team handbook”:

## Incident reports
Include the application version, sanitized command, complete error category,
and the time window...

Sources:
- Example team handbook: source://demo-handbook/handbook.md
```

再问一个需要实际执行的请求：

```bash
npm run legacy:demo -- --question "Approve a production deployment for me."
```

只读岗位不会假装已经操作：

```text
I could not find enough approved evidence. Please ask a maintainer.

Human review: human-support (model_requested)
```

## `standalone-v1` 的四种入口

权威入口统一放在 `digital-employee legacy ...` / `npm run legacy:*` 下。旧的顶层 `ask`、
`sync`、`start`、`serve` 在 `0.x` 仅作为带警告的兼容别名保留；Agent-native 的 `run`
不会在 Host 失败时自动回退到这里。

单次问答：

```bash
npm run legacy:ask -- --config ./configs/demo.json --question "..."
```

交互式命令行：

```bash
npm run legacy:start -- --config ./configs/demo.json
```

本地 HTTP：

```bash
npm run legacy:serve -- --config ./configs/demo.json --port 3000
```

内置 HTTP 入口默认无状态，并拒绝客户端自选 `requestId`、`actorId` 和 `sessionId`，避免
共享 Bearer Token 的调用方串到其他人的会话历史。需要多轮 HTTP 会话时，应先在核心前增加
按用户认证的网关。

钉钉 Stream：

```bash
cp configs/dingtalk-dws.example.json configs/local.json
export DINGTALK_CLIENT_ID='...'
export DINGTALK_CLIENT_SECRET='...'
export OPENAI_API_KEY='...'
npm run legacy:start -- --config ./configs/local.json --channel dingtalk
```

钉钉适配器会先把用户与会话标识哈希化，再交给通用运行时。默认日志不输出问题正文、用户
ID 和会话 Webhook。

## DWS：数字员工连接钉钉工作空间的能力层

在 Agent-native 路径中，DWS 应作为受权限控制的 MCP/能力层；在现有 `standalone-v1` 中，
答疑岗位通过只读 source connector 读取经过批准的：

- 钉钉文档；
- AI 听记摘要与转写；
- 指定群、指定时间范围内的聊天记录；
- Wiki 空间和节点；
- 钉盘文件元数据。

DWS 连接器要求显式 `profile` 和逐条 `approvedQueries`。它不会自动选择账号、扫描整个
组织、自动翻页或跟随搜索结果读取更多对象。详细边界见 [DWS 连接器文档](docs/connectors/dws.md)。

DWS 的安装、授权和完整能力请查看
[DingTalk Workspace CLI 开源仓库](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)。

## 已发布能力（0.4.0 历史基线与当前增量）

| 能力 | 状态 |
| --- | --- |
| `employee-package.v1alpha1`、`agent-host.v1` 与能力协商 | 已发布（`0.4.0`） |
| `init`、静态 `validate`、本机 `doctor` | 已发布（`0.4.0`） |
| Qoder CLI 1.1.x 无状态只读 `run --engine qoder` Adapter | 已发布（`0.4.0`）；未使用真实模型权益验收 |
| Claude Code `>=2.1.214 <2.2.0`、Qwen Code `0.17.1`、CodeBuddy Code `2.106.4` 上下文 Adapter | 已发布（`0.4.0`）；未使用真实模型权益验收 |
| 绑定员工包的 `deploy`：HTTP 可验证就绪、Console 等待前台操作 | 已发布（`0.4.0`）；钉钉对账受当前 DWS 分页契约阻断且无真实供应商 E4 证据 |
| 签名任务、包摘要、本机快照、租约 fencing、事件链、Runner 签名回执 | 已发布（V0.3 源码技术预览） |
| 卖家自有长期 Runner 进程、本地持久 replay/outbox 和重连 | 旧轨已收尾；保留范围以[处置台账](docs/roadmap.zh-CN.md#旧轨收尾与-issue-处置) KEEP 线为准 |
| 服务端设备注册、任务分发、用量核验、Quote/Credit 和结算 | 私有平台；不进入本框架仓库 |
| `workspace init`（oss-maintainer 模板） | 最初随 `0.5.0` 发布预览；包含于当前 `0.6.0`（#156） |
| `org tree` / `org apply` | 最初随 `0.5.0` 发布预览；包含于当前 `0.6.0` |
| 负责人 → 一个直接下属的显式委派 | 最初随 `0.5.0` 发布 deterministic E3 预览；包含于当前 `0.6.0`，未 live-qualified |
| `chat @岗位` 与持久化 Workbench 集成 | 规划中；Epic #155 第一里程碑 |
| 可选 Memory/Context 召回与岗位权限强制 | `0.6.0` 已发布引擎接缝预览；默认关闭，不代表持久化产品闭环 |
| 持久长期 Context、Workbench 连续性与 context 蒸馏 | 规划中；未随 v0.6.0 召回接缝发布 |
| 内建执行引擎 | `0.5.0` 起发布 `./engine` 与 `turn run` 预览；完整默认 Host Workbench 旅程仍在规划中 |
| oss-maintainer 展示案例 | 规划中；Epic #155 |
| Codex CLI 运行 Adapter | 仅探测；受阻于无法可靠移除所有模型可见内建工具 |
| `standalone-v1` 岗位及渠道、知识源、模型、工具 registry | 已发布；兼容路径 |
| 只读 `answer-agent` 岗位 | 已发布 |
| `standalone-v1` Console 与 HTTP 入口 | 已发布 |
| `standalone-v1` 钉钉 Stream 入口 | 已发布；真实应用凭证集成验证需要单独环境 |
| 文件、Git、DWS 知识源 | 已发布 |
| 引用、人工接力、仅确认反馈后学习 FAQ | 已发布 |
| 项目助理、运营员工等员工包 | 规划中 |
| 写工具与审批流 | 规划中；首版禁用 |
| 市场、定价、可信用量与结算 | 独立私有平台；不进入本框架仓库 |

## 安全默认值

- `answer-agent` 默认只读。
- 不发现知识源，不做全账号采集。
- DWS 命令和参数均使用只读白名单，并强制 JSON 输出。
- `answer-agent` 的回答如果没有解析到批准来源中的有效引用，会直接转人工。
- 模型请求、DWS 子进程和钉钉回复都有超时及大小限制。
- OpenAI-compatible 地址默认拒绝字面量和 DNS 解析后的私网地址，只有显式开启
  `allowPrivateNetwork` 才能使用。
- 钉钉会话 Webhook 只接受官方 HTTPS 域名。
- 会话记忆有 TTL 和容量上限。
- FAQ 只有在反馈被明确标记为已验证后才会学习。
- 结构化错误自动清理凭证字段，不返回调用栈。

接入私有知识或新增工具前，请先阅读 [SECURITY.md](SECURITY.md) 和
[架构说明](docs/architecture.md)。[验证账本](docs/verification.md) 会明确区分自动化测试、
容器实测、DWS 真实读取以及尚未完成的真实凭证验证。

## 与 `design-system`、平台和 `mem` 的关系

`design-system` 只是未来管理页面可复用的 UI 资产，不是 `digital-employee` 的运行时。
marketplace 上架、租赁、动态价格、可信计量、评价和分账属于公司内私有工作；本仓库负责
"员工能被一致构建、校验，并在发布者机器上安全运行，最终作为一个可点名的数字组织存在"。
平台不能导入或托管 Agent Host 执行代码。

[`mem`](https://github.com/fullstack-ai-infra/mem) 是新主线上长期 Context 的底座：岗位
对话产生的决策与任务状态写入记忆平面，新会话/换 Host 后可召回续接；本仓库不重复建设
memory plane。当前严格类型边界、固定版本 HTTP 适配器、凭证与授权职责见
[MemoryPort 接入说明](docs/memory-port.md)。当前公开 `0.6.0` 引擎预览可显式接入
该端口做回合前召回，但默认停用；这不等于持久化 Workbench、自动记忆写入或完整长期
Context 产品闭环。

在 Agent-native 路径中，`mem` 应位于经过批准的扩展边界之后；`standalone-v1` 只为兼容
保留历史答疑编排、引用、反馈和人工接力能力，不能据此把答疑流程重新定义为整个 Digital
Employee 的核心。

## 开发

```bash
npm ci
npm run typecheck
npm run build
npm run check
npm audit --omit=dev --audit-level=high
```

应用、运行时包、连接器、岗位配置与测试均以 TypeScript 作为唯一源码。
`npm run build` 会在 `dist/` 生成可执行 ESM、类型声明、source map 和公开 demo 资源；
npm 包导出和 CLI 只执行这些编译产物。`scripts/` 目录中的 JavaScript 仅用于构建、安全与
发布自动化，不在运行时 import 链路中。

贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。项目采用 [Apache-2.0](LICENSE) 许可证。
