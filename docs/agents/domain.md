# Domain Docs

本文件规定工程 Skills 在探索 Ailu 代码前如何读取领域文档。

## 探索前读取

- 读取仓库根目录的 `CONTEXT.md`。
- 如果将来出现 `CONTEXT-MAP.md`，按其中的指引读取与当前任务相关的 `CONTEXT.md`。
- 读取 `docs/adr/` 中与当前修改范围相关的 ADR。

如果这些文件尚不存在，继续工作，不把缺失本身当作错误，也不要求为无关任务提前创建。`domain-modeling`、`grill-with-docs` 等 Skill 会在领域词汇或架构决策实际形成时按需创建。

## 文件结构

Ailu 使用 single-context：

    /
    ├── CONTEXT.md
    ├── docs/
    │   ├── agents/
    │   │   ├── issue-tracker.md
    │   │   ├── triage-labels.md
    │   │   └── domain.md
    │   └── adr/
    │       ├── 0001-example-decision.md
    │       └── ...
    └── src/

## 使用领域词汇

当 Issue 标题、规格、重构提议、假设或测试名称涉及领域概念时，使用 `CONTEXT.md` 中定义的术语。

如果需要的概念尚未收录：

1. 先判断是否在创造项目不需要的新术语。
2. 如果确实存在领域缺口，通过 `domain-modeling` 补充。
3. 不要在不同模块中为同一概念引入不同名称。

## ADR 冲突

如果新的规格或实现与已有 ADR 冲突，必须明确指出，不能静默覆盖：

> 与 ADR-0007 冲突——建议重新讨论，因为……

ADR 未被替代前，现有决策仍然有效。
