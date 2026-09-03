# Issue Tracker: GitHub

本仓库的 Issue 和规格统一记录在 `PengLiuXiao/ailu` 的 GitHub Issues，使用 `gh` CLI 操作。

## 约定

- 创建：`gh issue create --title "..." --body "..."`
- 查看：`gh issue view <number> --comments`
- 列表：`gh issue list --state open --json number,title,body,labels,comments`
- 评论：`gh issue comment <number> --body "..."`
- 添加标签：`gh issue edit <number> --add-label "..."`
- 移除标签：`gh issue edit <number> --remove-label "..."`
- 关闭：`gh issue close <number> --comment "..."`

在仓库 clone 内运行时，默认从 `git remote -v` 推断目标仓库。Ailu 的规范目标是 `origin`：`PengLiuXiao/ailu`，不要把内部工作项发布到 `upstream`。

## Pull Requests as a triage surface

**PRs as a request surface: no.**

外部 PR 默认不进入 Issue triage 队列。如需改变，可直接将本文件中的标志改为 `yes`。

GitHub 的 Issue 和 PR 共用编号空间。遇到裸编号 `#42` 时，先使用 `gh pr view 42` 判断是否为 PR，再回退到 `gh issue view 42`。

## 当 Skill 要求“publish to the issue tracker”

创建 GitHub Issue。

## 当 Skill 要求“fetch the relevant ticket”

运行 `gh issue view <number> --comments`，同时读取当前标签。

## Wayfinding 操作

`wayfinder` 使用一个 map Issue 管理多个子 Issue：

- Map 使用 `wayfinder:map` 标签。
- 子 Issue 优先使用 GitHub sub-issue；不可用时，在正文顶部写 `Part of #<map>`。
- 子 Issue 使用 `wayfinder:<type>` 标签，其中 type 为 `research`、`prototype`、`grilling` 或 `task`。
- 阻塞关系优先使用 GitHub 原生 issue dependencies；不可用时，在正文顶部写 `Blocked by: #<number>`。
- Claim Issue 时添加当前用户为 assignee。
- 完成后先添加结论评论，再关闭 Issue，并更新 map 的 Decisions-so-far。
