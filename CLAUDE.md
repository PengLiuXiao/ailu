# Ailu 工作规则

## 项目定位

Ailu 是 Obsidian 桌面插件，用于本地 Agent 对话、内容预览、公众号草稿、飞书文档同步和 X Article 草稿创建。所有改动先考虑 Obsidian 用户的真实操作路径：安装、首次启动、设置、草稿确认、失败恢复和本地数据边界。

## 规则来源

- `CLAUDE.md` 是唯一项目规则真身。
- `AGENTS.md` 必须是指向 `CLAUDE.md` 的软链接。
- 修改规则时只编辑 `CLAUDE.md`，不要直接编辑 `AGENTS.md`。

## 开发约定

- 默认使用中文沟通；代码、命令、变量名使用英文。
- 遵守现有源码结构，避免无关重构。
- 用户可触达的体验优先于技术偏好：错误提示要能引导下一步，确认流程不能被绕过。
- 不把密钥、token、cookie、账号凭证写入仓库。
- Windows 相关写入能力保持 fail-closed，不为了通过测试放宽安全边界。

## 常用命令

- 安装依赖：`npm ci`
- 开发构建监听：`npm run dev`
- 单元测试：`npm test`
- lint：`npm run lint`
- 完整检查：`npm run check`
- 依赖审计：`npm run audit:dependencies`
- Release 验证：`npm run verify:release`

## Git 与远端

- `origin` 指向 Vincent 的 fork。
- `upstream` 指向原仓库 `mcncarl/ailu`。
- commit message 使用英文，简洁描述变更意图。
- 不自动 `git push`，除非 Vincent 明确要求。

## Agent skills

### Issue tracker

Issue 和规格统一记录在 `PengLiuXiao/ailu` 的 GitHub Issues。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用五个默认 triage 标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。详见 `docs/agents/triage-labels.md`。

### Domain docs

采用 single-context：根目录 `CONTEXT.md` 记录领域词汇，`docs/adr/` 记录架构决策。详见 `docs/agents/domain.md`。
