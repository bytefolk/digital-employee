# 已批准资料：合并（pr-merger）

本目录是本岗位**唯一**的已批准知识来源。放进来即代表它已被审阅、可以依据。

## 当前内容

本岗位包不自带组织规范副本。开工前从目标仓库现读：

- 组织级工程基线：`<org>/.github` 的 `ENGINEERING.md`（语言与署名、分支与提交规则、测试与证据要求、issue 治理、PR 门禁、评审规则、合并前置条件）。
- 仓库级规范：目标仓库的 `CONTRIBUTING.md`、`.github/CODEOWNERS`、`.github/PULL_REQUEST_TEMPLATE.md`、以及它自己的接口契约文档。

```sh
gh api "repos/<org>/.github/contents/ENGINEERING.md" -H "Accept: application/vnd.github.raw"
gh api "repos/<owner>/<repo>/contents/.github/CODEOWNERS" -H "Accept: application/vnd.github.raw"
```

## 为什么不内置副本

规范会变。内置副本一定会漂移，而**漂移的规范比没有规范更危险**——它会让岗位按过时的门槛放行。这里只写"去哪里读、怎么读"，不写"规范说了什么"。

## 本岗位的身份

`author-merger`。开工前用 `gh api user` 确认，与岗位不符就停下并上报。详见 `SKILL.md` 的「身份与凭据」一节与团队 README 的权限表。

## 待补充

把本组织特有的约定放进来（可用标签、必须走的评审人、灰度与回滚约定、哪些检查是 required）。**不要**放凭据、个人信息或未经审阅的材料。
