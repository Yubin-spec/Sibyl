---
review: approved
change:
  scope: [api, config, module-export]
  concurrency: false
  irreversible: false
  tasks: 6
  files: 12
  reason: "新增 native-inbox /hook/context 端点、SessionStart/UserPromptSubmit hook、hook-context.json 配置与 scripts/sibyl.mjs 入口，并补待答计数与项目过滤契约"
---

# 功能 4：触发机制实施计划

日期：2026-11-09
分支：`feat/windows-support`（共享当前 checkout，不建分支、不 push）
依据：`docs/superpowers/specs/2026-11-09-trigger-matrix.md`

## 目标

让协作在正确时机自动介入：

1. Claude Code 新会话自动带上项目上下文与未处理事项（SessionStart hook）。
2. 用户每次提交提示时，把待答问题 / 待拍板事项带进上下文，但不标记已读、不阻塞提交（UserPromptSubmit hook）。
3. 提供一个一键入口查看 / 打开当前桥接网页与状态。
4. Codex 侧用 AGENTS.md 列出任务开始 / 交工前的检查点，不假设 Codex 有 hooks。

## 不做

- 不改微信通知逻辑（功能 3）。
- 不做 Notification / PostToolUse / PreCompact / SessionEnd hook（矩阵中标注“后续”）。
- 不做 dashboard 新的写接口；`/hook/context` 是纯读。
- 不把用户提示正文、问题正文、token、微信配置写进注入上下文。
- 不改已冻结模块：`Desktop.swift`、`build-app.sh`、`bridge.mjs`、`pairing.mjs`、`channel.mjs`、`update.mjs` 及其测试。
- 不重启、不杀死用户已有的 daemon；实现完成后只做只读冒烟和测试。

## 接口与数据变化

### 1. native-inbox 新端点

`POST /hook/context`，与现有端点相同的 `Authorization: Bearer <native-runtime token>`、`127.0.0.1` Host 校验。

请求：

```json
{"protocol":"hook-context/v1","event":"session-start","projectPath":"<cwd>","nativeSessionId":"<可选>"}
```

`event` 只允许 `session-start` / `user-prompt`；`projectPath` 1–1024 字符；`nativeSessionId` 可选，1–200 字符，来自 Claude Code hook 的 `session_id`。

响应：

```json
{"text":"…注入文本…"}
```

约束：

- 纯读：不修改 `questions`、不写文件、不标记 `delivered`。
- 先用 `projectKey(projectPath)` 校验项目；返回 `null` 时不做任何项目级匹配：
  - 待答问题为空；
  - 计划评审与待办只允许“全局事项”（当前仅配对请求），不注入其他项目的记录。
- 待答问题按目标会话归属分类。端点把请求者身份和预计算字段一起传给回调：
  `{nativeSessionId, pendingQuestions:[{id, status, createdAt, owner, source:{title,tool}, target:{title,tool,nativeSessionId}}]}`，不传问题正文。
  - `owner` 由端点预计算：请求带 `nativeSessionId` 且与目标会话的 `nativeSessionId` 完全相等 → `own`；否则目标工具与请求方相同 → `sameTool`；其余 → `otherTool`。缺失请求身份时绝不标 `own`。
  - `buildHookContext` 同时接收 `nativeSessionId`，用于文案中的“当前会话 / 其他会话”措辞；不重新推断归属。
  - 文本必须说清“项目内待答 N 条：发给当前会话 X 条、发给本工具其他会话 Y 条、发给其他工具 Z 条”，并提示在**对应会话**调用 `bridge_receive`；不得承诺当前会话的 `bridge_receive` 一定能读到其他会话的问题。
- 回调签名 `hookContext({event, projectPath, projectKey, pendingQuestions})`：
  - **统一项目身份规则**：问题、计划评审、项目 ID 查找全部使用 `projectKey()`（realpath + 大小写/分隔符归一），不使用只替换分隔符的 `normalizedPath`；`projectKey` 为 `null` 时一律不参与匹配。
  - 计划评审按 `projectKey(review.projectPath) === projectKey` 在 `control.mjs` 内先过滤；项目按同一 key 找 ID。
  - 待办在构造前过滤：会话按项目 ID、只读核对按来源/目标项目 ID；配对请求无项目归属，按全局事项注入；
  - 回调缺失或抛错时，端点仍返回项目与待答问题，不 500。
- 评审提醒必须区分操作归属：计划评审的全部操作（`continue` / `respond` / `result` / `decide`）都校验 `currentActorSessionId`，hook 无法可靠拿到该 ID，因此默认按**项目级提醒**表述：
  - `awaiting-visibility` / `changes-required` / `reviewing` / `deadlock`：提示“由发起该评审的原 Claude 会话操作对应工具；其他会话**不能**调用 `result`，只能在观测页查看”。
  - `interrupted`：只有原会话可 `recover`；原会话不可用时，同项目另一个 Claude 会话可 `recover({takeover:true})`，接管成功后**操作归属转移到接管会话**，后续动作由接管会话执行。
  - 不新增跨会话读取 `result` 的权限；不扩大现有接口契约。
- 没有同项目会话时，待答问题为空；计划评审/待办仍可按项目返回。

### 2. 配置

`<数据目录>/hook-context.json`：

```json
{"enabled": false}
```

- 文件缺失、不可读、JSON 损坏 → 视为 `enabled:true`（失败开放）。
- 只影响 SessionStart / UserPromptSubmit；Stop / PreToolUse 仍由各自 hook 条目控制。
- `scripts/sibyl.mjs hooks on|off|status` 写 / 读该文件。

### 3. Claude hook 事件

`native-config.mjs` 的 `HOOK_EVENTS` 增加：

- `SessionStart`，无 matcher，`--event session-start`
- `UserPromptSubmit`，无 matcher，`--event user-prompt`

保留现有 `Stop`、`PreToolUse`。继续使用幂等合并、`isOurHook` 去重、`Ambiguous managed hook` 保护。

### 4. 状态里的完整待答计数

`/api/status` 现在把问题历史截到最近 100 条，旧 `queued` 会被漏计。`control.mjs` 在截断前计算 `nativeInbox.pendingCount`（`queued` + `delivered` 总数）与 `nativeInbox.questionsTotal`，再保留原有 `questions` 窗口。新增纯函数 `inboxPublicView(snapshot)` 承载这段逻辑，供 `control.mjs` 与 CLI 共用并单独测试。

### 5. CLI 入口

`node scripts/sibyl.mjs <open|status|hooks>`：

- 数据目录按顺序**只选定一个**（不是逐个试写）：`--dir` > `SIBYL_DATA_DIR` > 本仓库 `.claude/settings.local.json` 中受管 hook 的 `--dir` > 本脚本所在 checkout 的同级 `../data` > `defaultDataDir()`。
  - 选定后只在该目录写入；**不可写即报错退出，绝不改写到下一个候选目录**，也不报告关闭成功。
  - 与启动入口统一：`start-browser.ps1` 的默认目录从写死的 `D:\LXY_workspace\AI Bridge\data` 改为「checkout 同级 `../data`」（本 checkout 仍解析为同一路径），`start-observer.cmd` 透传不变。
  - 不得因 settings、runtime 或 data 目录不存在而回退到 AppData。
- `open`：读 `browser-runtime.json`，用系统默认浏览器打开 `<url>/?page=observer`；加 `--no-open` 只打印 URL。
- `status`：GET `/` 解析 `<meta name="bridge-session" content="…">` 作为 CSRF，再带 `x-bridge-ui` 请求 `/api/status`，用 `nativeInbox.pendingCount` 打印待答数量；同时打印工作方、计划评审、待处理、会话数的中文摘要；`--json` 输出原始精简对象。
- `hooks on|off|status`：写 / 读 `hook-context.json`；离线可用。
- 服务未运行时 `open` / `status` 明确提示 `start-observer.cmd`，退出码 1；`hooks` 不要求服务在运行。不自动启动服务、不打印 token。

## 任务

1. **hook 文本构造**：新增 `hook-context.mjs`（纯函数，无 IO）。
   - `buildHookContext({event, projectPath, projectKey, projectName, nativeSessionId, pendingQuestions, reviews, attention})`。
   - `pendingQuestions` 使用端点预计算的 `owner`（own / sameTool / otherTool），构造器不重新推断。
   - SessionStart：项目名 + 待答问题归属（own / sameTool / otherTool 计数）+ 待处理评审 + 待办；没有事项也给 2–3 行基础上下文（`bridge_receive`、观测页入口）。
   - UserPromptSubmit：没有任何事项时返回空串；有事项时输出最多 3 条，明确“只读、未标记已读”，并给出下一条动作。
   - 评审状态映射动作：`awaiting-visibility` → **先确认评审在观测页实际可见，再提示由发起评审的原会话调用 `bridge_plan_review_continue({reviewId,confirmVisibility:true})`；无法确认就保持等待**；`changes-required` → 原会话 respond；`deadlock` → 人裁决；`interrupted` → 原会话 recover，原会话不可用时才提示同项目另一个 Claude 会话可 `takeover:true`（接管后操作归属转移）；`reviewing`/`starting` → 原会话 result，其他会话只能在观测页查看。
   - 评审提醒默认标为“项目级提醒”，不假设当前会话是 `currentActorSessionId`。
   - 截断：来源标题 60、计划路径 100、待办标题 80；不含问题正文与 token。
   - 公开 `inboxPublicView(snapshot)`：截断前算 `pendingCount` / `questionsTotal`，返回原有 `questions` 窗口；供 control 与 CLI 复用。
   - 测试：`hook-context.test.mjs`，覆盖同项目 Claude/Codex、多个同工具会话、A/B 两个会话分别请求同一问题集合、缺失请求身份、无效 `projectKey`、`awaiting-visibility` 文案顺序、同项目两个 Claude 会话的评审归属提示。

2. **native-inbox 端点**：`native-inbox.mjs` 增加 `/hook/context`，`createNativeInbox` 接收可选 `hookContext`；端点预计算 `owner` 并传 `{event, projectPath, projectKey, nativeSessionId, pendingQuestions}`；`control.mjs` 用晚绑定回调：
   - 在原始记录上先按项目过滤：**评审、项目查找与问题统一用 `projectKey()`**，会话按项目 ID，只读核对按来源/目标项目 ID；配对请求按全局事项；
   - `projectKey === null` 时不注入任何项目级事项；
   - `/api/status` 的 `nativeInbox` 改用 `inboxPublicView`，补 `pendingCount` / `questionsTotal`。
   - 测试：`native-inbox.test.mjs` 覆盖鉴权、协议/事件校验、按项目过滤、无效路径、`owner` 预计算、纯读（调用后问题仍为 `queued`）、回调缺失/抛错仍返回；`control` 侧另测计数、项目过滤与“目录 / 目录/. 指向同一评审”。

3. **hook 脚本**：`scripts/sibyl-hook.mjs` 增加 `session-start` / `user-prompt`。
   - `decideSessionStart(input, call, {enabled})` → `hookSpecificOutput.additionalContext`；超时 1500ms；把 `input.session_id` 作为 `nativeSessionId` 上传。
   - `decideUserPrompt(input, call, {enabled})` → 同上；超时 700ms；任何错误返回 `{}`，不输出 `notice`，避免每条提示重复提示。
   - 两者都先读 `hook-context.json`；`enabled:false` 直接 `{}`。
   - 只发送 `cwd` 与 `session_id`，不发送 `prompt`。
   - 测试：`sibyl-hook.test.mjs` 增加注入、超时/异常放行、禁用、事件名与协议、`prompt` 不被上传、进程级缺 daemon 返回 `{}`。

4. **安装路径**：`native-config.mjs` 增加两个事件。
   - 测试：`native-config.test.mjs` 断言四个 hook 各一条、幂等、保留无关 hook、路径含空格、ambiguous 仍拒绝。

5. **一键入口**：新增 `scripts/sibyl.mjs` 与 `sibyl-cli.test.mjs`。
   - 纯函数导出：`resolveDataDir`、`parseCsrf`、`summarizeStatus`、`setHooksEnabled`、`hookDirFromSettings`。
   - 集成测试用本地假 HTTP 服务验证 `status` 的两步请求、`pendingCount` 摘要与超过 100 条历史时的计数；不启动真实浏览器。
   - 目录测试：在全新临时 checkout（无 settings、无 runtime、无 data）中 `hooks off`，断言写到同级 `../data`；选定目录 A 不可写而候选 B 可写时，必须报错且不写 B；再模拟启动与安装 hook，确认读取同一目录且仍关闭。

6. **启动入口目录统一**：`start-browser.ps1` 的默认 `-DataDir` 改为 checkout 同级 `../data`（`Join-Path (Split-Path -Parent $PSScriptRoot) 'data'`），`start-observer.cmd` 透传不变。
   - 测试：源码级断言不再包含写死的 `D:\LXY_workspace\AI Bridge\data`，并断言使用 `Split-Path -Parent $PSScriptRoot`；本 checkout 解析结果与原路径一致。

7. **文档**：
   - 新增根 `AGENTS.md`：Codex 任务开始 / 交工前的检查点；无 hooks；失败即说明后继续。
   - `skills/agents-calling/SKILL.md` 增加“一键入口”和“上下文 hook”小节。
   - 触发矩阵文档已先落盘；实现后回填状态与关闭方式。

8. **安装与验收**：对本 checkout 运行 `configureNativeTool({tool:'claude'})` 写入四个 hook；手工运行 `--event session-start` / `--event user-prompt` 看输出；运行 `node scripts/sibyl.mjs status`、`--no-open open`；跑全量测试。

每个任务独立提交。

## 失败与安全

- 所有 hook：spawn 失败、daemon 不可用、超时、协议不符、JSON 解析失败 → 输出 `{}`、退出码 0。
- `/hook/context` 不改变问题状态；只有 `bridge_receive` 标记 `delivered`。
- 注入文本白名单字段：项目名、问题来源标题/工具、计划路径、评审状态、待办标题、数量。禁止 token、问题正文、文件内容、微信配置。
- 数据目录文件权限：`hook-context.json` 用 `0o600` 原子写。
- 不新增锁、租约、后台任务或定时器；不改变 daemon 生命周期。

## 验收

- 触发矩阵文档落盘并区分“已实现 / 本轮 / 后续”。
- SessionStart / UserPromptSubmit 可用：能注入待办；daemon 不在时静默放行。
- 同项目 Claude/Codex、多个同工具会话、A/B 分别请求同一问题集合、缺失请求身份时，待答归属描述正确；无效路径不注入项目级事项；目录与其 `.` 别名对应同一评审和待办。
- `awaiting-visibility` 的提示先要求确认可见，再提示由原会话调用 `continue`；其他会话不提示调用 `result`，只引导到观测页；takeover 后操作归属转移。
- 两者可在 `hook-context.json` 一键关闭；关闭后输出 `{}`；全新 checkout（无 settings/runtime/data）里 `hooks off` 写到同级 `../data`，启动与安装 hook 后仍关闭；选定目录不可写时报错且不改写其他目录。
- `start-observer.cmd` / `start-browser.ps1` 的默认数据目录与 CLI、安装 hook 一致，不再写死绝对路径。
- 安装走 `native-config.mjs`；重复安装幂等。
- `scripts/sibyl.mjs open|status|hooks` 可用；`status` 用 `pendingCount` 统计完整待答数（含超过 100 条历史）；未运行时给明确提示。`hooks` 目录不可写时明确报错。
- 全量测试 0 fail。
- 不 push、不建分支。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| SessionStart 时 MCP 尚未登记会话，待答问题为空 | 计划评审/待办仍返回；下一条 UserPromptSubmit 会补上待答问题 |
| 项目级问题被误当成当前会话收件 | 文本按 own / sameTool / otherTool 分类，并指向对应会话，不承诺当前 `bridge_receive` 可读 |
| 其他项目的评审/待办混入 | 统一用 `projectKey()` 过滤（评审、项目、问题），`projectKey=null` 时只保留全局配对事项 |
| 路径别名导致评审漏匹配 | 全部身份比较走 `projectKey()`；测试目录与 `目录/.` 别名 |
| 其他 Claude 会话按提示操作评审被拒 | 提醒标为项目级；其他会话不提示 `result`，只引导观测页；takeover 后归属转移 |
| 目录不可写时静默换目录 | 选定一个目录后写入失败即报错；测试 A 不可写、B 可写时不写 B |
| CLI 与启动入口目录不一致 | `start-browser.ps1` 默认改为 checkout 同级 `../data`；源码级测试禁止写死绝对路径 |
| UserPromptSubmit 超时拖慢输入 | 本地端点、700ms 上限；超时直接放行 |
| 注入内容过长污染提示 | 每类最多 3 条、严格截断；无正文 |
| 关闭开关写错目录 | `hooks` 优先读已安装 hook 的 `--dir`，否则用 checkout 同级 `../data`（不要求存在）；全部不可写时报错 |
| 待答计数被 100 条窗口漏计 | 截断前计算 `pendingCount`，CLI 使用该字段 |
| 新 hook 与用户已有 hook 冲突 | 沿用幂等合并与 ambiguous 保护；只追加本工具条目 |
| `/hook/context` 被外部访问 | 仍走 Bearer token + loopback Host 校验 |
| 用户已有 daemon 未重启，新端点 404 | hook 收到 4xx 后静默 `{}`；文档说明需重启 daemon 才生效 |

<!-- SIBYL_REVIEW_BEGIN -->
## Codex review

- 状态：approved
- 结论：完整复核后，上一轮四项问题已有实质修订，可以实施；保留一项非阻断的文案一致性建议。
- 评审模型：codex
- 轮次：2
- 采纳：R1, R2, R3, R4
- 残留风险：
<!-- SIBYL_REVIEW_END -->
