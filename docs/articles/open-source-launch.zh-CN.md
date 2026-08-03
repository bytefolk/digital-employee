# [v0.1 历史稿] 我把运行三个月的 D仔开源了：企业答疑机器人的真实案例与复用路径

> **版本说明（2026-08-03）：** 本文冻结记录 `v0.1.0` / `871ffb8` 的
> `standalone-v1` 答疑运行时，不代表当前 main 分支的默认产品路径。文中“当前仓库”、
> “当前 CLI”和 69 项测试均指该历史版本；复现命令必须 checkout `v0.1.0`。
> 当前 main 已转向 Agent-native CLI + 员工包 + Host Adapter，默认 `npm start`
> 只显示帮助，旧运行时需显式使用 `legacy:*`。请以仓库首页 README 为准。

> **项目已经开源：[fullstack-ai-infra/digital-employee](https://github.com/fullstack-ai-infra/digital-employee)。**
>
> 如果你也在群里反复回答同一批问题，可以先用仓库自带的零凭证 Demo 跑通，再换成自己的手册、代码仓库或经 DWS 授权的钉钉知识。

D仔最早是一个面向 DWS 的答疑机器人。它在真实钉钉会话里运行三个月后，我把其中能复用的部分拆成了一个通用的 Digital Employee 运行时；企业答疑机器人 `answer-agent`，只是它交付的第一个岗位。

这篇不从架构图开始。先看 D仔真正遇到过什么问题、怎么回答，以及什么时候没有继续猜。

## 一、先看三组真实答疑现场

下面的图片均来自真实钉钉会话。其他参与者的姓名、头像、工号和专家身份已经像素化，截图水印中的姓名与工号也已清除；我的头像与 D仔头像保持一致；除隐私字段外，问题和回答正文没有改写。

这些截图展示的是早期 D仔的真实运行结果，不是把开源版界面重新画成钉钉聊天。公开仓库复用了这些现场问题背后的机制，但不把一张成功截图当成“所有能力都已经生产验证”的证明。

### 案例一：用户问“群公告能力是不是取消了”，D仔没有硬答

用户拿着一次直播里的演示来问：以前看到过“发布群公告”，现在是不是取消了？

![D仔核对群公告能力并交给产品侧确认](../assets/dzai-real-group-announcement.png)

D仔先说清楚自己没有那场直播的记录，无法确认当时演示的具体内容；再核对当前 DWS 仓库，指出当时命令面里没有独立的“发布群公告”命令，现有配方本质上仍是调用消息发送接口模拟公告。至于钉钉客户端的原生群公告能力是否调整，它明确交给产品侧确认。

这段回答的价值不在于说了多少，而在于把边界分开了：

- 当前代码和公开文档能够证明什么；

- 历史直播里可能演示过什么；

- 哪一部分必须由产品或平台专家确认。

企业答疑机器人真正危险的情况，不是偶尔说“不知道”，而是把一段看似合理的推测包装成确定答案。

### 案例二：一句“没有报错”让听记问题进入第二轮排查

群里有同学问：以前能拿到听记逐字稿，现在为什么只有摘要，是不是功能被去掉了？

第一轮里，D仔先确认获取逐字稿的命令仍然存在，再给出权限和分页两个排查方向，并请对方补充具体错误。对方随后引用原消息追问：“没有报错，就说没有原文，只有摘要内容。”

![用户追问后 D仔继续核对听记权限](../assets/dzai-real-minutes-followup.png)

第二轮不再重复第一轮答案，而是把范围继续收窄到听记的权限子模块：如果创建者共享时只包含摘要权限，没有包含原文权限，就可能出现“能拿摘要、拿不到原文，也不报错”的现象。D仔同时给出了当时核对的 [DWS 听记最佳实践](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/skills/mono/references/best_practices/07-minutes.md)，让用户可以继续和创建者核验。

保留下来的会话没有用户最终确认，所以这里不能写成“问题已经解决”。它能证明的是：D仔接住了引用追问，重新查了证据，并给出下一步可验证的方向。

截图保留的是当时的真实回答口径；命令参数和产品规则会继续演进，实际使用时仍应以 DWS 当前仓库为准。

### 案例三：跨组织群消息问题，机器人回答代码，专家回答策略

还有同学问：“群消息提取，有没有组织限制？”

D仔能够从 DWS 代码层确认：`chat message list --group <id>` 没有再做一层群组织归属校验；但底层开放接口对跨企业群、外部群消息是否有额外权限限制，仅靠静态代码无法证明。它没有替平台策略拍板，而是把问题交给更合适的人。

下面的真实讨论串保留了 D仔的首轮回答。用户继续追问多个组织的情况，群内成员补充了“群在当前组织下”的预期边界，以及新版本对多组织登录的支持。

![跨组织群消息问题由群内成员继续接力](../assets/dzai-real-cross-org-thread.png)

这正是“转人工”应该有的样子：机器人先把已经查清的实现事实讲明白，再把剩余问题和上下文交给真正掌握策略的人，而不是只回复一句“请联系管理员”。

三组现场对应了企业答疑里最常见的三类工作：

- 资料里有确定证据，直接回答并给出处；

- 用户继续补充现场信息，带着上下文进入下一轮；

- 静态资料无法证明平台策略，及时交给专家。

## 二、D仔不是一份 FAQ，它需要持续接回真实知识

D仔第一版的链路很短：钉钉 Stream 收到问题，只读分析 DWS 仓库，再通过原会话 Webhook 回复。进群以后才发现，事实不只在代码里：

- 参数和兼容规则在代码与命令文档里；

- 团队约定、SOP 和产品说明在钉钉文档或知识库里；

- 会议结论和决策背景可能在 AI 听记里；

- 已经被反复回答的问题散落在经授权的群聊记录里；

- 暂时无法写进正式文档的经验，还需要专家现场补充。

早期 D仔真正接入运行时的，是两个白名单 DWS 开源交流群的历史问答。原始消息由 `dws chat message list` 离线读取，经过脱敏后生成本地知识库；线上回答时读取的是这份本地知识，不会每收到一个问题就实时扫描整个钉钉账号。

开源版把这条路径做成了可配置的 [DWS 知识连接器](https://github.com/fullstack-ai-infra/digital-employee/blob/871ffb8ef95bcfaaa50c5e698ddde1c43459f567/connectors/sources/dws/index.js#L84-L210)。在当前身份本来就有访问权限、对象也经过明确批准的前提下，下面这些内容可以成为知识来源：

- 钉钉文档：产品说明、SOP、制度和操作手册；

- AI 听记：摘要、关键词和逐字稿；

- 指定群、指定时间范围内的聊天记录；

- Wiki 空间与节点；

- 钉盘文件元数据；如果搜索结果指向钉钉文档节点，再对这个确定节点批准 `doc read`。

配置不会让机器人自己发现账号或遍历工作空间。每一项都要写成明确的 `profile + approvedQueries`。例如，只批准读取一份测试文档：

```json
{
  "id": "approved-dingtalk-knowledge",
  "type": "dws",
  "profile": "corp-id:user-id",
  "approvedQueries": [
    {
      "name": "team-handbook",
      "command": ["doc", "read"],
      "args": ["--node", "approved-node-id"]
    }
  ]
}
```

公开实现会对 DWS 命令和参数再次做只读门禁，拒绝写命令、账号发现、全账号聊天搜索、文件下载，以及覆盖 `--profile`、`--format` 或凭证的参数。可以直接查看 [命令白名单](https://github.com/fullstack-ai-infra/digital-employee/blob/871ffb8ef95bcfaaa50c5e698ddde1c43459f567/connectors/sources/dws/policy.js#L30-L238)、[参数门禁](https://github.com/fullstack-ai-infra/digital-employee/blob/871ffb8ef95bcfaaa50c5e698ddde1c43459f567/connectors/sources/dws/policy.js#L317-L424) 和 [DWS 连接器配置说明](https://github.com/fullstack-ai-infra/digital-employee/blob/871ffb8ef95bcfaaa50c5e698ddde1c43459f567/docs/connectors/dws.md#L7-L177)。

这里有三条不能跳过的边界。

第一，DWS 使用当前登录身份本来就有的权限，不会绕过钉钉权限。能列出来不等于应该采集；群聊、听记和文件都需要对象白名单、用途、保留周期和清理规则。

第二，DWS 连接器不是脱敏器。它会排除名称类似 Token、Secret、Password 的结构化字段，但不会自动识别正文中的姓名、手机号、邮箱、工号或未公开讨论。知识进入模型前，仍要单独完成授权和脱敏。

第三，这次公开发布只用一份专门准备的公开测试文档完成了真实 `doc read` 在线验证。听记、群聊、Wiki 和钉盘已完成命令契约与安全边界测试，但没有在本次发布中拿真实业务账号逐项在线验证；钉盘当前也只提供文件元数据检索，不能写成“所有文件正文已经入库”。

## 三、这次开源的不是一个 D仔壳子，而是一套数字员工运行时

我不希望开源用户复制一份 D仔代码，再把名称和 Prompt 换掉。去重、会话、知识、引用、转人工和连接恢复这些问题，每一个岗位都会重新遇到。

所以公开仓库里有两层：

- [Digital Employee Core](https://github.com/fullstack-ai-infra/digital-employee/tree/871ffb8ef95bcfaaa50c5e698ddde1c43459f567/packages/core) 是通用运行时，负责会话、排队、检索、引用、反馈和转人工判定；

- [`answer-agent`](https://github.com/fullstack-ai-infra/digital-employee/blob/871ffb8ef95bcfaaa50c5e698ddde1c43459f567/profiles/answer-agent/index.js#L1-L22) 是第一套岗位配置，定义“只读答疑、必须有依据、没有把握就交给人”。

同一套运行时还可以继续承载项目助理、运营员工等岗位，但当前 `0.1` 真正交付的只有 `answer-agent`。后续岗位要复用渠道、知识、模型和错误处理契约，而不是先复制一套机器人代码。

当前仓库已经提供：

- Console、HTTP 和钉钉 Stream 三种入口；

- 本地文件、公开 Git 仓库和 DWS 三类知识源；

- 零凭证的本地抽取模型，以及 OpenAI-compatible 模型连接器；

- 引用校验、低证据转人工、消息去重、同用户忙时拒绝和全局并发队列；

- 钉钉 Stream 的立即 ACK、有限重连、长回复安全分段和官方 Webhook 域名校验；

- 69 项自动化测试，以及容器、DWS 在线读取和待验证项分开的验收清单。

完整代码、配置和 Issue 都在：

**[https://github.com/fullstack-ai-infra/digital-employee](https://github.com/fullstack-ai-infra/digital-employee)**

## 四、先用五分钟跑起来，再换成自己的知识

### 第一步：零凭证验证“有依据就答，没有依据就交给人”

本地 Demo 只使用仓库里的 [公开配置](https://github.com/fullstack-ai-infra/digital-employee/blob/871ffb8ef95bcfaaa50c5e698ddde1c43459f567/configs/demo.json#L1-L30) 和 [测试手册](https://github.com/fullstack-ai-infra/digital-employee/blob/871ffb8ef95bcfaaa50c5e698ddde1c43459f567/examples/knowledge/handbook.md#L1-L24)，不需要钉钉、DWS 或模型密钥。Node.js 需要 20 或更高版本。

```bash
git clone --branch v0.1.0 --depth 1 \
  https://github.com/fullstack-ai-infra/digital-employee.git
cd digital-employee
npm ci

npm run sync -- --config ./configs/demo.json --json
npm run demo -- \
  --question "What should I include in an incident report?"
npm run demo -- \
  --question "Approve a production deployment for me."
```

第一问应返回公开手册里的原文片段和 `source://demo-handbook/handbook.md` 引用；第二问在没有批准证据时应返回人工接力提示。这里验证的是完整链路，不是在证明模型知道多少常识。

### 第二步：只换一份经过批准的知识

复制 [Demo 配置](https://github.com/fullstack-ai-infra/digital-employee/blob/871ffb8ef95bcfaaa50c5e698ddde1c43459f567/configs/demo.json#L1-L30)，把真实配置和知识放在仓库外，再把 `sources` 换成其中一种：

- `filesystem`：团队手册、SOP、FAQ；

- `git`：不带凭证的公开 HTTPS 仓库；

- `dws`：像上一节那样配置固定身份和批准查询。

先只接一份手册，同时准备两类问题：一类能在手册里找到明确答案，另一类明确不在手册里。前者必须带真实引用，后者必须进入转人工；两项少一项，都不要急着接群。

知识源是在实例启动时加载的，不是后台持续同步服务。内容更新后应重新执行 `sync` 检查，并重启正在运行的实例。

### 第三步：最后再接模型和钉钉

自然语言生成可以切换到 OpenAI-compatible 模型；密钥只能通过环境变量提供。钉钉入口可以直接参考 [完整配置示例](https://github.com/fullstack-ai-infra/digital-employee/blob/871ffb8ef95bcfaaa50c5e698ddde1c43459f567/configs/dingtalk-dws.example.json#L1-L55)，真实配置不要提交到公开仓库。

```bash
export DINGTALK_CLIENT_ID="replace-with-your-client-id"
export DINGTALK_CLIENT_SECRET="replace-with-your-client-secret"
export OPENAI_API_KEY="replace-with-your-key" # 仅 OpenAI-compatible 需要

npm start -- \
  --config /absolute/path/to/your-dingtalk-config.json \
  --channel dingtalk
```

当前 CLI 不会自动读取 `.env`。第一次接入建议在专用测试群前台运行，用真实的一问一答确认 Stream 收发成功；不要只看进程没有退出，就判断机器人仍然在线。

## 五、技术上我只保留了五个关键点

文章不再展开每个类和配置字段，想深挖时可以直接跳到实现：

1. **知识只能来自批准入口。** 文件、Git、DWS 都在运行时显式装配；DWS 还要经过单独的命令和参数白名单。入口在 [`createRuntime()`](https://github.com/fullstack-ai-infra/digital-employee/blob/871ffb8ef95bcfaaa50c5e698ddde1c43459f567/apps/cli/runtime.js#L100-L149)。

2. **模型不能自己发明出处。** 最终引用只会从本次检索证据里的真实 ID 解析，见 [`#resolveCitations()`](https://github.com/fullstack-ai-infra/digital-employee/blob/871ffb8ef95bcfaaa50c5e698ddde1c43459f567/packages/core/src/digital-employee.js#L383-L389)。

3. **没把握就返回结构化转人工信号。** 置信度、证据数、有效引用、模型错误和自定义规则共同进入 [`EscalationPolicy`](https://github.com/fullstack-ai-infra/digital-employee/blob/871ffb8ef95bcfaaa50c5e698ddde1c43459f567/packages/core/src/escalation-policy.js#L48-L107)。

4. **重复投递和多人并发分开处理。** 消息入口先做 TTL 去重，核心任务再按 `requestId` 去重；同一用户忙时拒绝，不同用户进入全局队列，见 [`message.js`](https://github.com/fullstack-ai-infra/digital-employee/blob/871ffb8ef95bcfaaa50c5e698ddde1c43459f567/connectors/channels/dingtalk/message.js#L121-L172) 和 [`job-runner.js`](https://github.com/fullstack-ai-infra/digital-employee/blob/871ffb8ef95bcfaaa50c5e698ddde1c43459f567/packages/core/src/job-runner.js#L151-L240)。

5. **钉钉在线不只看进程。** Stream supervisor 同时观察心跳、下行活动和休眠漂移；回复端校验官方域名并对长文本安全分段，见 [`stream.js`](https://github.com/fullstack-ai-infra/digital-employee/blob/871ffb8ef95bcfaaa50c5e698ddde1c43459f567/connectors/channels/dingtalk/stream.js#L65-L200) 和 [`reply.js`](https://github.com/fullstack-ai-infra/digital-employee/blob/871ffb8ef95bcfaaa50c5e698ddde1c43459f567/connectors/channels/dingtalk/reply.js#L24-L231)。

## 六、哪些是真的交付，哪些还不能宣传

当前提交的自动化测试是 69 项通过、0 项失败；更细的自动化、容器、真实 DWS 与待在线验证范围，记录在 [verification ledger](https://github.com/fullstack-ai-infra/digital-employee/blob/871ffb8ef95bcfaaa50c5e698ddde1c43459f567/docs/verification.md#L1-L32)。

已经交付的是通用运行时、只读 `answer-agent`、Console/HTTP 入口、钉钉 Stream 适配代码、文件/Git/DWS 知识源、引用与转人工判定、OpenAI-compatible 模型连接器。

下面这些边界仍然存在：

- 钉钉 Stream 需要使用者用自己的应用凭证完成在线集成验收；

- 同一用户在前一条问题处理中再次提问时，Core 会返回 `ACTOR_BUSY`，当前钉钉入口还没有把它变成用户可见的“请稍后重试”；

- Stream 有限重连耗尽后会报错，但 CLI 还没有把致命连接状态暴露成健康端点或主动退出；

- 钉钉被引用文字目前会被解析进 metadata，公开版模型连接器还没有消费它；前面听记案例展示的是早期 D仔的真实多轮效果，不代表这个缺口已经补齐；

- 已验证 FAQ 目前只有进程内 Core API，没有公开反馈入口，也没有持久化；

- 项目助理、运营员工、写工具、审批工作流仍在规划中，`0.1` 不包含托管式多租户服务。

这些不是为了给项目降温，而是让准备复用的人知道：现在可以从哪里开始，哪些地方还需要一起补。

## 七、如果它也能解决你的重复答疑，欢迎一起把它做实

Digital Employee 仓库：

**[https://github.com/fullstack-ai-infra/digital-employee](https://github.com/fullstack-ai-infra/digital-employee)**

- **Star**：如果这个方向对你有用，让更多需要企业答疑机器人的人看到它；

- **Fork**：换成自己的批准知识源，先做出一个只读岗位；

- **Issue**：把真实接入问题、失败日志和希望支持的岗位告诉我们；

- **PR**：补连接器、岗位 Profile、测试或文档，把你的实践留在公开仓库里。

DWS 是这套实践里的钉钉工作空间入口。它可以在现有身份与权限范围内，把钉钉文档、AI 听记、经授权的群聊、Wiki 和钉盘元数据提供给人或数字员工。

DWS 开源仓库：

**[https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)**

安装、授权、命令使用或 Agent 接入遇到问题，可以进入 DWS 开源沟通群：

![DWS 开源沟通群二维码](../assets/dws-community-qr.png)
