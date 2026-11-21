# 员工配置能力中心（Capability Marketplace）

> 状态：能力市场清单 + 校验层已落地（本仓库）。qoder Agent Host 的 MCP stdio 打通已完成、http 传输待与 network 政策一并决定；RoleWeave 桌面端集成为后续阶段。

> **http transport 条目的 UI 处置**：`capabilities/market.json` 里 searxng 等 http transport 条目**先上架但 UI 标为「暂不可用」**——它们作为合法的 capability 声明可浏览、可看安全元数据，但在 qoder adapter 的 http 传输未落地前（`qoder_mcp_http_transport_unsupported`），不能装配到员工包、不能被宿主运行时加载。待 http + network 政策一并决定后再放开装配。

## 1. 它是什么

「员工配置能力中心」是 digital-employee 里给数字员工装配**可复用能力**的目录/市场。一个「能力（capability）」是员工可以挂载的一块东西，目前分三类：

| kind | 含义 | 例子 |
|------|------|------|
| `mcp` | 一个 MCP 服务器（stdio 或 http 传输） | playwright、searxng、filesystem |
| `cli` | 一个可执行的命令行工具 | playwright-cli |
| `connector` | 现有岗位连接器（channel / source） | console、dingtalk、doc、git |

它不是新的协议，而是对仓库里已有的 `employee-mcp.v1alpha1`、`position-connectors.v1` 等能力的**产品化索引**：给每个能力补齐安全元数据（凭证环境变量、网络出口意图、风险等级），让 UI 能浏览筛选、让 Agent Host adapter 能做安全决策。

## 2. 落地位置

```
configs/capability-market.schema.json   # JSON Schema（市场清单结构）
packages/core/src/capability-market.ts  # 校验 + 类型（fail-closed）
capabilities/market.json                # 内置第一批能力（数据文件）
tests/core/capability-market.test.ts    # 单测
```

清单格式：`capability-market.v1alpha1`。每个能力条目必填 `id/kind/title/description/risk/auth/network`，可选 `homepage/license/tags`，并按 `kind` 携带 `transport`（mcp）或 `command`（cli）或 `connector`（connector）。

### 安全元数据（与普通散装 MCP 列表的区别）

- `auth.required / auth.optional`：只列**环境变量名**，secret 值永远留在 host 进程环境里，清单不碰真实凭证。
- `network.{required,hosts}`：声明该能力是否需要外网、以及 egress 意图主机。
- `risk`：`low | medium | high`，供 UI 与 adapter 做默认拒绝/显式授权的分级。

所有校验对齐仓库 fail-closed 风格：未知字段、重复 id、kind 与 shape 冲突、非 HTTPS 传输、非法环境变量名，一律抛错，绝不静默放行。

## 3. 调研结论（2026-09）

### 3.1 computer use / chrome use（浏览器自动化）

| 能力 | 仓库 | stars 量级 | 许可 | 说明 |
|------|------|-----------|------|------|
| `playwright` | microsoft/playwright-mcp | 官方 | Apache-2.0 | 基于 accessibility tree，模型读结构化的页面状态，不靠截图。**默认 computer-use 首选** |
| `browser-use` | browser-use/browser-use | ~116k | MIT | 像人一样操作真浏览器，能点、能填表、能过一个部分的 CAPTCHA；本身是 agent，需模型 key |
| `invisible-playwright` | feder-cr/invisible_playwright_mcp | ~31.6k | MIT | stealth Firefox，专门绕过反爬/验证码，`uvx invisible-playwright-mcp` |

### 3.2 搜索引擎 MCP（合规说明）

- **Google 没有官方 Search MCP**。「Google 搜索 MCP」只有两类：官方 **Custom Search JSON API**（付费、有配额、走官方 API）和第三方抓 SERP 结果页（违反 Google ToS）。本市场**只收录 Custom Search JSON API 这类合规实现**，不收录抓结果页的灰产实现。
- **Brave**：官方 `@modelcontextprotocol/server-brave-search` 已 **deprecated**（npm 已标记）。改用 Brave 官方 `@brave/brave-search-mcp`。
- 主力推荐 **SearXNG**（自托管元搜索，聚合 Google/Bing/Brave/DuckDuckGo，无广告、无抓取条款风险），配 **Brave / Tavily** 作托管 API 兜底。
- **百度不上**（按需求：广告多、反爬重，价值低）。

### 3.3 官方基础 server

`filesystem`、`memory`、`git`、`fetch`（`@modelcontextprotocol/server-*` / `uvx mcp-server-*`），作为员工本地能力的基础件。

## 4. 后续阶段

1. **qoder Agent Host MCP 打通（stdio 已完成，http 待定）**：`apps/cli/qoder-agent-host.ts` 已将 MCP 从 `mcp=unsupported` 改为 `supported`；新增 `apps/cli/qoder-mcp-config.ts`，把员工声明的 stdio MCP 条目 fail-closed 翻译成 qoder 的 `--mcp-config` JSON（凭据只发 `${NAME}` 引用、永不落盘），并受控放开 `mcp__*` 工具白名单与 `--allowed-mcp-server-names`。http 传输仍刻意拒绝（`qoder_mcp_http_transport_unsupported`），需与 network 政策的有条件放开一起单独设计。
2. **RoleWeave 桌面端集成**：读取 `capabilities/market.json`，提供「给某岗位装配 MCP/CLI 能力」的界面，装配结果落成该岗位的 employee-mcp 声明。

> license 字段以各仓库 LICENSE 文件为准；`homepage` 可直接核实。第三方启动命令可能随上游演进，接入前按各自 README 复核。