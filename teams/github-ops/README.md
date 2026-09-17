# github-ops — 处理 issue 与 PR 的员工团队

四个岗位，**提交 / 评审 / 合并分属不同的人**，用两个 GitHub 身份把「能提」与「能批」在凭据层面分开。

| 岗位 | 做 | 绝不做 | 身份 | 工具白名单 |
|---|---|---|---|---|
| `issue-triage` | 查重、复现、分流、按模板建 issue | 不改代码、不提 PR、不评审、不合并 | `author-merger` | `Read` `Grep` `Glob` `Bash` |
| `pr-author` | 实现改动、推分支、开 PR、按意见修改 | **不评审、不合并** | `author-merger` | `Read` `Write` `Edit` `Grep` `Glob` `Bash` |
| `pr-reviewer` | 独立评审，给出 `APPROVE` 或 `REQUEST_CHANGES` | **不合并、不推送**（凭据层面做不到） | **`reviewer`** | `Read` `Grep` `Glob` `Bash` |
| `pr-merger`（owner） | 核查闸门、squash 合并他人的 PR | 不写代码、不提 PR、**不批准任何 PR** | `author-merger` | `Read` `Grep` `Glob` `Bash` |

## 为什么必须是两个身份，而不是一个

**一个身份会让这套流程彻底跑不起来。** GitHub 不接受 PR 作者本人的批准：`gh pr review --approve` 对作者自己的 PR 会直接失败，分支保护所需的审核数也不计作者本人。

若四拨人共用一个身份，那么 `pr-author` 提的每一条 PR，`pr-reviewer` 都点不出 `APPROVED` → `reviewDecision` 永远拿不到 `APPROVED` → **合并闸门永远不成立，这个团队一条 PR 都合不了。**

所以最低限度：**评审身份必须独立于作者身份**。作者与合并者可以共用（GitHub 只要求「批准者 ≠ 作者」，不要求「合并者 ≠ 作者」）。

### 两个身份的细粒度 PAT 权限

| 权限 | `author-merger`（提交 + 合并） | `reviewer`（评审） | 说明 |
|---|---|---|---|
| `Contents` | **Read and write** | **Read only** | 推分支需要写；squash 合并要往基分支写提交。评审身份不给写 → **结构上合不了** |
| `Pull requests` | Read and write | Read and write | 评审要点批准/请求变更，所以需要 PR 写；合并在 `pr-merger` 侧 |
| `Issues` | Read and write | Read and write | 建 issue 与写评论 |
| `Actions` | Read | Read | 读 CI 结论与失败日志 |
| `Metadata` | Read | Read | 必选基础权限 |
| `Administration` | **不给** | **不给** | 有了它就能绕过分支保护，而这恰恰是被明令禁止的动作 |

**这张表就是真正的权限边界。** 不是岗位包里的 `policy`——见下面的「已知限制」。

`grant.template.json` 用仓库自己的 `capability-grant.v1` 记下"操作者授予了什么"，并且按仓库规矩放在 `positions/` 之外（放在包目录里会被拒绝，见 `docs/real-local-e2e.md` 的 `real_local_self_grant_rejected`）。真正的强制力来自 PAT 的 scope。

## 合并闸门（`pr-merger` 逐条核查，缺一不合并）

1. 存在 `APPROVED`，且**批准者的 login ≠ PR 作者的 login**；
2. 必需检查**针对该 PR 自己的 head** 全绿（跳过不算通过）；
3. 无未解决对话、不是 draft、未关闭；
4. **合并前一刻重读 `headRefOid`** —— 评审与检查都绑定到具体提交，head 变了它们就作废；
5. 一律 `--squash`。

**绝对禁止**：`gh pr merge --admin` 或任何管理员绕过；`gh pr review --approve`（它不是评审人）；dismiss 他人的 `CHANGES_REQUESTED`；合并 draft；关闭别人仍在推进的 PR。

**被必需检查挡住时，唯一合法的动作是修那条检查本身或请人修。**

## 一个容易踩的架构限制：委托是只读的

`docs/delegation.md` 写死了：**委托出去的子员工，上下文与工具范围只能交集或收窄，写入与下游委托一律拒绝。**

推论：**能推 PR / 合并的岗位不能是被委托的子员工**，只能是直接派单、且拿到操作者写入授予的员工。所以本团队里 `pr-author` 与 `pr-merger` 必须**直接派单**；`pr-reviewer` 可以走委托（评审本就只读）。把提交或合并挂到委托链下会静默失败——它拿不到写权限，也不会有明确报错。

## 已知限制（当前实现的真实状态）

- **`policy.network` / `policy.filesystem` / `policy.mode` 不被执行。** 在打包路径上，唯一真正生效的员工能力声明是 `permissions.json` 的 `tools`（变成宿主 CLI 的 `--tools`）。其余三项只进入应用态模型并被界面展示。**所以能力边界在凭据，不在岗位包。**
- **没有 GitHub MCP。** 内置宿主遇到员工 MCP 绑定会直接让回合失败（`qoder.mcp_binding_unsupported`），因此三个岗位包的 `mcpServers` 都是空的，GitHub 访问走 `Bash` + `gh` CLI。
- **岗位级凭据隔离做不到。** 凭据按宿主配置、不按岗位；同一个宿主下的岗位共享登录态。所以"只有评审能批"今天是**规则约束**。本目录用**两个身份 + 两个宿主环境**来把它变成能力边界：评审身份单独一份 PAT，且不给 `Contents: write`。
- **工具名要用宿主 CLI 的真名**（`Bash` / `Read` / `Write` / `Edit` / `Glob` / `Grep`）。招聘抽屉里那排工具名中的 `Exec` 不是 Claude/Qoder 的内置工具名，照抄会让白名单落空。

## 怎么改成你自己的仓库

这里**没有硬编码任何仓库名**——目标仓库由员工运行时用 `gh` 去读。你要做的是：

1. 把本组织特有约定写进各岗位 `knowledge/README.md`（可用标签、必须走的评审人、哪些检查是 required、灰度与回滚约定）。
2. 目标仓库克隆到 `context/clone-rw/`（`pr-author` 的 `policy.filesystem.write` 已声明 `./context/**`）。
3. 两个 PAT 分别注入环境变量，**不要**写进任何文件、提交或 issue 正文。

## 目录结构

```
teams/github-ops/
├── README.md                    # 本文件
├── workspace.json               # workspace.v1alpha1
├── organization.v1alpha1.json   # workspace-org.v1（owner = pr-merger）
├── grant.template.json          # capability-grant.v1，操作者持有，位于包目录之外
├── context/README.md            # 运行时工作目录（运行产物）
└── positions/pr-merger/         # 目录嵌套即汇报线（owner 为根）
    ├── employee.json  SKILL.md  permissions.json  budget.json
    ├── schemas/  knowledge/  evals/
    ├── pr-reviewer/            # 独立身份
    ├── pr-author/
    └── issue-triage/
```

**没有新造清单格式**：团队用已有的 `workspace.v1alpha1` + `workspace-org.v1` 表达，这两个契约本来就被引擎消费；汇报线用目录嵌套（与 `examples/oss-maintainer` 同构），因此每个 `positions/<id>/` 同时也是一份可独立安装的可移植员工包。

每个岗位包（除 `pr-author` 外）都不写文件；`pr-author` 只写 `./context/**`（克隆的目标仓库），不写团队定义本身。
