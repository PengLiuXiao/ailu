# Pi Agent 回归验证手册

本文档记录把 Pi 作为第三个 Agent 接入 Ailu 后的验证方式与最近一次结果。执行人是 Vincent 或其 Agent；每次发布前应重跑「完整检查」与（条件允许时）「真实 Pi 回归」。

## 自动化覆盖

| 能力 | 测试文件 |
| --- | --- |
| RPC 传输（分帧、关联、UI 请求、探测） | `tests/piAgent.test.ts` |
| Pi 运行时（流式、取消、错误恢复、会话重建、图片、权限桥） | `tests/piRuntime.test.ts` |
| 权限桥扩展行为（允许一次/本次同类/拒绝/丢弃/Plan/未知工具） | `tests/piBridgeExtension.test.ts` |
| 模型与思考级别（解析、持久化、不可用阻断、附件预检） | `tests/piModels.test.ts` |
| RuntimeManager 分发与 Windows fail-closed | `tests/piRuntime.test.ts`、`tests/piAgent.test.ts` |
| 设置迁移与 Agent 花名册 | `tests/agentSettings.test.ts`、`tests/chatAgentSelection.test.ts` |
| 会话恢复与跨 Agent 交接 | `tests/chatContextService.test.ts`、`tests/chatAgentSelection.test.ts` |
| 技能发现与显式选择 | `tests/skillDiscovery.test.ts`、`tests/piRuntime.test.ts` |
| 行内编辑隔离与确认入口 | `tests/inlineEdit.test.ts` |
| Claude Code / Codex 回归 | 全量套件中的既有测试（adapter、codexRuntime、runtimeManager 等） |

## 真实 Pi 回归（本机）

门控执行，需要本机已安装并登录 `pi`：

```bash
AILU_PI_LIVE=1 npx vitest run tests/piLiveRegression.test.ts
```

覆盖：RPC 探测、纯文本对话、模型发现、权限允许/拒绝、原生会话跨回合恢复、Plan 只读参数、显式 Skill 加载、text-only 行内编辑、并发回合隔离。

最近一次结果：**2026-09-03，Pi 0.84.4，10/10 通过**（模型 deepseek/deepseek-v4-flash，本机配置）。

## Obsidian 内手动回归清单

在 Obsidian 中按顺序核对（每项都应在 UI 上可见反馈）：

1. 设置 → Pi：显示路径/版本/RPC 状态与「重新检测」。
2. 默认 Agent 与对话 Agent 切换器中出现 Pi，缺失时给出安装引导而非半启动。
3. 文本对话：流式回复、停止只影响当前对话、无残留 Pi 进程。
4. 模型选择器：跟随本机 + 按 Provider 分组可搜索；不可用保存模型阻断发送并给出恢复路径。
5. 图片附件：支持图片的模型可发送；不支持的模型在启动前阻断并提示二选一。
6. 工具确认：写入/命令/未知工具弹窗，允许一次 / 本次同类 / 拒绝 / 关闭弹窗均按预期生效；完全访问仅跳过工具确认。
7. Plan 模式：只读边界，写操作被拒并给出计划引导。
8. 会话：重载后可恢复；删除/损坏会话后重建并弹出恢复提示、聊天记录保留；跨 Agent 交接可用。
9. 定制与信任：三模式行为不同、信任 Vault 显示加载时警告、扩展失败提示切回隔离模式、切换模式后新会话。
10. Skills：选择器区分 Pi 技能，仅勾选的进入任务。
11. 行内修改：Pi 生成建议 → diff 确认 → 采用/取消；无工具参与。

## 完整检查

```bash
npm run check
```

最近一次结果（2026-09-03，feature/add-pi-agent 分支）：

- `npm test`：1233 通过 / 10 跳过（干净工作树；跳过项为未开启 `AILU_PI_LIVE` 的真实回归。工作区含未提交 CC Switch 测试改动时为 1235 通过）。
- `npm run test:public-policy`：通过。
- `npm run lint`：0 error（存量 warning 数与接入前一致）。
- `npm run build` 与 `npm run verify:release`：**在干净工作树（暂存会话前的未提交改动与未跟踪工作区文件后）通过**。

已知环境性阻塞（与 Pi 改动无关）：

- 工作区存在按项目规则创建的 `AGENTS.md` 软链接与若干未跟踪文件，发布策略要求公开源码树无软链接且 git 索引与工作树一致，因此本机直接执行 `npm run build` 会失败；干净检出后不受影响。提交或收纳这些工作区文件后本机亦可直接构建。
- 会话前遗留的未提交 CC Switch 改动（`src/runtime/ccSwitch.ts` 等 4 个文件）同样会让本机构建停在「索引与工作树不一致」；该工作与 Pi 无关，保持未提交原样。
