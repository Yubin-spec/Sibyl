# Plan Review Loop — Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude 产出或修改结构性的实施计划时，自动让 Codex 在可见会话里评审；执行方逐条回应；未通过评审时 Stop hook 提醒并阻止本轮结束，PreToolUse 对普通写返回 `ask`、对声明为不可逆的写返回 `deny`；死锁由人手动裁决；核心版不承诺绝对阻断，daemon gate 留给 Stage 2。

**Architecture:** 复用 Phase B 的 daemon、worker 服务和 SQLite。评审使用现有只读 `consult` worker（每轮一个 worker，不新增 tier），通过 `--mcp none` 隔离写工具。新增 `plan-review-policy.mjs`、`plan-review.mjs`、HTTP/MCP 端点和一个 Claude Code `Stop` hook。评审记录存入现有 `meta` 表，不升 schema 版本。

**Tech Stack:** Node.js >= 26，零第三方依赖；`node:sqlite`；MCP stdio；Claude Code hooks。

**Spec:** `docs/superpowers/specs/2026-11-08-plan-review-loop-design.md`
**Full version (Phase 2 reference):** `docs/superpowers/plans/2026-11-08-plan-review-loop.md`

## 核心版边界（必须先读）

**做：**

- 计划 frontmatter 声明 `review` 与 `change`。
- 稳定 `planInputHash`：只含 `change` + 正文，排除 `review` 状态和生成的 `## Codex review` 区。
- 结构变更 → 启动一个可见、只读的 Codex consult worker。
- 结构化 verdict：`approve | changes-required | discuss`，issue 带 severity/位置/问题/建议。
- 执行方逐条回应；最多 3 轮；`discuss` 的 questions 编号为 `Q1..Qn`。
- 通过 → 写 `## Codex review`，声明改 `review: approved`。
- 死锁 → 状态 `deadlock`，由人通过 `bridge_plan_review_decide` 手动裁决（1 = 按 Codex 意见最后再评一轮；0 = 取消；核心版不通过工具产生 waived）。
- Stop hook：结构计划未批准时阻止本轮结束；fail-open。
- 重启：`reviewing`/`changes-required`/`awaiting-visibility` → `interrupted`；`bridge_plan_review_recover` 按 `interruptedFrom` 分支恢复。

**不做（Phase 2）：**

- 微信死锁通知/回复。
- daemon 写门禁（worker-start/finalize/accept）与 PreToolUse 硬门禁。
- 高风险不可逆操作的人批。
- 独立 `review` tier、persistent 同线程多轮。
- 动作日志/崩溃后精确重放、多计划批准绑定。
- 评审保留策略、运行台可视化。
- 本地模型第二意见。

**明确限制：**

- 每轮评审 = 一个新的 Codex 可见线程；线程之间靠 review 记录的轮次上下文衔接，不是同一个线程。
- 评审占用 `consult` 的并发/预算；consult 满时评审会等待或失败。
- 核心版只有 Stop hook 与 PreToolUse 提醒，没有 daemon 级硬门禁；执行方在同一个 turn 中途仍可能写文件，PreToolUse 只在 Claude Code 支持该 hook 时生效。Phase 2 才加 daemon gate。
- 人工裁决没有微信，需要在 Claude 里调用工具；UserPromptSubmit 会把 deadlock 自动冒出来。

## 定稿补充（2026-11-08，调研后）

核心版保持原范围，另加 8 个低成本、个人使用收益高的点；不改数据库 schema（仍用 meta）。

1. **Review Focus 输入**（Rev 3 撤回强制覆盖）：`parsePlanDeclaration` 解析 `## Review Focus`；Focus 只作为评审输入，不要求每个 F 项被 issue/question 引用，也不因未覆盖而判失败。
2. **reconcile**：`plan-review.mjs` 每 30 秒扫 `reviewing`；若 worker 已 completed/failed 而结果未处理，按正常路径处理；只在 `reviewing` 状态运行，终态不重试。
3. **证据落盘**：每次终态写 `.sibyl/reviews/<reviewId>.json`，含 planHash、verdict、issues、responses、rawVerdict、时间；失败也写。写失败不改变评审状态。
4. **时间预算**（Rev 3 撤回 USD）：只保留 `wholeReviewMs`/`turnMs`；token/USD 计量留 Stage 2。
5. **模型 auto**：默认 `reviewerModel:'auto'`，传 `kind:'review', risk:'high'`；由 `model-policy.mjs` 选 `gpt-6.1-sol`。deadlock 的最后一次人工加轮才用 `gpt-6-astra`。
6. **协议版本**：hook 与 daemon 的 `/plan-review/*` 都带 `protocol:'plan-review/v1'`；不一致时 hook fail-open 并返回固定提示，daemon 对旧 hook 返回 400。
7. **hooks 范围**（Rev 3 收缩）：Task 5 只做 `Stop` + `PreToolUse`；`UserPromptSubmit`/inbox 留 Stage 2。
   - `PreToolUse`：对 `Write`/`Edit`/`MultiEdit` 调 `/plan-review/check`；结构计划未批准时返回 `deny`（不可逆）或 `ask`（普通写）；无 state 默认 `ask`；`warn` 模式返回空。
   - 所有 hook fail-open；协议不一致返回合法 JSON `{}` + `notice`。
8. **配置合并 fail-closed**：`native-config.mjs` 写 hooks 时，遇到无法唯一识别的 `hooks.Stop`/`UserPromptSubmit`/`PreToolUse` 叶子直接拒绝并报错，不猜；其余 hooks 保留、备份一次。

**Stage 2 不做**：persistent 同线程评审（等核心版稳定后单独做）、ACP、微信死锁通道、daemon 写门禁、高风险人批、独立 review tier、运行台可视化。

## Rev 2（2026-11-08，Codex 首次评审后）

首次 verdict：`changes-required`，1 blocker + 19 major/minor。与本节冲突的旧文以本节为准。

### 范围收缩

- **核心版只承诺“提醒 + 尽力拦截”**，不承诺“未批准前绝对不写文件”。Stop hook 在回合结束时提醒；PreToolUse 对 `Write`/`Edit`/`MultiEdit` 返回 `ask`，声明 `irreversible` 时 `deny`；Bash、git、bridge worker 的写入不在核心版硬拦，留给 Stage 2 的 daemon gate。
- **不做 UserPromptSubmit / `/plan-review/inbox`**（R4、R17）；deadlock 通过 Stop hook 与工具返回提示。
- **不做强制 Review Focus 覆盖**（R5）；Focus 只作为评审输入，coverage 契约留到 Stage 2。
- **不做 USD/token 硬上限**（R13）；只保留时间预算。
- **不通过 MCP 工具产生 waived**（R3）；`decide` 只支持 `1`=最后加轮、`0`=取消；`waived` 留到人工通道。
- **recover 允许同项目的新 Claude 会话显式接管**（`takeover:true`），记录 `lastActorSessionId`（R11）；跨项目不允许。
- **证据落盘保存每轮不可变快照**，不再只覆盖当前 verdict（R15）。

### 逐条回应

| ID | 处理 |
|---|---|
| R1 blocker | 收缩为“提醒 + PreToolUse ask/deny”；Goal 与验收文案同步改；daemon gate 明确 Stage 2。 |
| R2 | `start`/`respond`/`recover` 两阶段：空 worker → 取得 `threadId` → `open-codex-thread.ps1` → 再发 turn；可见性失败记为 `visibility:'unknown'`，结果中暴露，不阻塞评审。 |
| R3 | 删除工具直接产生 `waived` 的路径；`decide` 只接受 1/0。 |
| R4 | 只保留 Stop + PreToolUse；`/plan-review/check` token-only，带 `filePath` 与 `mode`，在 `own(body)` 之前分流；用真实 HTTP 测试。 |
| R5 | Focus 作为输入，不强制 coverage；`parseVerdict` 不再要求每个 F 项被 issue/question 引用。 |
| R6 | 定义 `hashVersion:1` canonical：去 BOM、CRLF→LF、frontmatter 字段固定顺序/默认值、正文保留代码块空白、末尾换行归一；补 CRLF/BOM/重复写回/代码块测试。 |
| R7 | 生成块必须独占行、代码围栏外、唯一一对；重复/嵌套/缺失结束标记时拒绝写回；补代码围栏内标记、正文引用、多对标记测试。 |
| R8 | 去重键改为 `workerId:turnId`，并绑定 `round`/`generation`；补连续 worker 都返回 `lastTurn.id=1` 的测试。 |
| R9 | 每轮保存完整快照、约束、历史摘要；`respond` 发送完整当前计划，不只未解决项；persistent 仍留 Stage 2。 |
| R10 | 所有状态迁移走 per-review 队列 + 全局 start 锁；`requestId` 持久化，同 id 不同 payload 拒绝；补交错测试。 |
| R11 | 同项目 `takeover:true`；`result`/`respond` 仍只允许 source session；`recover` 可接管，记录 `lastActorSessionId`。 |
| R12 | 持久化 `finalRoundUsed`、`interruptedFrom`、`deadline`；`decide 1` 只用一次；重复 decide 拒绝；补第四轮/重复重启测试。 |
| R13 | 删除 `maxReviewTokens`/`maxCostUsd`；只保留 `wholeReviewMs`/`turnMs`。 |
| R14 | worker 状态映射：`completed`→处理，`failed`/`stopped`/`orphan`/`exit-unconfirmed`→`failed`/`interrupted`；`wholeReviewMs` 持久化并在 reconcile 执行。 |
| R15 | artifact 保存 `rounds:[{round,planHash,planSnapshot,verdict,issues,responses,rawVerdict}]`；`artifactError` 暴露在 publicReview。 |
| R16 | 新增 `planApprovals` 索引（按 `projectId:planPath`），不受 100 条历史淘汰；`check` 按当前 hash 查询。 |
| R17 | 不做 UserPromptSubmit；Stop hook 无 cursor 状态。 |
| R18 | hook 所有权精确匹配 `node + script + resolved dataDir + event`；零匹配插入、一匹配更新、多匹配拒绝；先校验所有目标文件再写；备份不覆盖。 |
| R19 | `respond` 必须覆盖当前轮全部 blocker/major 与 questions；issueId 唯一且不能匹配 `/^Q\d+$/`；`accept` 需 planChange/evidence，`reject` 需 evidence，question 需 answer；未知/旧轮/重复拒绝。 |
| R20 | 统一模型：`model:'auto', kind:'review', risk:'high'` → `gpt-6.1-sol`；Task 6 文案包含 PreToolUse；固定 Claude Code 2.1.318 做真实 stdin/stdout/退出码契约测试；协议不一致返回合法 JSON `{}` + `notice`，不拼接文本。 |

### Rev 2 后的验收

- 结构计划未批准时，Stop hook 会提醒并阻止本轮结束；PreToolUse 对普通写 `ask`，对 `irreversible` 写 `deny`；不承诺覆盖 Bash/git/worker 写入。
- 评审 worker 两阶段启动，可见性失败可见但不阻塞。
- 每轮完整快照 + 历史；`workerId:turnId` 去重；per-review 队列；同项目 takeover；`decide 1` 只用一次。
- 批准索引不受历史淘汰；artifact 含每轮证据；`artifactError` 可见。
- 真实 HTTP hook 测试 + Claude Code 2.1.318 契约测试通过。

## Rev 3（2026-11-08，Codex 第二轮后）

第二轮：`changes-required`，无 blocker，5 major + 3 minor。逐条修正：

- **R2 可见性**：两阶段启动后，`focusThread` 未确认 → 状态 `awaiting-visibility`，**绝不发 turn**；`resume({confirmVisibility:true})` 由人/CLI 确认后才继续；测试断言未确认时 `workers.turn` 未被调用。观测页/CLI 是允许的确认途径。
- **R6 canonical**：`hashVersion:1`；参与字段固定为 `scope`（trim、去空、去重、按 UTF-8 码元排序）、`concurrency`、`irreversible`、`tasks`、`files`；序列化为固定键序的 UTF-8 JSON（无空白）；正文去 BOM、CRLF→LF、去生成块、仅去末尾空白；摘要为 SHA-256(`plan-review/v1\n` + canonicalChange + `\n` + canonicalBody)，小写 hex；测试文件固定输入/摘要向量。
- **R12 恢复**：`interruptedFrom=changes-required` → 恢复为 `changes-required`，不发 turn、不加轮，等合法 `respond`；只有 `interruptedFrom=reviewing` 才启动替代 worker；轮数、deadline、`finalRoundUsed` 均不重置。
- **R14 完成判定**：`result`/`reconcile` 共用 `processTurn`，按当前 generation 的 `lastTurn.status` 判定完成/失败；处理后 `workers.close` 释放 consult 容量；分别映射 `worker.status` 与 `stopReason`（`stopped`/`orphan`/`exit-unconfirmed`）；fake worker 必须模拟 `status:'running', lastTurn.status:'completed'`，不能只改 `worker.status`。
- **R19 回应形状**：`{type:'issue',issueId,decision:'accept'|'reject',evidence?,planChange?}` 或 `{type:'question',questionId:'Qn',answer}`；`issueId` 禁止 `/^Q\d+$/`，`questionId` 必须是 `/^Q\d+$/`；`respond` 必须覆盖当前轮全部 blocker/major 与 questions；未知/重复/旧轮拒绝；同步服务、HTTP、MCP 校验；补 question-only 与混合回应测试。
- **R7 扫描器**：`parsePlanDeclaration`/`stripGeneratedReview`/`writeCodexReviewSection` 共用同一扫描器；支持反引号与波浪号围栏；标记必须独占行、位于围栏外、恰好一对；畸形块 → `errors`，不产生可批准 hash，写回拒绝。
- **R11 actor**：记录 `createdBySessionId` 与 `currentActorSessionId`；`takeover` 原子更新 current；`result`/`respond`/`decide`/`recover` 统一用 current actor 授权；旧 actor 拒绝。
- **R20 清理**：删除残留 `waived`/UserPromptSubmit/强制 Focus/USD 字段与验收；`normalizeReviewConfig` 只留时间字段；服务级断言 `auto→gpt-6.1-sol`、最后加轮 `→gpt-6-astra`；设计文档顶部标注“核心版以 Rev 3 为准”。

### Rev 3 后的验收

- 可见性未确认时 `start` 停在 `awaiting-visibility`，不调用 `workers.turn`；确认后继续。
- `hashVersion:1` 的固定向量通过；BOM/CRLF/末尾空白/代码块空白行为明确。
- `changes-required` 重启后不绕过待回应；`reviewing` 重启后才重试。
- 每轮完成以 `lastTurn.status` 判定；处理后关闭 worker；`stopped`/`orphan`/`exit-unconfirmed` 有明确映射。
- question-only 与混合回应可成功；漏答/重复/旧轮/未知引用被拒。
- 旧 actor 不能读取/回应/裁决；takeover 后新 actor 可以。
- 文档与测试中不再出现 waived/UserPromptSubmit/强制 Focus/USD 的残留承诺。

## Rev 4（2026-11-08，Codex 第三轮后）

第三轮：`changes-required`，无 blocker，2 major + 4 minor。修正：

- **R2 可见性继续入口**：新增 `bridge_plan_review_continue({reviewId,confirmVisibility:true})` + HTTP `/plan-review/continue`；服务 `continueReview({session,reviewId,confirmVisibility})`；与启动初始化 `resume()` 分开；`awaiting-visibility` 加入 `REVIEW_STATES` 和状态表；未确认零 turn，确认后只发一次；旧 actor 拒绝。
- **R6 canonical 完整**：默认 `scope=[]`、`concurrency=false`、`irreversible=false`、`tasks=0`、`files=0`；类型错误拒绝（不隐式转换）；`scope` 按 UTF-8 字节序排序；正文仅去末尾空白；`hashVersion:1` 随 review/round/approval 保存，批准查询比较 `(hashVersion,inputHash)`，缺失/不支持 → 重审；固定字面量向量覆盖缺省与显式默认等价。
- **R12 测试同步**：`changes-required` 恢复仍为 `changes-required`，`currentActorSessionId` 更新，worker/turn 数、`round`/`deadline`/`finalRoundUsed` 不变；另设 `reviewing` 分支替代 worker 测试。
- **R14 映射表**：列出 `worker.status`/`stopReason`/`lastTurn.status` → review 状态及优先级；`close` 返回 orphan/失败记 `cleanup` 状态，不宣称容量已释放。
- **R19 测试与 parseVerdict**：所有 issue 回应示例补 `type:'issue'`；`parseVerdict` 拒绝 `/^Q\d+$/` 的 issue ID。
- **R20 清理**：删除 `choice=2`→waived、UserPromptSubmit、局部复审的核心承诺；`buildResponsePrompt` 改为完整当前计划 + 历史上下文。

### Rev 4 状态补充

```
REVIEW_STATES 增加 awaiting-visibility
awaiting-visibility --continue(confirmVisibility:true)--> reviewing（只发一次 turn）
awaiting-visibility --cancel--> cancelled
awaiting-visibility --daemon restart--> interrupted
```

### Rev 4 worker 映射

| worker.status | stopReason | lastTurn.status | review 状态 |
|---|---|---|---|
| running | null | completed | 处理 verdict |
| running | null | failed | failed |
| stopped | closed/human_stop | running/completed | interrupted（已完成则先处理） |
| failed | * | * | failed |
| orphan | exit-unconfirmed | * | interrupted，保留 lease，`cleanup:'orphan'` |
| starting | * | * | 超时后 interrupted/failed |

`close` 失败或返回 orphan 时记 `cleanup:'orphan'`，不得宣称容量已释放。

## Rev 5（2026-11-08，Codex 第四轮后）

第四轮：`changes-required`，无 blocker，1 major + 1 minor。

- **R2**：`continueReview` 只处理 `awaiting-visibility`；`interrupted` 一律走 `recover`；`reviewing` 恢复先创建替代 worker → 新 `threadId` → `awaiting-visibility`，再由 `continue` 确认后发一次 turn。测试断言确认前零 turn、重复确认不重发、直接 `continue(interrupted)` 被拒。
- **R20**：清理 `choice=2`、局部复审、六个工具等旧文案；`buildResponsePrompt` 发送完整当前计划；`tools/list` 七个工具；设计范围引用更新到 Rev 5。

### Rev 5 后的验收

- `continueReview` 只接受 `awaiting-visibility`；`interrupted` 只能走 `recover`。
- `recover` 按 `interruptedFrom` 三分支；`reviewing` 分支确认前零 turn。
- 重复 `continue` 不重发 turn；旧 actor 被拒。
- 文档与测试中不再出现 `choice=2`、局部复审、六工具等旧契约。

## Global Constraints

- Node.js >= 26；零第三方 npm 依赖；测试只能用 Node 26：
  `"/d/LXY_workspace/AI Bridge/.tools/node26/node-v26.13.0-win-x64/node.exe" --test --test-concurrency=1 --test-timeout=30000 *.test.mjs`
- 只在 `feat/windows-support` 的扁平布局上改；不碰 `develop`；不引入 `src/`。
- 每个任务独立提交；不 push，除非人明确要求。
- 与 Codex 的讨论必须可见；按 CLAUDE.md 的顺序：`bridge_worker_start({tool:'codex',tier:'consult'})`（不带 prompt）→ 轮询 `bridge_worker_result` 直到拿到 `threadId` → `open-codex-thread.ps1 -ThreadId "<threadId>"` → 再 `bridge_worker_turn`。深链打不开时按 CLAUDE.md 的说明处理，不反复重试。
- v1 只支持 Claude 执行、Codex 评审。
- 评审输入 hash 只含 `change` 声明 + 正文；`review` 状态是结果，不参与 hash。
- `## Codex review` 只写在 `<!-- SIBYL_REVIEW_BEGIN -->` / `<!-- SIBYL_REVIEW_END -->` 之间；没有标记时不删用户正文。
- 所有新模块导出纯函数；服务通过参数注入 `store`、`workers`、`now`、`onChange`。

## Review Focus

- 无/坏 frontmatter：不能误触发；曾被管理的计划声明损坏时 Stop hook 仍要阻止。
- `review:not-required` 但 scope/concurrency/irreversible/规模是结构性：必须升级为 required。
- 批准写回后 hash 不变；正文或 `change` 变化必须重审。
- Codex 返回多块/非 JSON/approve 带 blocker/重复 issue ID：判失败并保留原文。
- 3 轮后仍不通过：进入 `deadlock`，不再自动加轮。
- 并发 `result`/`respond`：不能重复加轮或重复批准。
- daemon 重启：运行中评审变 `interrupted`，`recover` 可继续。
- Stop hook：daemon 不在/超时 → fail-open；`stop_hook_active` → 不再阻止。
- 评审 worker：只读、无 worktree、无 ai-bridge MCP。

### Review Focus → 测试映射

| 关注点 | 测试 |
|---|---|
| hash 写回稳定 / 正文变化 | `plan-review-policy.test.mjs`：`hash excludes review status` |
| 无/坏 frontmatter、受管理损坏 | `plan-review.test.mjs`：`check blocks managed malformed plans` |
| verdict 严格解析 | `plan-review-policy.test.mjs`：`rejects ambiguous verdicts` |
| 3 轮 deadlock + 人工裁决 | `plan-review.test.mjs`：`deadlock and manual decide` |
| 并发幂等 | `plan-review.test.mjs`：`concurrent respond is idempotent` |
| 重启 recover | `plan-review.test.mjs`：`restart marks interrupted and recover resumes` |
| worker 只读/无 MCP | `review-worker.test.mjs`：`review worker has no ai-bridge MCP` |
| Stop hook fail-open | `sibyl-hook.test.mjs`：`fails open when daemon is down` |

---

## Before you start

- [ ] 确认 `git branch --show-current` 是 `feat/windows-support`，工作区除设计/计划文档外干净。
- [ ] **重启后台 daemon**：当前 `control.mjs` 是旧进程，没有 `/worker/start`。从 `D:\LXY_workspace\AI Bridge\Sibyl` 重新启动 `node control.mjs "D:\LXY_workspace\AI Bridge\data"`，确认 `/worker/start` 可用。
- [ ] 从 `D:\LXY_workspace\AI Bridge\Sibyl` 启动 Claude Code / MCP，确认工具列表里有 `bridge_worker_*`。
- [ ] 跑一次全量测试，确认 0 fail。
- [ ] 本计划经人确认后，按 CLAUDE.md 的“大计划先评审”做一次 Codex 评审；通过后再开始 Task 1。

---

### Task 1: 声明、稳定 hash、判断与协议

**Files:**
- Create: `plan-review-policy.mjs`
- Test: `plan-review-policy.test.mjs`

**Interfaces:**
- Produces:
  - `PLAN_REVIEW_OPEN = '<<<SIBYL_REVIEW'`，`PLAN_REVIEW_CLOSE = 'SIBYL_REVIEW>>>'`
  - `REVIEW_BEGIN = '<!-- SIBYL_REVIEW_BEGIN -->'`，`REVIEW_END = '<!-- SIBYL_REVIEW_END -->'`
  - `REVIEW_STATES = ['awaiting-visibility','reviewing','changes-required','deadlock','approved','rejected','cancelled','interrupted','failed']`
  - `DEFAULT_PLAN_REVIEW = {protocolVersion:'plan-review/v1',maxRounds:3,wholeReviewMs:3600000,turnMs:600000,maxPlanBytes:204800,maxIssues:20,maxFocusItems:20,maxResponsesBytes:12000,reviewerModel:'auto',reviewerFinalModel:'gpt-6-astra',reviewerEffort:'high'}`
  - `parsePlanDeclaration(text) -> {review, change, body, focus, inputHash, errors}`
  - `parseFocus(body) -> [{id:'F1',text}]`
  - `planInputHash(change, body) -> string`
  - `isStructural(parsed) -> {required, reasons}`
  - `stripGeneratedReview(text) -> string`
  - `findPlanFiles(projectPath) -> Promise<string[]>`
  - `parseVerdict(text, {focus}) -> {ok, verdict?, error?}`
  - `buildReviewPrompt(input)`, `buildResponsePrompt(input)`
  - `writeCodexReviewSection(text, input) -> string`

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePlanDeclaration, planInputHash, isStructural, parseVerdict,
  writeCodexReviewSection, stripGeneratedReview, REVIEW_STATES
} from './plan-review-policy.mjs';

test('hash excludes review status and generated section, includes change and body', () => {
  const text = `---\nreview: required\nchange:\n  scope: [api]\n  irreversible: true\n  tasks: 6\n  files: 7\n---\n\n# Plan\n\nbody\n`;
  const parsed = parsePlanDeclaration(text);
  const approved = writeCodexReviewSection(text, {status:'approved', summary:'ok', reviewer:'codex', accepted:['R1'], residualRisks:[]});
  assert.equal(parsePlanDeclaration(approved).inputHash, parsed.inputHash);
  assert.equal(parsePlanDeclaration(text.replace('body','changed')).inputHash === parsed.inputHash, false);
  assert.equal(parsePlanDeclaration(text.replace('irreversible: true','irreversible: false')).inputHash === parsed.inputHash, false);
  assert.match(approved, /SIBYL_REVIEW_BEGIN/);
});

test('does not strip a user-written Codex review heading without markers', () => {
  const text = '---\nreview: required\nchange:\n  scope: [api]\n---\n\n## Codex review\nuser text\n';
  assert.equal(parsePlanDeclaration(text).body.includes('user text'), true);
});

test('treats missing or malformed frontmatter as undeclared', () => {
  assert.equal(parsePlanDeclaration('no frontmatter').review, null);
  assert.ok(parsePlanDeclaration('---\nreview: maybe\n---\nbody').errors.length > 0);
  assert.ok(REVIEW_STATES.includes('deadlock'));
});

test('upgrades not-required when structural flags are present', () => {
  const parsed = parsePlanDeclaration('---\nreview: not-required\nchange:\n  scope: [api]\n---\nbody');
  assert.deepEqual(isStructural(parsed), {required:true, reasons:['scope:api']});
});

test('rejects ambiguous verdicts and numbers questions', () => {
  assert.equal(parseVerdict('looks good').ok, false);
  const two = `<<<SIBYL_REVIEW\n{"verdict":"approve","issues":[]}\nSIBYL_REVIEW>>>\n<<<SIBYL_REVIEW\n{"verdict":"approve","issues":[]}\nSIBYL_REVIEW>>>`;
  assert.equal(parseVerdict(two).ok, false);
  const approveWithBlocker = `<<<SIBYL_REVIEW\n{"verdict":"approve","issues":[{"id":"R1","severity":"blocker","location":"§1","problem":"x","why":"y","suggestion":"z"}]}\nSIBYL_REVIEW>>>`;
  assert.equal(parseVerdict(approveWithBlocker).ok, false);
  const discuss = `<<<SIBYL_REVIEW\n{"verdict":"discuss","questions":["a?","b?"]}\nSIBYL_REVIEW>>>`;
  assert.equal(parseVerdict(discuss).verdict.questions[0].id, 'Q1');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test plan-review-policy.test.mjs`
Expected: FAIL with `Cannot find module './plan-review-policy.mjs'`

**Rev 2 必须补的策略测试（R6/R7/R19）：**
- hash：CRLF/LF、BOM、不同末尾换行、重复写回、Markdown 代码块内空白变化。
- 生成块：代码围栏内的标记、正文引用、多对标记、缺失结束标记、用户手写同名标题。
- verdict：approve 带 blocker、重复 issue ID、issue ID 为 `Q1` 与 questions 冲突。

- [ ] **Step 3: 实现**

- `planInputHash` 的精确算法（R6）：`hashVersion:1`；`canonicalChange = {scope:[...trim,去空,去重,按 UTF-8 码元排序], concurrency:!!, irreversible:!!, tasks:int>=0, files:int>=0}`；`canonicalBody = stripGeneratedReview(body)` 去 BOM、CRLF→LF、仅去掉末尾空白；`sha256('plan-review/v1\n' + JSON.stringify(canonicalChange) + '\n' + canonicalBody)`，小写 hex。`review`、生成块、`reason` 不参与。测试文件固定一组输入与期望摘要。
- `stripGeneratedReview` / `writeCodexReviewSection` / `parsePlanDeclaration` 共用同一扫描器；识别列 0、围栏外、独占行的标记；反引号与波浪号围栏都支持；重复/嵌套/缺失结束 → `errors`，不产生可批准 hash，写回拒绝（R7）。无标记时 `writeCodexReviewSection` 在文末追加生成块，不改用户正文。
- `writeCodexReviewSection` 插入标记、更新 `review:`、保留用户正文。
- `parseVerdict`：恰好一个 sentinel 块；issue ID 唯一 `/^[A-Za-z0-9_-]{1,20}$/` 且不能匹配 `/^Q\d+$/`；severity 合法；`approve` 不能带 blocker/major；`changes-required` 至少一个 blocker/major；`discuss` 有 questions 或 issues；questions 转 `{id:'Q1',text}`。
- `parseFocus(body)`：解析 `## Review Focus` 下的 `- ` 条目，最多 `maxFocusItems`，分配 `F1..Fn`；没有时返回空数组。
- `parseVerdict(text,{focus})`：`focus` 只用于提示和结果展示；不强制每个 F 项被 issue/question 覆盖（R5）。`approve` 仍不能带 blocker/major；结构计划没有 focus 时允许 approve，但在 summary 中提示缺少评审重点。
- `normalizeReviewConfig`：只接受白名单时间字段（`maxRounds`/`wholeReviewMs`/`turnMs`/`maxPlanBytes`/`maxIssues`/`maxFocusItems`/`maxResponsesBytes`/`reviewerModel`/`reviewerFinalModel`/`reviewerEffort`）；`protocolVersion` 固定 `plan-review/v1`；不包含 token/USD。
- `findPlanFiles`：`docs/superpowers/plans/**/*.md` + 根 `*.plan.md`，跳过 `.sibyl` 和符号链接。
- `buildReviewPrompt`：只读、对抗性、引用段落、输出 sentinel JSON、不得改文件；带计划正文、change 声明、项目根、相关文件/当前 diff、上一轮结论。
- `buildResponsePrompt`：逐条回应；发送完整当前计划、约束和历史上下文（不只未解决 blocker/major 和改动段落）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test plan-review-policy.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add plan-review-policy.mjs plan-review-policy.test.mjs
git commit -m "feat(plan-review): add declaration, stable hash and verdict policy"
```

---

### Task 2: 评审服务与持久化

**Files:**
- Create: `plan-review.mjs`
- Create: `plan-review-test-support.mjs`
- Modify: `workspace.mjs`
- Test: `plan-review.test.mjs`, `workspace.test.mjs`

**Interfaces:**
- `createPlanReviewService({store,workers,now,onChange,config})`
- `start({session,planPath}) -> publicReview`
- `result({session,reviewId,waitMs}) -> publicReview`
- `respond({session,reviewId,responses,planPath,expectedRound,requestId}) -> publicReview`
- `decide({session,reviewId,choice}) -> publicReview`（`1|0`）
- `continueReview({session,reviewId,confirmVisibility}) -> publicReview`
- `recover({session,reviewId,takeover}) -> publicReview`
- `list({session,all}) -> {reviews}`
- `check({projectPath,filePath,mode}) -> {block,mode,reason,plans}`
- `close()`
- publicReview：`{reviewId,protocolVersion,hashVersion,projectId,projectPath,planPath,planHash,status,structural,declaration,focus,round,maxRounds,finalRoundUsed,workerId,threadId,visibility,cleanup,currentActorSessionId,verdict,issues,questions,responses,budget,artifactPath,artifactError,error,rawVerdict,createdAt,updatedAt,approvedAt}`

**状态机**

| 当前 | 事件 | 下一状态 |
|---|---|---|
| starting | threadId 已取得、可见性未确认 | awaiting-visibility |
| awaiting-visibility | continue(confirmVisibility:true) | reviewing（只发一次 turn） |
| awaiting-visibility | cancel | cancelled |
| awaiting-visibility | daemon 重启 | interrupted |
| reviewing | approve | approved |
| reviewing | changes-required/discuss，round<max | changes-required |
| reviewing | changes-required/discuss，round>=max | deadlock |
| reviewing | worker 失败/退出 | failed/interrupted |
| changes-required | respond | reviewing |
| deadlock | 人 1（仅一次） | reviewing（最后一轮，`finalRoundUsed=true`） |
| deadlock | 人 0 | cancelled |
| reviewing/changes-required | daemon 重启 | interrupted（记录 `interruptedFrom`） |
| interrupted | recover: `interruptedFrom=reviewing` | awaiting-visibility（新 worker，确认后 continue） |
| interrupted | recover: `interruptedFrom=changes-required` | changes-required（不发 turn） |
| interrupted | recover: `interruptedFrom=awaiting-visibility` | awaiting-visibility |

- [ ] **Step 1: 写失败测试**

`plan-review-test-support.mjs` 提供：
- `reviewFixture({verdicts, clock})`：临时项目/计划、状态化 fake workers（`start/turn/result/close`），同一 turn 重复读返回同一结果；`setVerdicts`、`advance(ms)`、`waitStatus`。
- `fakeWorkers` 记录 `start` 参数，返回 `{workerId:'w1',threadId:'t1',status:'starting'}`；`result` 返回当前 turn；`close`。

```js
test('approve writes the review section and preserves input hash', async () => {
  const f=await reviewFixture({verdicts:[approveVerdict]});
  const started=await f.service.start({session:f.session,planPath:'docs/superpowers/plans/demo.md'});
  const done=await f.waitStatus(started.reviewId,'approved');
  const text=await readFile(join(f.project,'docs/superpowers/plans/demo.md'),'utf8');
  assert.match(text,/review: approved/);
  assert.equal(parsePlanDeclaration(text).inputHash, started.planHash);
});

test('changes-required then respond approves on round 2', async () => {
  const f=await reviewFixture({verdicts:[changesVerdict,approveVerdict]});
  const started=await f.service.start({session:f.session,planPath:'docs/superpowers/plans/demo.md'});
  assert.equal((await f.waitStatus(started.reviewId,'changes-required')).status,'changes-required');
  await f.service.respond({session:f.session,reviewId:started.reviewId,responses:[{type:'issue',issueId:'R1',decision:'accept',evidence:'已改'}],expectedRound:1,requestId:'req-1'});
  assert.equal((await f.waitStatus(started.reviewId,'approved')).status,'approved');
  assert.equal(f.fake.startCount,2);
});

test('three unresolved blockers deadlock and the final human round is one-shot', async () => {
  const f=await reviewFixture({verdicts:[changesVerdict,changesVerdict,changesVerdict,approveVerdict]});
  const started=await f.service.start({session:f.session,planPath:'docs/superpowers/plans/demo.md'});
  await f.waitStatus(started.reviewId,'changes-required');
  for (const i of [1,2]) {
    await f.service.respond({session:f.session,reviewId:started.reviewId,responses:[{type:'issue',issueId:'R1',decision:'reject',evidence:'证据'}],expectedRound:i,requestId:'r'+i});
    await f.waitStatus(started.reviewId,'changes-required').catch(()=>{});
  }
  assert.equal((await f.waitStatus(started.reviewId,'deadlock')).status,'deadlock');
  const final=await f.service.decide({session:f.session,reviewId:started.reviewId,choice:'1'});
  assert.equal(final.status,'reviewing');
  assert.equal(final.finalRoundUsed,true);
  await assert.rejects(f.service.decide({session:f.session,reviewId:started.reviewId,choice:'1'}),/final round/i);
  assert.equal((await f.waitStatus(started.reviewId,'approved')).status,'approved');
});

test('an unparseable verdict fails and keeps raw text', async () => {
  const f=await reviewFixture({verdicts:['not a verdict']});
  const started=await f.service.start({session:f.session,planPath:'docs/superpowers/plans/demo.md'});
  const done=await f.waitStatus(started.reviewId,'failed');
  assert.match(done.error,/verdict/i);
  assert.match(done.rawVerdict,/not a verdict/);
});

test('restart from changes-required keeps waiting for responses and takeover updates the actor', async () => {
  const f=await reviewFixture({verdicts:[changesVerdict,approveVerdict]});
  const started=await f.service.start({session:f.session,planPath:'docs/superpowers/plans/demo.md'});
  const before=await f.waitStatus(started.reviewId,'changes-required');
  await f.service.close();
  const reopened=createPlanReviewService({store:f.store,workers:f.fake,config:{...DEFAULT_PLAN_REVIEW}});
  await reopened.resume();
  const interrupted=reopened.list({session:f.session}).reviews[0];
  assert.equal(interrupted.status,'interrupted');
  assert.equal(interrupted.interruptedFrom,'changes-required');
  const other={...f.session,id:'other-claude-session'};
  const recovered=await reopened.recover({session:other,reviewId:started.reviewId,takeover:true});
  assert.equal(recovered.status,'changes-required');
  assert.equal(recovered.currentActorSessionId,'other-claude-session');
  assert.equal(recovered.round,before.round);
  assert.equal(recovered.deadline,before.deadline);
  assert.equal(recovered.finalRoundUsed,before.finalRoundUsed);
  assert.equal(recovered.workerId,before.workerId);
  await assert.rejects(reopened.result({session:f.session,reviewId:started.reviewId}),/actor/i);
});

test('restart from reviewing creates a replacement worker and waits for visibility confirmation', async () => {
  const f=await reviewFixture({verdicts:[approveVerdict]});
  const started=await f.service.start({session:f.session,planPath:'docs/superpowers/plans/demo.md'});
  await f.waitStatus(started.reviewId,'reviewing');
  await f.service.close();
  const reopened=createPlanReviewService({store:f.store,workers:f.fake,config:{...DEFAULT_PLAN_REVIEW}});
  await reopened.resume();
  const interrupted=reopened.list({session:f.session}).reviews[0];
  assert.equal(interrupted.status,'interrupted');
  await assert.rejects(reopened.continueReview({session:f.session,reviewId:started.reviewId,confirmVisibility:true}),/awaiting-visibility/);
  const baseline=f.fake.turnCount;
  const recovered=await reopened.recover({session:f.session,reviewId:started.reviewId});
  assert.equal(recovered.status,'awaiting-visibility');
  assert.notEqual(recovered.workerId,started.workerId);
  assert.notEqual(recovered.threadId,started.threadId);
  assert.equal(f.fake.turnCount,baseline);
  const continued=await reopened.continueReview({session:f.session,reviewId:started.reviewId,confirmVisibility:true});
  assert.equal(continued.status,'reviewing');
  assert.equal(f.fake.turnCount,baseline+1);
  await reopened.continueReview({session:f.session,reviewId:started.reviewId,confirmVisibility:true});
  assert.equal(f.fake.turnCount,baseline+1);
});

test('visibility is not confirmed until continue; no turn is sent before that', async () => {
  const f=await reviewFixture({verdicts:[approveVerdict],focus:{confirmed:false}});
  const started=await f.service.start({session:f.session,planPath:'docs/superpowers/plans/demo.md'});
  await f.waitStatus(started.reviewId,'awaiting-visibility');
  assert.equal(f.fake.turnCount,0);
  const continued=await f.service.continueReview({session:f.session,reviewId:started.reviewId,confirmVisibility:true});
  assert.equal(continued.status,'reviewing');
  assert.equal(f.fake.turnCount,1);
  await f.waitStatus(started.reviewId,'approved');
});

test('question-only responses are accepted and coverage is enforced', async () => {
  const f=await reviewFixture({verdicts:[discussVerdict,approveVerdict],focus:{confirmed:true}});
  const started=await f.service.start({session:f.session,planPath:'docs/superpowers/plans/demo.md'});
  await f.waitStatus(started.reviewId,'changes-required');
  const question={type:'question',questionId:'Q1',answer:'已确认'};
  await assert.rejects(f.service.respond({session:f.session,reviewId:started.reviewId,responses:[],expectedRound:1,requestId:'empty'}),/question/i);
  await f.service.respond({session:f.session,reviewId:started.reviewId,responses:[question],expectedRound:1,requestId:'q1'});
  await f.waitStatus(started.reviewId,'approved');
});

test('concurrent respond with the same requestId only advances one round', async () => {
  const f=await reviewFixture({verdicts:[changesVerdict,approveVerdict]});
  const started=await f.service.start({session:f.session,planPath:'docs/superpowers/plans/demo.md'});
  await f.waitStatus(started.reviewId,'changes-required');
  const responses=[{type:'issue',issueId:'R1',decision:'accept',evidence:'已改'}];
  await Promise.all([
    f.service.respond({session:f.session,reviewId:started.reviewId,responses,expectedRound:1,requestId:'same'}),
    f.service.respond({session:f.session,reviewId:started.reviewId,responses,expectedRound:1,requestId:'same'})
  ]);
  assert.equal(f.fake.startCount,2);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test plan-review.test.mjs`
Expected: FAIL

**Rev 2 必须补的服务测试（R8/R10/R11/R12/R16/R19）：**
- 两个连续 worker 都返回 `lastTurn.id=1`，`result` 与 `reconcile` 都能处理第二次。
- `result`/`reconcile`/`respond`/`decide` 交错，状态只迁移一次；同 requestId 不同 payload 拒绝。
- 同项目新 session `takeover` 成功；跨项目拒绝；旧 actor 的 result/respond 被拒。
- 第 4 轮仍失败、重复 `decide`、多次重启都不绕过轮数/时长上限。
- 101 条历史后仍能查到当前批准；正文或 hash 变化后需重审；计划删除后批准失效。
- `respond` 漏答 blocker/major/question、重复/未知/旧轮 issueId 被拒。

- [ ] **Step 3: 实现**

- `workspace.mjs`：新增 meta key `planReviews` 与 `planApprovals`；`listPlanReviews()`/`savePlanReview(record)`；`getPlanApproval(projectId,planPath)`/`savePlanApproval(...)`。保留所有非终态 + 当前有效批准 + 最近 100 条其它终态；重启把 `reviewing|changes-required` 改 `interrupted`。
- `start`：`readPlan`（realpath 在项目内、普通文件、<=maxPlanBytes）；`session.tool==='claude'`；per-review 队列 + 全局 start 锁；幂等查找 `(projectId,planPath,inputHash)`；记录 `createdBySessionId/currentActorSessionId`；两阶段启动：空 worker（`tier:'consult'`、`kind:'review'`、`risk:'high'`、`model:'auto'`、`effort:'high'`、`mcp:'none'`）→ 等待 `threadId` → `focusThread`；未确认时状态 `awaiting-visibility`，**不发 turn**，`continueReview({confirmVisibility:true})` 后才 `workers.turn(buildReviewPrompt)`；保存 `workerId/threadId/round/inputHash`。
- `result`：按 `currentActorSessionId` 校验；`reviewing` 时 `workers.result`；turn 完成后 `parseVerdict`；用 `workerId:turnId` 去重（R8）。
- `continueReview`：只允许 `awaiting-visibility`；`confirmVisibility:true` 且 actor 匹配时发一次 turn；重复调用不重复发 turn；`interrupted` 一律走 `recover`；与 daemon 启动的 `resume()` 分开。
- `respond`：per-review 队列；`expectedRound`；`requestId` 持久化，同 id 不同 payload 拒绝；重新 `readPlan` 并更新本轮快照/hash；发送完整当前计划 + 约束 + 历史摘要（不只未解决项）；`responses` 两种形状：`{type:'issue',issueId,decision:'accept'|'reject',evidence?,planChange?}` 或 `{type:'question',questionId:'Qn',answer}`；必须覆盖当前轮全部 blocker/major 与 questions；未知/重复/旧轮拒绝；round++。
- `finalizeApproved`：写 `## Codex review` 前重新读计划并核对 `planHash`；不一致 → `changes-required`，不覆盖；成功后写 `planApprovals` 索引。
- `reconcile`：`start` 后启动 30 秒定时器；只扫 `reviewing` 且有 `workerId` 的记录；调用 `workers.result` 非阻塞读；按当前 generation 的 `lastTurn.status` 判定完成/失败（不是 `worker.status`）；处理后 `workers.close`；`close` 返回 orphan/失败时记 `cleanup:'orphan'`，不得宣称容量已释放；按 Rev 4 映射表把 `worker.status`/`stopReason` 映射为 review `failed`/`interrupted`；用 `workerId:turnId` 去重；检查 `deadline`（wholeReviewMs）。`close()` 清定时器。
- `writeArtifact`：`.sibyl/reviews/<reviewId>.json` 保存每轮不可变 `rounds:[{round,planHash,planSnapshot,verdict,issues,responses,rawVerdict}]`；`artifactError` 暴露在 publicReview；写失败不改变评审状态。
- `budget`：只保留 `wholeReviewMs`/`turnMs` 时间预算；超过 `wholeReviewMs` → `failed`（`error` 以 `timeout:` 开头）；不设 token/USD 硬上限（Stage 2）。
- `deadlock`：3 轮仍不通过；`finalRoundUsed` 持久化，最后加轮只能一次（R12）。
- `decide`：只接受 `1` → 启动最后一轮（reviewer 意见，写 `finalRoundUsed`）；`0` → `cancelled`；不通过工具产生 `waived`；重复 decide 拒绝。
- `recover`：按 `interruptedFrom` 分支：`changes-required` → 恢复为 `changes-required`，不发 turn、不加轮，等合法 `respond`；`reviewing` → 启动替代 worker、取得新 `threadId`、进入 `awaiting-visibility`，再由 `continueReview` 确认发 turn；`awaiting-visibility` → 恢复 `awaiting-visibility`；同项目新 Claude 会话可 `takeover:true`，原子更新 `currentActorSessionId`；轮数/deadline/`finalRoundUsed` 不重置（R11/R12）。
- `check`：token-only；磁盘候选 ∪ 已管理路径；按当前 `projectId+planPath+inputHash` 查 `planApprovals`；未批准的结构计划 → `{block:true,mode:'ask'|'deny',reason}`；受管理文件坏声明 → block。
- `close`：清队列/定时器；不关闭 worker 服务。

- [ ] **Step 4: 运行测试**

Run: `node --test plan-review.test.mjs plan-review-policy.test.mjs workspace.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add plan-review.mjs plan-review-test-support.mjs workspace.mjs plan-review.test.mjs workspace.test.mjs
git commit -m "feat(plan-review): add the core review service"
```

---

### Task 3: `--mcp none` 与只读评审 worker

**Files:**
- Modify: `scripts/spawn-codex-chat.mjs`
- Modify: `workers.mjs`
- Modify: `worker-test-support.mjs`
- Test: `review-worker.test.mjs`

**Interfaces:**
- `workers.start({...,mcp:'none'|'full'})`；默认 `full`。
- `spawn-codex-chat.mjs --mcp none`：`mcp_servers:{}`，不注入 ai-bridge。
- 评审用 `tier:'consult'`（现有只读、可见、单轮 worker）；不新增 tier。
- `review-worker.test.mjs`：用 fake script 断言 argv 含 `--mcp none`、`--sandbox read-only`、`--model gpt-6-astra`；无 worktree。

- [ ] **Step 1: 写失败测试**

```js
test('review worker is read-only, single-turn and has no ai-bridge MCP', async () => {
  const f=await reviewWorkerFixture();
  const started=await f.service.start({session:f.session,tool:'codex',tier:'consult',kind:'review',risk:'high',model:'gpt-6-astra',effort:'high',mcp:'none',prompt:'review'});
  const done=await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:100});return r.status==='completed'?r:null;});
  assert.equal(done.worktreePath,null);
  assert.equal(done.branch,null);
  const args=JSON.parse(await readFile(join(f.project,'args.json'),'utf8'));
  assert.ok(args.includes('--mcp'));
  assert.ok(args.includes('none'));
  assert.ok(args.includes('read-only'));
  assert.ok(args.includes('gpt-6-astra'));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test review-worker.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

- `scripts/spawn-codex-chat.mjs`：新增 `--mcp` 参数；`none` 时 `mcp_servers:{}`；默认 `full` 保持现有行为。
- `workers.mjs`：`start` 接受 `mcp`；`spawnChild` 传 `--mcp`。
- `worker-test-support.mjs`：fake script 写 `args.json`；新增 `reviewWorkerFixture`。
- 不新增 tier；不改 `checkWorkerCapacity`；评审占 consult 容量（核心版限制）。

- [ ] **Step 4: 运行测试**

Run: `node --test review-worker.test.mjs tiers.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add scripts/spawn-codex-chat.mjs workers.mjs worker-test-support.mjs review-worker.test.mjs
git commit -m "feat(worker): allow a review worker without the ai-bridge MCP"
```

---

### Task 4: 本地 HTTP 端点与 MCP 工具

**Files:**
- Modify: `native-inbox.mjs`
- Modify: `native-mcp.mjs`
- Modify: `control.mjs`（只加 `planReview` 透传）
- Test: `plan-review-api.test.mjs`, `plan-review-tool.test.mjs`

**Interfaces:**
- 所有请求带 `protocol:'plan-review/v1'`；不一致返回 400 `{error}`。
- **Token-only，且在 `own(body)` 之前分流**：`POST /plan-review/check` `{projectPath,filePath?,mode?}` → `{block,mode:'ask'|'deny'|'warn',reason,plans}`。
- Session lease：
  - `/plan-review/start` `{planPath}` → 202
  - `/plan-review/result` `{reviewId,waitMs}`
  - `/plan-review/respond` `{reviewId,responses,expectedRound,requestId}`
  - `/plan-review/decide` `{reviewId,choice}`，`choice` 只接受 `1`（最后加轮）或 `0`（取消）
  - `/plan-review/continue` `{reviewId,confirmVisibility:true}`
  - `/plan-review/recover` `{reviewId,takeover?}`
  - `/plan-review/list` `{all?}`
- 校验：`planPath` <=1024；`reviewId` 合法 UUID；`waitMs 0..25000`；`responses` 1..20 个；issue 形如 `{type:'issue',issueId:/^[A-Za-z0-9_-]{1,20}$/ 且非 /^Q\d+$/,decision:'accept'|'reject',evidence?,planChange?}`；question 形如 `{type:'question',questionId:/^Q\d+$/,answer}`；`evidence`/`planChange`/`answer` <=2000；`Buffer.byteLength(JSON.stringify(responses)) <= 12000`。
- `respond` 必须覆盖当前轮全部 `blocker`/`major` 和 `questions`；未知/重复/旧轮引用拒绝；`accept` 至少给 `planChange` 或 `evidence`，`reject` 至少给 `evidence`，question 必须给非空 `answer`。
- MCP：`bridge_plan_review` / `_result` / `_respond` / `_decide` / `_continue` / `_recover` / `_list`；`responses` 用 JSON 字符串，解析后按字节校验。

- [ ] **Step 1: 写失败测试**

- `tools/list` 含七个工具（`bridge_plan_review`、`_result`、`_respond`、`_decide`、`_continue`、`_recover`、`_list`）。
- `/respond` 缺 evidence、非法 UUID、超字节预算分别报错。
- `createControl` 透传 `planReview`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test plan-review-api.test.mjs plan-review-tool.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

- 按接口加端点/工具；复用现有 `own(body)` 租约；token-only check。
- 失败路径返回现有 `send(400,{error})`；MCP 错误返回 `isError`。

- [ ] **Step 4: 运行测试**

Run: `node --test plan-review-api.test.mjs plan-review-tool.test.mjs native-inbox.test.mjs native-mcp.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add native-inbox.mjs native-mcp.mjs control.mjs plan-review-api.test.mjs plan-review-tool.test.mjs
git commit -m "feat(plan-review): add core HTTP endpoints and MCP tools"
```

---

## Task 5: Claude Code hooks（Stop / PreToolUse）

**Files:**
- Create: `scripts/sibyl-hook.mjs`
- Modify: `native-config.mjs`
- Test: `sibyl-hook.test.mjs`, `native-config.test.mjs`

**Interfaces:**
- `scripts/sibyl-hook.mjs --dir <dataDir> --event stop|pre-tool`，读 stdin JSON；每个请求带 `protocol:'plan-review/v1'`。
- Stop：`{decision:'block',reason}` / `{}`；`stop_hook_active` → `{}`；daemon 不在/超时 → `{}`；协议不一致 → `{}` + `notice` 字段。
- PreToolUse：只处理 `Write`/`Edit`/`MultiEdit`；调用 `/plan-review/check`（带 `filePath` 和 `mode`）；返回 `{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny'|'ask',permissionDecisionReason}}` 或 `{}`；无 state 默认 `ask`；`irreversible` 返回 `deny`；`warn` 返回 `{}`。
- `configureNativeTool({tool:'claude',...})` 写 `.claude/settings.local.json` 的 `hooks.Stop`、`hooks.PreToolUse`；叶子级合并，保留其他 hooks；备份一次；非法 JSON 原样保留；无法唯一识别目标叶子时拒绝并报错（fail-closed）。

- [ ] **Step 1: 写失败测试**

```js
test('stop blocks an unreviewed plan and fails open', async () => {
  const input={cwd:'/p',stop_hook_active:false};
  const call=async p=>p==='/plan-review/check'?{block:true,reason:'请先评审'}:{};
  assert.deepEqual(await decideStop(input,call),{decision:'block',reason:'请先评审'});
  assert.deepEqual(await decideStop({...input,stop_hook_active:true},call),{});
  assert.deepEqual(await decideStop(input,async()=>{throw Error('down');}),{});
});

test('pre-tool denies or asks before an unapproved structural plan is edited', async () => {
  const call=async()=>({block:true,mode:'ask',reason:'结构计划未评审'});
  const asked=await decidePreTool({cwd:'/p',tool_name:'Write',tool_input:{file_path:'/p/src/a.mjs'}},call);
  assert.equal(asked.hookSpecificOutput.permissionDecision,'ask');
  const denied=await decidePreTool({cwd:'/p',tool_name:'Edit',tool_input:{file_path:'/p/docs/superpowers/plans/x.md'}},async()=>({block:true,mode:'deny',reason:'不可逆'}));
  assert.equal(denied.hookSpecificOutput.permissionDecision,'deny');
  assert.deepEqual(await decidePreTool({cwd:'/p',tool_name:'Read',tool_input:{}},call),{});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test sibyl-hook.test.mjs native-config.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

- hook 脚本：只在直接执行时读 stdin；导出 async `decideStop`/`decidePreTool`；runtime 校验 127.0.0.1/http；1.5s 超时；错误输出 `{}`；所有请求带 `protocol`。
- `configureClaudeHooks`：写 `hooks.Stop`、`hooks.PreToolUse`；以 `node 路径 + 脚本路径 + resolve(dataDir) + --event <name>` 精确识别受管叶子；零匹配插入、一匹配更新、多匹配拒绝；先校验全部目标文件再写；保留其他 hooks/matcher；备份不覆盖；非法 JSON 原样保留。
- PreToolUse matcher 用 `Write|Edit|MultiEdit`；只在 `hookSpecificOutput` 形状下输出；未知事件返回 `{}`。
- 协议不一致返回合法 JSON `{}` 并带 `notice` 字段，不在 `{}` 后拼接文本。
- 进程级测试：真实 stdin/stdout/退出码；stop/pre-tool；deny/allow/超时；用户已有 hook 共存；Windows 空格路径。

- [ ] **Step 4: 运行测试**

Run: `node --test sibyl-hook.test.mjs native-config.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add scripts/sibyl-hook.mjs native-config.mjs sibyl-hook.test.mjs native-config.test.mjs
git commit -m "feat(hooks): block unreviewed structural plans at Stop"
```

---

### Task 6: daemon 接线、状态、文档与端到端

**Files:**
- Modify: `control.mjs`
- Modify: `CLAUDE.md`
- Modify: `skills/agents-calling/SKILL.md`
- Modify: `使用说明.md`
- Modify: `README.md`
- Test: `control-v3.test.mjs`, `plan-review-e2e.test.mjs`

**Interfaces:**
- `createControl` 新增 `planReviewConfig`；创建 `planReviews`；传 `planReview` 给 inbox。
- `state()` 新增 `planReviews`。
- `close()` 先 `planReviews.close()`，再 `workers.closeAll()`。
- 文档写明核心版边界：有 Stop + PreToolUse（提醒/ask/deny，不保证覆盖 Bash/git/worker 写入）；无微信、无 daemon gate、无 UserPromptSubmit；每轮新线程；占 consult 容量；不设 USD 硬上限。

- [ ] **Step 1: 写失败测试**

- `/api/status` 有 `planReviews`。
- fake consult worker 走完整回路：start → result → changes-required → respond → approved。
- `close()` 清队列/定时器。
- 全量测试 0 fail。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test control-v3.test.mjs plan-review-e2e.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

- `control.mjs` 接线、state、close。
- `CLAUDE.md`/`SKILL.md`/`使用说明.md`/`README.md` 更新流程和 Phase 2 清单。
- `## Codex review` 填入核心计划的评审结论（若已评审）。

- [ ] **Step 4: 运行全量测试**

Run:
`"/d/LXY_workspace/AI Bridge/.tools/node26/node-v26.13.0-win-x64/node.exe" --test --test-concurrency=1 --test-timeout=30000 *.test.mjs`
Expected: 0 fail（允许既有 skip）。

- [ ] **Step 5: 提交**

```bash
git add control.mjs CLAUDE.md skills/agents-calling/SKILL.md 使用说明.md README.md control-v3.test.mjs plan-review-e2e.test.mjs
git commit -m "feat(plan-review): wire the core review loop into the daemon"
```

---

## Codex review

### Round 1 — 2026-11-08，gpt-6.1-sol（effort high），只读 consult worker

Verdict：`changes-required`。1 blocker + 19 major/minor。

- **Blocker R1**：Stop 在工具执行后触发，PreToolUse 只覆盖 Write/Edit/MultiEdit；Bash/git/worker 写入和普通 ask 放行，使“通过后才写代码”无法保证。
- **Major**：两阶段可见启动缺失；人工裁决可被执行方自批 `waived`；hooks/inbox 契约未闭合；Focus 覆盖会误杀合法批准；hash/生成块规范不足；`lastProcessedTurnId` 跨 worker 冲突；每轮新线程与局部复审不兼容；状态迁移竞态；真实重启身份变化；轮数/最后加轮不是封闭状态机；USD 预算无计量来源；worker `stopped/orphan` 未映射；证据覆盖；100 条淘汰会删有效批准；hook 去重未隔离；`respond` 未强制覆盖。
- **Minor**：hook 所有权识别歧义；定稿补充未同步任务/文案。

**采纳**：Rev 2 逐条回应。核心版收缩为“提醒 + 尽力拦截”，不做 UserPromptSubmit / 强制 Focus 覆盖 / USD 硬上限 / 工具 waived；补两阶段启动、`workerId:turnId`、per-review 队列、同项目 takeover、`finalRoundUsed`、每轮快照、`planApprovals` 索引、精确 hook 所有权、`respond` 覆盖校验、canonical hash、生成块扫描。
**未采纳/后置**：daemon gate、persistent 同线程、微信、独立 review tier、强制 Focus coverage、USD 计量、Bash/git 写入硬拦——Stage 2。

### Round 2 — 2026-11-08，gpt-6.1-sol（effort high），只读 consult worker

Verdict：`changes-required`，无 blocker，5 major + 3 minor。

- **Major R2**：可见性未确认仍继续发 turn，违反 CLAUDE.md 的“确认窗口在前台后再派任务”。
- **Major R6**：canonical 仍只有原则，没有字段默认值、序列化字节、hashVersion 保存/比较和固定向量。
- **Major R12**：示例测试从 `changes-required` 重启后直接 recover 为 `reviewing`，会绕过待回应。
- **Major R14**：两阶段 `workers.turn` 完成后 `worker.status` 仍是 `running`，reconcile 按 worker completed 会一直不处理；也未规定每轮关闭 worker。
- **Major R19**：questions 没有合法回应形状，`issueId` 又禁止 Q 编号，含 questions 的回路无法继续。
- **Minor R7**：读取/hash/写回可能使用不同扫描逻辑；畸形块处理未明确。
- **Minor R11**：takeover 的 current actor 与 sourceSessionId 职责未分清。
- **Minor R20**：旧文残留 waived/UserPromptSubmit/强制 Focus/USD/绝对阻断验收。

**采纳**：Rev 3 逐条修正（可见性门禁、canonical v1、interruptedFrom 分支、lastTurn.status + close、question 回应形状、共用扫描器、currentActorSessionId、清理残留）。**未采纳**：无。

### Round 3 — 2026-11-08，gpt-6.1-sol（effort high），只读 consult worker

Verdict：`changes-required`，无 blocker，2 major + 4 minor。

- **Major R2**：`awaiting-visibility` 没有可调用的继续入口；`REVIEW_STATES`/状态表缺该状态；`resume()` 与启动初始化职责混淆。
- **Major R6**：canonical 缺逐字段默认值、非法类型处理、`hashVersion` 的持久化与批准查询比较规则；`JSON.stringify` 省略 undefined 会产生不同字节。
- **Minor R12**：重启测试仍断言 `changes-required → reviewing`，与 Rev 3 规范相反。
- **Minor R14**：异常映射未逐项对应；`exit-unconfirmed` 属于 `stopReason`；`close` 可能返回 orphan，不能宣称容量已释放。
- **Minor R19**：测试 issue 回应缺 `type:'issue'`；`parseVerdict` 未同步拒绝 Q 编号。
- **Minor R20**：仍有 `choice=2`、UserPromptSubmit、局部复审等旧承诺。

**采纳**：Rev 4 逐条修正（`bridge_plan_review_continue`、canonical 默认值/hashVersion、测试同步、映射表/cleanup、type/Q 编号、残留清理）。**未采纳**：无。

### Round 4 — 2026-11-08，gpt-6.1-sol（effort high），只读 consult worker

Verdict：`changes-required`，无 blocker，1 major + 1 minor。

- **Major R2**：`continueReview` 允许直接处理任意 `interrupted`，与 `recover` 分支冲突；替代 worker 测试未先确认新线程可见就发 turn。
- **Minor R20**：仍残留 `choice=2`、局部复审、六工具等旧文案；设计范围引用仍是 Rev 3。

**采纳**：Rev 5 修正（`continueReview` 只处理 `awaiting-visibility`；`interrupted` 走 `recover`；`reviewing` 恢复先进入 `awaiting-visibility`；测试断言确认前零 turn；清理旧文案；设计引用更新到 Rev 5）。**未采纳**：无。

### Round 5 — 2026-11-08，gpt-6.1-sol（effort high），只读 consult worker

Verdict：**approve**。无 blocker/major；1 minor（恢复测试复用 fake，累计 `turnCount` 断言可能误报）。

**采纳**：恢复测试改为记录基线计数、断言 recover 不增加、continue 只增加一次、重复 continue 不再增加，并断言新 `threadId`。计划通过，开始 Task 1。

## Phase 2（不在本计划）

- 微信死锁通知/回复与高水位/增量导出。
- daemon 写门禁（worker-start/finalize/accept）；PreToolUse 已在核心版。
- 高风险不可逆操作的人批与 waiver 语义。
- 独立 `review` tier、persistent 同线程多轮、watchdog pause。
- 动作日志、崩溃精确重放、多计划批准绑定、可达性保留策略。
- 运行台可视化、本地模型第二意见、ACP `session/load`。

## Implementation status（2026-11-09）

- Task 1–6 implemented on `feat/windows-support`.
- Commits：`23d3bd1` policy；`fde2a5e` service + persistence；`749e9e9` worker MCP isolation；`814b798` endpoints + tools；`6a12de0` hooks；`b44a125` wiring + docs。
- Full suite：262 tests，258 pass / 4 skip / 0 fail（Node 26，2026-11-09）。
- 未做/留后续：真实 Codex 可见性验收（需在 Codex 重启后确认线程可见）、微信死锁通道、daemon gate、persistent 同线程、USD 计量、强制 Focus 覆盖、运行台可视化。
- 已知限制：PreToolUse 只覆盖 `Write`/`Edit`/`MultiEdit`/`NotebookEdit`；Bash/git/worker 写入不硬拦；`awaiting-visibility` 需要人/CLI 确认；评审 worker 占 consult 容量。

## 验收边界（2026-11-09）

计划评审不是“把计划改到完美”，验收也不以 `approve` 为唯一目标。

**验收看什么**

- 一轮完整真实回路：`start` → `awaiting-visibility` → `continue` → 真实 Codex verdict → 结构化 issue、artifact 和状态迁移。
- `changes-required` 也是验收通过：说明评审器能返回可执行问题，执行方可以继续回应；不要求验收时把计划改到 `approve`。
- `approve` 的标准是“没有未解决的 blocker/major”，不是“没有任何 minor”；minor 记录即可。
- artifact 必须含 `planHash`、本轮快照、verdict、issues；状态迁移必须可观察。

**有界停止**

- 最多 3 轮；3 轮后仍有 blocker/major → `deadlock`，由人决定最后加轮或取消。
- 最后加轮只能一次（`finalRoundUsed`）。
- 每次 `changes-required` 后停在等待 `respond`，不自动续轮、不自动改计划。
- 超时/失败/重启 → `failed`/`interrupted`，不静默重试。
- `Review Focus` 是输入，不是必须逐条制造 issue 的清单；评审器不追求“完美计划”。

**真实验收只跑一轮**

- 真实 Codex 只验证协议、可见性、verdict、artifact、状态；其余轮次、并发、重启、question 回应由 fake worker 单元测试覆盖。
- 本次真实验收结果：`changes-required`，2 条 major，artifact 已落盘；这视为回路验收通过，不继续追 `approve`。