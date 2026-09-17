# context/

岗位运行时的工作目录。

- `clone-rw/` —— 提交岗克隆的目标仓库，可写。
- `archive/` —— 只读快照或历史导出。

`context/` 下是**运行产物，不是团队定义**，不应随仓库提交（团队定义只有 `workspace.json`、`organization.v1alpha1.json`、`grant.template.json`、`positions/`、`README.md`）。克隆前先确认目标仓库与默认分支，克隆后**先读它的工程规范再动手**。
