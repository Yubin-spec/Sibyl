# AI Bridge 触发矩阵

日期：2026-11-09
状态：功能 4 交付物（先文档，后实现）
范围：纯单机 Claude ↔ Codex 协作流水线。可见面是本地 Web 观测页与当前对话，不使用 Codex 桌面 App 窗口。

## 1. 结论

触发分四层，优先级从高到低：

1. **强制层**：Stop / PreToolUse hook。只在“结构计划未评审”时拦截，其余全部放行。
2. **上下文层**：SessionStart / UserPromptSubmit hook。只读注入待办，不改变任何状态，不阻塞输入。
3. **通知层**：daemon 状态 diff → Web SSE + 微信。工作方、计划评审、待处理队列。
4. **人工层**：CLI / 观测页 / MCP 工具。人主动查看或拍板。

原则：**能提示就不拦截，能异步就不阻塞，任何一层失败都退回“人还能照常干活”**。

## 2. 矩阵

通道缩写：hook = Claude Code hook；MCP = bridge_* 工具；Web = 观测页/SSE；CLI = 本地脚本；微信 = 单向通知。

| # | 事件 | 触发时机 | 通道 | 动作 | 实现方 | 失败时 | 能否关闭 | 状态 |
|---|---|---|---|---|---|---|---|---|
| 1 | SessionStart | Claude Code 启动 / 恢复 / 清空 / 压缩后 | hook | 注入项目上下文、待接收问题、待处理评审、待办摘要 | `scripts/sibyl-hook.mjs` + native-inbox `/hook/context` | 缺 daemon、超时 1.5s、协议不符 → 输出 `{}`，不注入 | `hook-context.json {"enabled":false}` 或删除该 hook | 已实现 |
| 2 | UserPromptSubmit | 用户提交提示后、模型回答前 | hook | 注入“还有 N 条待答问题 / 待拍板事项”，只读，不标记已读，不阻塞提交 | 同上 | 缺 daemon、超时 0.7s → 输出 `{}`，提示照常提交 | 同上 | 已实现 |
| 3 | Stop | Claude 准备结束本轮 | hook | 存在未评审结构计划时 `block`，提醒先评审 | `scripts/sibyl-hook.mjs` → `/plan-review/check` | daemon 不可用 → 放行；协议不符 → 只提醒更新 hooks | 删除 Stop hook | 已实现 |
| 4 | PreToolUse | Edit / Write / MultiEdit / NotebookEdit 前 | hook | 结构计划未评审 → `ask`；声明不可逆 → `deny` | 同上 | 检查抛错 → 放行；只覆盖文件编辑，不覆盖 Bash/git | 删除 PreToolUse hook | 已实现 |
| 5 | 工作方开始 / 完成 / 失败 / 停止 / 孤儿 / 中断 | daemon 快照变化 | Web + 微信 | 时间线与状态展示；终态发微信 | `workers.mjs` + `notify-service.mjs` | 通知失败只记 `lastError`，不影响交工 | `.notify.json enabled:false` | 已实现 |
| 6 | 计划评审等待确认 / 需回应 / 死锁 / 通过 / 失败 / 中断 | daemon 快照变化 | Web + 微信 | 展示轮次与问题数；关键状态发微信 | `plan-review.mjs` + `notify-service.mjs` | 同 #5 | 同 #5 | 已实现 |
| 7 | 待处理队列新增（配对 / 核对停止 / 会话失败） | daemon 快照变化 | Web + 微信 | 观测页“待你处理”卡片；发微信 | `attention.mjs` + `notify-service.mjs` | 同 #5 | 同 #5 | 已实现 |
| 8 | 收到对端问题 | 别的 AI 工具调用 `bridge_ask` | MCP | 被问方用 `bridge_receive` 读取、`bridge_reply` 回答 | `native-inbox.mjs` | 目标离线 → 问题标 `recipient-offline`，不静默丢 | 关闭该会话共享 | 已实现 |
| 9 | 待答问题再次进入提示 | 用户提交提示 | hook（#2） | 提示“先 `bridge_receive`”，不代替读取 | `sibyl-hook.mjs` + `hook-context.mjs` | 同 #2 | 同 #1 | 已实现 |
| 10 | 人工查看当前状态 | 人主动 | CLI | `node scripts/sibyl.mjs status` 打印工作方 / 评审 / 待办 / 待答摘要 | `scripts/sibyl.mjs` | 服务未运行 → 明确提示先启动 | 不装即无 | 已实现 |
| 11 | 人工打开观测页 | 人主动 | CLI / Web | `node scripts/sibyl.mjs open` 或 `start-observer.cmd` 打开固定地址 | `scripts/sibyl.mjs` | 服务未运行 → 提示先启动 | 不装即无 | 已实现 |
| 12 | 计划成形或结构变更 | Claude 执行方写/改计划后 | MCP | `bridge_plan_review` 发起只读评审，停在 `awaiting-visibility` | `plan-review.mjs` | Codex 不在线 → 评审 `failed`，Stop hook 仍会提醒 | 不调用即无 | 已实现 |
| 13 | Codex 任务开始 | Codex 自己开始一个任务 | 文档约定（AGENTS.md） | 先 `bridge_list_sessions` 看同项目对端；再 `bridge_receive` 取待答问题 | `AGENTS.md` | 工具不可用 → 继续任务并在报告里说明 | 删除 AGENTS.md 片段 | 已实现 |
| 14 | Codex 交工前 | Codex 准备给出最终回答 | 文档约定（AGENTS.md） | 再 `bridge_receive` 一次；有问题就 `bridge_reply` | `AGENTS.md` | 同 #13 | 同 #13 | 已实现 |
| 15 | Codex 收到评审任务 | 计划评审 worker 被派发 | MCP / daemon | 只读评审冻结快照，返回 `<<<SIBYL_REVIEW>>>` 结构化 verdict | `plan-review.mjs` + worker prompt | 解析失败 → 评审 `failed`，不静默通过 | 取消该评审 | 已实现 |
| 16 | daemon 重启 | 进程启动 | Web + 微信 | 未完成评审/工作方标 `interrupted`，可恢复 | `plan-review.mjs` / `workers.mjs` | 恢复失败只影响单个评审 | 不适用 | 已实现 |
| 17 | Claude 需要权限 / 等待输入 | Claude Code 空闲或弹权限 | hook（Notification） | 可发微信提醒 | 未实现 | — | — | 后续 |
| 18 | 每次工具调用后 | PostToolUse | hook | 对结构变更做二次校验（当前只在编辑前拦） | 未实现 | — | — | 后续 |
| 19 | 会话压缩前 | PreCompact | hook | 把待办摘要保留到压缩后的上下文 | 未实现 | — | — | 后续 |
| 20 | 会话结束 | SessionEnd | hook | 记录结束状态，可选清理 | 未实现 | — | — | 后续 |
| 21 | 斜杠命令入口 | 人输入 `/sibyl` | skill / 斜杠命令 | 查看状态或打开页面 | 未实现；本轮先提供脚本 | — | — | 后续 |

## 3. 边界与取舍

- **不假设 Codex 有 hooks**：Codex 侧只靠 AGENTS.md 的任务开始/交工检查，不依赖事件钩子。
- **UserPromptSubmit 不读正文**：hook 只传 `cwd`，不传用户提示内容；待答问题只显示来源标题和数量，不把问题正文灌进每条提示。
- **超时不等于已读**：`/hook/context` 是纯读端点，不改 `native-questions.json` 中任何 `status`。只有 `bridge_receive` 才标记 `delivered`。
- **上下文层可关**：`<数据目录>/hook-context.json` 写 `{"enabled":false}` 即让 SessionStart / UserPromptSubmit 输出空；Stop / PreToolUse 不受影响，仍按各自 hook 删除关闭。
- **失败默认放行**：所有 hook 在 daemon 不可用、超时、协议不符时返回 `{}`，退出码 0，不阻塞用户输入。
- **不泄露内容**：注入文本只含项目名、事项类型、来源标题、计划路径、数量；不含 token、问题正文、文件内容、微信配置。
- **观测页仍是唯一可视化面**：微信只做单向提醒，不承担决策；死锁仍由人在网页或对话里裁决。
- **一键入口**：`node scripts/sibyl.mjs status` 查看摘要，`open` 打开观测页，`hooks on|off|status` 管理上下文 hook；数据目录与 `start-observer.cmd` / 安装 hook 的 `--dir` 保持一致。
