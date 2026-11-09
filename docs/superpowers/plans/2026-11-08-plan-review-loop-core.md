# Plan Review Loop — 核心版实施计划

> **状态：已实现（2026-11-09）**。Task 1–6 全部落地，全量测试 0 fail。
> 本文件既是实施记录，也是当前契约参考；后续改动请只改「最终设计契约」一节，不要再追加 Rev 段落。
>
> **For agentic workers:** 若要按本计划重做或续做，使用 superpowers:subagent-driven-development 或 superpowers:executing-plans，用 `- [ ]` 跟踪步骤。

**Goal:** Claude 产出或修改结构性的实施计划时，自动让 Codex 在可见会话里评审；执行方逐条回应；未通过评审时 Stop hook 提醒并阻止本轮结束，PreToolUse 对普通写返回 `ask`、对声明为不可逆的写返回 `deny`；死锁由人手动裁决。核心版不承诺绝对阻断，daemon gate 留给 Stage 2。

**Architecture:** 复用 Phase B 的 daemon、worker 服务和 SQLite。评审使用现有只读 `consult` worker（每轮一个 worker，不新增 tier），通过 `--mcp none` 隔离写工具。新增 `plan-review-policy.mjs`、`plan-review.mjs`、HTTP/MCP 端点和一个 Claude Code `Stop` hook。评审记录存入现有 `meta` 表，不升 schema 版本。

**Tech Stack:** Node.js >= 26，零第三方依赖；`node:sqlite`；MCP stdio；Claude Code hooks。

**Spec:** `docs/superpowers/specs/2026-11-08-plan-review-loop-design.md`
**全量版参考（Phase 2）:** `docs/superpowers/plans/2026-11-08-plan-review-loop.md`

---

## 1. 当前状态

| 任务 | 内容 | 提交 |
|---|---|---|
| Task 1 | 声明、稳定 hash、判断与协议（`plan-review-policy.mjs`） | `23d3bd1` |
| Task 2 | 评审服务与持久化（`plan-review.mjs`、`workspace.mjs`） | `fde2a5e` |
| Task 3 | `--mcp none` 与只读评审 worker | `749e9e9` |
| Task 4 | 本地 HTTP 端点与 MCP 工具 | `814b798` |
| Task 5 | Claude Code hooks（Stop / PreToolUse） | `6a12de0` |
| Task 6 | daemon 接线、状态、文档与端到端 | `b44a125` |

- 全量测试：262 tests，258 pass / 4 skip / 0 fail（Node 26，2026-11-09）。
- 真实验收：一轮真实 Codex 回路返回 `changes-required`（2 条 major），artifact 已落盘；按 §2 视为回路验收通过，不追 `approve`。
- 未完成/留后续：真实 Codex 可见性验收（需重启 Codex 后确认线程可见）、微信死锁通道、daemon gate、persistent 同线程、USD 计量、强制 Focus 覆盖、运行台可视化。
- 已知限制：PreToolUse 只覆盖 `Write`/`Edit`/`MultiEdit`/`NotebookEdit`；Bash/git/worker 写入不硬拦；`awaiting-visibility` 需人/CLI 确认；评审 worker 占 consult 容量。

## 2. 验收边界

计划评审不是「把计划改到完美」，验收也不以 `approve` 为唯一目标。

**验收看什么**

- 一轮完整真实回路：`start` → `awaiting-visibility` → `continue` → 真实 Codex verdict → 结构化 issue、artifact 和状态迁移。
- `changes-required` 也是验收通过：说明评审器能返回可执行问题，执行方可以继续回应；不要求验收时把计划改到 `approve`。
- `approve` 的标准是「没有未解决的 blocker/major」，不是「没有任何 minor」；minor 记录即可。
- artifact 必须含 `planHash`、本轮快照、verdict、issues；状态迁移必须可观察。

**有界停止**

- 最多 3 轮；3 轮后仍有 blocker/major → `deadlock`，由人决定最后加轮或取消。
- 最后加轮只能一次（`finalRoundUsed`）。
- 每次 `changes-required` 后停在等待 `respond`，不自动续轮、不自动改计划。
- 超时/失败/重启 → `failed`/`interrupted`，不静默重试。
- `Review Focus` 是输入，不是必须逐条制造 issue 的清单；评审器不追求「完美计划」。

**真实验收只跑一轮**

- 真实 Codex 只验证协议、可见性、verdict、artifact、状态；其余轮次、并发、重启、question 回应由 fake worker 单元测试覆盖。

## 3. 核心版范围

### 3.1 做

- 计划 frontmatter 声明 `review` 与 `change`。
- 稳定 `planInputHash`：只含 `change` + 正文，排除 `review` 状态和生成的 `## Codex review` 区。
- 结构变更 → 启动一个可见、只读的 Codex consult worker。
- 结构化 verdict：`approve | changes-required | discuss`，issue 带 severity/位置/问题/建议。
- 执行方逐条回应；最多 3 轮；`discuss` 的 questions 编号为 `Q1..Qn`。
- 通过 → 写 `## Codex review`，声明改 `review: approved`。
- 死锁 → 状态 `deadlock`，由人通过 `bridge_plan_review_decide` 手动裁决（`1` = 按 Codex 意见最后再评一轮；`0` = 取消；核心版不通过工具产生 `waived`）。
- Stop hook：结构计划未批准时阻止本轮结束；fail-open。
- PreToolUse：`Write`/`Edit`/`MultiEdit` 调 `/plan-review/check`；未批准的结构计划返回 `ask`，声明不可逆时 `deny`。
- 重启：`reviewing`/`changes-required`/`awaiting-visibility` → `interrupted`；`bridge_plan_review_recover` 按 `interruptedFrom` 分支恢复。
- `reconcile`：每 30 秒扫 `reviewing`，处理已完成但未处理的 worker 结果。
- 证据落盘：每次终态写 `.sibyl/reviews/<reviewId>.json`（含每轮不可变快照）。
- `Review Focus` 作为评审输入。
- 协议版本 `plan-review/v1`。

### 3.2 不做（Stage 2）

- 微信死锁通知/回复。
- daemon 写门禁（worker-start/finalize/accept）与 PreToolUse 硬门禁。
- 高风险不可逆操作的人批与 waiver 语义。
- 独立 `review` tier、persistent 同线程多轮、ACP `session/load`。
- 动作日志/崩溃后精确重放、多计划批准绑定。
- 评审保留策略、运行台可视化、本地模型第二意见。
- 强制 Review Focus 覆盖、token/USD 计量与硬上限。
- `UserPromptSubmit` hook 与 `/plan-review/inbox`。

### 3.3 明确限制

- 核心版只承诺「提醒 + 尽力拦截」，不承诺「未批准前绝对不写文件」。Stop hook 在回合结束时提醒；PreToolUse 只在 Claude Code 支持该 hook 时生效；Bash、git、bridge worker 的写入不在核心版硬拦。
- 每轮评审 = 一个新的 Codex 可见线程；线程之间靠 review 记录的轮次上下文衔接，不是同一个线程。
- 评审占用 `consult` 的并发/预算；consult 满时评审会等待或失败。
- 人工裁决没有微信，需要在 Claude 里调用工具。

---

## 4. 最终设计契约

> 以下是 Rev 1–5 收敛后的唯一有效契约。与 §7 任务描述冲突时，以本节为准。

### 4.1 声明、hash 与生成块

**声明解析**（`parsePlanDeclaration(text) -> {review, change, body, focus, inputHash, errors}`）

- 无 frontmatter 或 `review` 非法 → `review:null` / `errors`，不触发评审。
- `review:not-required` 但存在结构性标志（`scope`/`concurrency`/`irreversible`/任务或文件规模）→ 升级为 required。
- `## Review Focus` 解析为 `[{id:'F1',text}]`，最多 `maxFocusItems`；只作为评审输入，**不强制**每个 F 项被 issue/question 引用，也不因未覆盖判失败。

**稳定 hash（`hashVersion:1`）**

- 参与字段固定为 `scope`（trim、去空、去重、按 UTF-8 字节序排序）、`concurrency`、`irreversible`、`tasks`、`files`。
- 默认值：`scope=[]`、`concurrency=false`、`irreversible=false`、`tasks=0`、`files=0`；类型错误直接拒绝，不做隐式转换。
- canonical 序列化：固定键序的 UTF-8 JSON，无空白。
- 正文：去 BOM、CRLF→LF、去掉生成块、仅去掉末尾空白（代码块内部空白保留）。
- 摘要：`SHA-256('plan-review/v1\n' + canonicalChange + '\n' + canonicalBody)`，小写 hex。
- `review` 状态、生成块、`reason` 不参与 hash。
- `hashVersion` 随 review/round/approval 保存；批准查询比较 `(hashVersion,inputHash)`；缺失或不支持 → 重审。
- 测试文件固定一组输入与期望摘要向量，覆盖缺省值与显式默认值等价。

**生成块扫描（三处共用同一扫描器）**

- `parsePlanDeclaration` / `stripGeneratedReview` / `writeCodexReviewSection` 必须用同一实现。
- 支持反引号与波浪号围栏；标记必须 **列 0、围栏外、独占一行、恰好一对**（`<!-- SIBYL_REVIEW_BEGIN -->` / `<!-- SIBYL_REVIEW_END -->`）。
- 重复/嵌套/缺失结束标记 → 写入 `errors`，不产生可批准的 hash，写回拒绝。
- 没有标记时，`writeCodexReviewSection` 在文末追加生成块，绝不删除用户手写的 `## Codex review` 正文。

### 4.2 状态机

| 当前 | 事件 | 下一状态 |
|---|---|---|
| starting | threadId 已取得、可见性未确认 | awaiting-visibility |
| awaiting-visibility | `continueReview(confirmVisibility:true)` | reviewing（只发一次 turn） |
| awaiting-visibility | cancel / decide 0 | cancelled |
| awaiting-visibility | daemon 重启 | interrupted |
| reviewing | approve | approved |
| reviewing | changes-required/discuss，round < max | changes-required |
| reviewing | changes-required/discuss，round >= max | deadlock |
| reviewing | worker 失败/退出/超时 | failed / interrupted |
| changes-required | respond | reviewing |
| deadlock | 人 `1`（仅一次） | reviewing（最后一轮，`finalRoundUsed=true`） |
| deadlock | 人 `0` | cancelled |
| reviewing / changes-required | daemon 重启 | interrupted（记录 `interruptedFrom`） |
| interrupted | recover：`interruptedFrom=reviewing` | awaiting-visibility（新 worker，确认后 continue） |
| interrupted | recover：`interruptedFrom=changes-required` | changes-required（不发 turn、不加轮） |
| interrupted | recover：`interruptedFrom=awaiting-visibility` | awaiting-visibility |

`REVIEW_STATES = ['awaiting-visibility','reviewing','changes-required','deadlock','approved','rejected','cancelled','interrupted','failed']`

### 4.3 启动、可见性与完成判定

**两阶段启动**（`start` / `respond` / `recover` 共用）

1. 空 worker：`tier:'consult'`、`kind:'review'`、`risk:'high'`、`model:'auto'`、`effort:'high'`、`mcp:'none'`，**不带 prompt**。
2. 轮询到 `threadId` → `open-codex-thread.ps1 -ThreadId "<threadId>"` 打开线程。
3. 状态停在 `awaiting-visibility`，**绝不发 turn**；`continueReview({confirmVisibility:true})` 后只发一次。
4. 重复 `continue` 不重发 turn；`continueReview` 只接受 `awaiting-visibility`，`interrupted` 一律走 `recover`。

**完成判定**（`result` 与 `reconcile` 共用 `processTurn`）

- 按当前 generation 的 `lastTurn.status` 判定完成/失败，**不看** `worker.status`（两阶段 turn 完成后 `worker.status` 仍是 `running`）。
- 用 `workerId:turnId` 去重，并绑定 `round`/`generation`。
- 处理后 `workers.close` 释放 consult 容量。
- `close` 返回 orphan 或失败 → 记 `cleanup:'orphan'`，不得宣称容量已释放。

**worker 状态映射**

| worker.status | stopReason | lastTurn.status | review 状态 |
|---|---|---|---|
| running | null | completed | 处理 verdict |
| running | null | failed | failed |
| stopped | closed/human_stop | running/completed | interrupted（已完成则先处理） |
| failed | * | * | failed |
| orphan | exit-unconfirmed | * | interrupted，保留 lease，`cleanup:'orphan'` |
| starting | * | * | 超时后 interrupted/failed |

### 4.4 回应、并发、幂等与 actor

**回应形状**

- `{type:'issue', issueId, decision:'accept'|'reject', evidence?, planChange?}`
- `{type:'question', questionId:'Qn', answer}`

约束：

- `issueId` 匹配 `/^[A-Za-z0-9_-]{1,20}$/` 且禁止 `/^Q\d+$/`；`questionId` 必须是 `/^Q\d+$/`；`parseVerdict` 同样拒绝 Q 编号的 issue。
- `respond` 必须覆盖当前轮**全部** blocker/major 与 questions；未知/重复/旧轮引用拒绝。
- `accept` 至少给 `planChange` 或 `evidence`；`reject` 至少给 `evidence`；question 必须给非空 `answer`。
- `respond` 重新读计划并更新本轮快照/hash；发送**完整当前计划** + 约束 + 历史摘要（不只未解决项）。

**并发与幂等**

- 所有状态迁移走 per-review 队列 + 全局 start 锁。
- `requestId` 持久化；同 id 不同 payload 拒绝；同 id 同 payload 只推进一轮。
- 幂等查找键：`(projectId, planPath, inputHash)`。

**actor**

- 记录 `createdBySessionId` 与 `currentActorSessionId`。
- `result` / `respond` / `decide` / `recover` 统一按 current actor 授权；旧 actor 拒绝。
- 同项目新 Claude 会话可 `recover({takeover:true})` 原子接管；跨项目不允许。

**重启与轮数**

- `changes-required` 恢复：保持 `changes-required`，不发 turn、不加轮，等合法 `respond`。
- `reviewing` 恢复：启动替代 worker → 新 `threadId` → `awaiting-visibility`。
- `round` / `deadline` / `finalRoundUsed` 均不重置；重复 `decide` 拒绝。

### 4.5 预算、模型与证据

- 预算只保留 `wholeReviewMs`（默认 3600000）与 `turnMs`（默认 600000）；超过 → `failed`，`error` 以 `timeout:` 开头。
- 不设 token/USD 硬上限（Stage 2）。
- 模型：`model:'auto' + kind:'review' + risk:'high'` → `model-policy.mjs` 选 `gpt-6.1-sol`；死锁后的最后一次人工加轮用 `gpt-6-astra`。
- 证据：每次终态写 `.sibyl/reviews/<reviewId>.json`，含
  `rounds:[{round,planHash,planSnapshot,verdict,issues,responses,rawVerdict}]`；
  失败也写；`artifactError` 暴露在 publicReview；写失败不改变评审状态。
- 持久化：`workspace.mjs` 的 meta 键 `planReviews` 与 `planApprovals`；保留所有非终态 + 当前有效批准 + 最近 100 条其它终态；`planApprovals` 索引按 `projectId:planPath` 不受淘汰影响。

### 4.6 HTTP / MCP / hooks 协议

**HTTP（`native-inbox.mjs`）**

- 所有请求带 `protocol:'plan-review/v1'`；不一致返回 400 `{error}`。
- `/plan-review/check`：token-only，在 `own(body)` **之前**分流；`{projectPath,filePath?,mode?}` → `{block,mode:'ask'|'deny'|'warn',reason,plans}`。
- Session lease：`/start`（202）、`/result`、`/respond`、`/decide`（`choice` 只接受 `1`/`0`）、`/continue`、`/recover`、`/list`。
- 校验：`planPath <=1024`；`reviewId` 为合法 UUID；`waitMs 0..25000`；`responses` 1..20 条；`evidence`/`planChange`/`answer` <=2000；`Buffer.byteLength(JSON.stringify(responses)) <= 12000`。

**MCP（`native-mcp.mjs`）**：`bridge_plan_review` / `_result` / `_respond` / `_decide` / `_continue` / `_recover` / `_list`，共 7 个；`responses` 用 JSON 字符串，解析后按字节校验。

**hooks（`scripts/sibyl-hook.mjs --dir <dataDir> --event stop|pre-tool`）**

- Stop：`{decision:'block',reason}` / `{}`；`stop_hook_active` → `{}`；daemon 不在/超时 → `{}`。
- PreToolUse：只处理 `Write`/`Edit`/`MultiEdit`；返回
  `{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny'|'ask',permissionDecisionReason}}` 或 `{}`；
  无 state 默认 `ask`；`irreversible` → `deny`；`warn` 模式 → `{}`。
- 所有 hook fail-open；协议不一致 → 合法 JSON `{}` + `notice` 字段，不拼接文本。
- 1.5s 超时；只允许 `127.0.0.1`/http。

### 4.7 配置合并（`native-config.mjs`）

- 写 `.claude/settings.local.json` 的 `hooks.Stop`、`hooks.PreToolUse`；叶子级合并，保留其他 hooks/matcher。
- 以 `node 路径 + 脚本路径 + resolve(dataDir) + --event <name>` 精确识别受管叶子：零匹配插入、一匹配更新、多匹配**拒绝并报错**（fail-closed，不猜）。
- 先校验全部目标文件再写；备份一次且不覆盖；非法 JSON 原样保留。
- PreToolUse matcher 用 `Write|Edit|MultiEdit`；未知事件返回 `{}`。

---

## 5. Global Constraints

- Node.js >= 26；零第三方 npm 依赖；测试只能用 Node 26：
  `"/d/LXY_workspace/AI Bridge/.tools/node26/node-v26.13.0-win-x64/node.exe" --test --test-concurrency=1 --test-timeout=30000 *.test.mjs`
- 只在 `feat/windows-support` 的扁平布局上改；不碰 `develop`；不引入 `src/`。
- 每个任务独立提交；不 push，除非人明确要求。
- 与 Codex 的讨论必须可见；按 CLAUDE.md 的顺序：`bridge_worker_start({tool:'codex',tier:'consult'})`（不带 prompt）→ 轮询 `bridge_worker_result` 直到拿到 `threadId` → `open-codex-thread.ps1 -ThreadId "<threadId>"` → 再 `bridge_worker_turn`。深链打不开时按 CLAUDE.md 的说明处理，不反复重试。
- 角色分工：Claude 出计划、协商、分配任务并验收；Codex 评审计划并执行任务。
- 评审输入 hash 只含 `change` 声明 + 正文；`review` 状态是结果，不参与 hash。
- `## Codex review` 只写在 `<!-- SIBYL_REVIEW_BEGIN -->` / `<!-- SIBYL_REVIEW_END -->` 之间；没有标记时不删用户正文。
- 所有新模块导出纯函数；服务通过参数注入 `store`、`workers`、`now`、`onChange`。

## 6. Review Focus 与测试映射

- 无/坏 frontmatter：不能误触发；曾被管理的计划声明损坏时 Stop hook 仍要阻止。
- `review:not-required` 但 scope/concurrency/irreversible/规模是结构性：必须升级为 required。
- 批准写回后 hash 不变；正文或 `change` 变化必须重审。
- Codex 返回多块/非 JSON/approve 带 blocker/重复 issue ID：判失败并保留原文。
- 3 轮后仍不通过：进入 `deadlock`，不再自动加轮。
- 并发 `result`/`respond`：不能重复加轮或重复批准。
- daemon 重启：运行中评审变 `interrupted`，`recover` 可继续。
- Stop hook：daemon 不在/超时 → fail-open；`stop_hook_active` → 不再阻止。
- 评审 worker：只读、无 worktree、无 ai-bridge MCP。

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

## 7. 任务（已执行）

### 执行前置（已完成）

- [x] `git branch --show-current` 为 `feat/windows-support`。
- [x] 从 `D:\LXY_workspace\AI Bridge\Sibyl` 重启 daemon：`node control.mjs "D:\LXY_workspace\AI Bridge\data"`，确认 `/worker/start` 可用。
- [x] 从 `Sibyl` 启动 Claude Code / MCP，工具列表里有 `bridge_worker_*`。
- [x] 全量测试 0 fail。
- [x] 本计划经人确认后按 CLAUDE.md「大计划先评审」做过 Codex 评审（见 §8）。

### Task 1: 声明、稳定 hash、判断与协议

**Files:**
- Create: `plan-review-policy.mjs`
- Test: `plan-review-policy.test.mjs`

**Interfaces:**
- Produces:
  - `PLAN_REVIEW_OPEN = '<<<SIBYL_REVIEW'`，`PLAN_REVIEW_CLOSE = 'SIBYL_REVIEW>>>'`
  - `REVIEW_BEGIN = '<!-- SIBYL_REVIEW_BEGIN -->'`，`REVIEW_END = '<!-- SIBYL_REVIEW_END -->'`
  - `REVIEW_STATES`（见 §4.2）
  - `DEFAULT_PLAN_REVIEW = {protocolVersion:'plan-review/v1',maxRounds:3,wholeReviewMs:3600000,turnMs:600000,maxPlanBytes:204800,maxIssues:20,maxFocusItems:20,maxResponsesBytes:12000,reviewerModel:'auto',reviewerFinalModel:'gpt-6-astra',reviewerEffort:'high'}`
  - `parsePlanDeclaration(text) -> {review, change, body, focus, inputHash, errors}`
  - `parseFocus(body) -> [{id:'F1',text}]`
  - `planInputHash(change, body) -> string`
  - `isStructural(parsed) -> {required, reasons}`
  - `stripGeneratedReview(text) -> string`
  - `findPlanFiles(projectPath) -> Promise<string[]>`
  - `parseVerdict(text, {focus}) -> {ok, verdict?, error?}`
  - `buildReviewPrompt(input)`，`buildResponsePrompt(input)`
  - `writeCodexReviewSection(text, input) -> string`

- [x] **Step 1: 写失败测试**

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

补充测试（R6/R7/R19）：

- hash：CRLF/LF、BOM、不同末尾换行、重复写回、Markdown 代码块内空白变化。
- 生成块：代码围栏内的标记、正文引用、多对标记、缺失结束标记、用户手写同名标题。
- verdict：approve 带 blocker、重复 issue ID、issue ID 为 `Q1` 与 questions 冲突。

- [x] **Step 2: 运行测试确认失败**

Run: `node --test plan-review-policy.test.mjs`
Expected: FAIL with `Cannot find module './plan-review-policy.mjs'`

- [x] **Step 3: 实现**

- `planInputHash`：按 §4.1 的 `hashVersion:1` canonical 算法；测试文件固定输入与期望摘要。
- `stripGeneratedReview` / `writeCodexReviewSection` / `parsePlanDeclaration` 共用同一扫描器（§4.1）；无标记时在文末追加生成块，不改用户正文。
- `writeCodexReviewSection` 插入标记、更新 `review:`、保留用户正文。
- `parseVerdict`：恰好一个 sentinel 块；issue ID 唯一且符合 §4.4 规则；severity 合法；`approve` 不能带 blocker/major；`changes-required` 至少一个 blocker/major；`discuss` 有 questions 或 issues；questions 转 `{id:'Q1',text}`。
- `parseFocus(body)`：解析 `## Review Focus` 下的 `- ` 条目，最多 `maxFocusItems`；无则空数组。
- `parseVerdict(text,{focus})`：focus 只用于提示和展示；不强制覆盖；结构计划没有 focus 时允许 approve，但 summary 提示缺少评审重点。
- `normalizeReviewConfig`：只接受白名单字段（时间、规模上限、模型/effort）；`protocolVersion` 固定 `plan-review/v1`；不含 token/USD。
- `findPlanFiles`：`docs/superpowers/plans/**/*.md` + 根 `*.plan.md`，跳过 `.sibyl` 和符号链接。
- `buildReviewPrompt`：只读、对抗性、引用段落、输出 sentinel JSON、不得改文件；带计划正文、change 声明、项目根、相关文件/当前 diff、上一轮结论。
- `buildResponsePrompt`：发送完整当前计划、约束和历史上下文。

- [x] **Step 4: 运行测试确认通过**

Run: `node --test plan-review-policy.test.mjs`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add plan-review-policy.mjs plan-review-policy.test.mjs
git commit -m "feat(plan-review): add declaration, stable hash and verdict policy"
```

### Task 2: 评审服务与持久化

**Files:**
- Create: `plan-review.mjs`
- Create: `plan-review-test-support.mjs`
- Modify: `workspace.mjs`
- Test: `plan-review.test.mjs`，`workspace.test.mjs`

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

状态机见 §4.2，完成判定与 worker 映射见 §4.3。

- [x] **Step 1: 写失败测试**

`plan-review-test-support.mjs` 提供：
- `reviewFixture({verdicts, clock, focus})`：临时项目/计划、状态化 fake workers（`start/turn/result/close`），同一 turn 重复读返回同一结果；`setVerdicts`、`advance(ms)`、`waitStatus`。
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

补充测试（R8/R10/R11/R12/R16/R19）：

- 两个连续 worker 都返回 `lastTurn.id=1`，`result` 与 `reconcile` 都能处理第二次。
- `result`/`reconcile`/`respond`/`decide` 交错，状态只迁移一次；同 requestId 不同 payload 拒绝。
- 同项目新 session `takeover` 成功；跨项目拒绝；旧 actor 的 result/respond 被拒。
- 第 4 轮仍失败、重复 `decide`、多次重启都不绕过轮数/时长上限。
- 101 条历史后仍能查到当前批准；正文或 hash 变化后需重审；计划删除后批准失效。
- `respond` 漏答 blocker/major/question、重复/未知/旧轮 issueId 被拒。

- [x] **Step 2: 运行测试确认失败**

Run: `node --test plan-review.test.mjs`
Expected: FAIL

- [x] **Step 3: 实现**

- `workspace.mjs`：meta 键 `planReviews`/`planApprovals` 与读写方法；保留策略见 §4.5；重启把 `reviewing|changes-required|awaiting-visibility` 改 `interrupted`。
- `start`：`readPlan`（realpath 在项目内、普通文件、<=maxPlanBytes）；`session.tool==='claude'`；队列与锁、幂等查找、actor 记录、两阶段启动（§4.3）。
- `result`：按 current actor 校验；`workers.result`；完成后 `parseVerdict`；`workerId:turnId` 去重。
- `continueReview`：只允许 `awaiting-visibility`；只发一次 turn；重复调用不重发；与 `resume()` 分开。
- `respond`：按 §4.4 校验、覆盖、快照、完整计划发送、round++。
- `finalizeApproved`：写 `## Codex review` 前重新读计划核对 `planHash`；不一致 → `changes-required`，不覆盖；成功后写 `planApprovals`。
- `reconcile`：30 秒定时器；只扫 `reviewing` 且有 `workerId` 的记录；按 §4.3 判定与映射；`close()` 清定时器。
- `writeArtifact`：按 §4.5 写每轮不可变快照。
- `budget`：按 §4.5；超时 → `failed`。
- `deadlock` / `decide`：`finalRoundUsed` 持久化；最后加轮只能一次；`1` → reviewing，`0` → cancelled；不产生 `waived`；重复 decide 拒绝。
- `recover`：按 `interruptedFrom` 三分支（§4.2）；`takeover` 原子更新 actor；轮数/deadline/`finalRoundUsed` 不重置。
- `check`：token-only；磁盘候选 ∪ 已管理路径；按 `(hashVersion,inputHash)` 查 `planApprovals`；未批准结构计划 → `{block:true,mode:'ask'|'deny',reason}`；受管理文件坏声明 → block。
- `close`：清队列/定时器；不关闭 worker 服务。

- [x] **Step 4: 运行测试**

Run: `node --test plan-review.test.mjs plan-review-policy.test.mjs workspace.test.mjs`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add plan-review.mjs plan-review-test-support.mjs workspace.mjs plan-review.test.mjs workspace.test.mjs
git commit -m "feat(plan-review): add the core review service"
```

### Task 3: `--mcp none` 与只读评审 worker

**Files:**
- Modify: `scripts/spawn-codex-chat.mjs`
- Modify: `workers.mjs`
- Modify: `worker-test-support.mjs`
- Test: `review-worker.test.mjs`

**Interfaces:**
- `workers.start({...,mcp:'none'|'full'})`；默认 `full`。
- `spawn-codex-chat.mjs --mcp none`：`mcp_servers:{}`，不注入 ai-bridge。
- 评审用 `tier:'consult'`（现有只读、可见、单轮 worker）；不新增 tier；不改 `checkWorkerCapacity`。

- [x] **Step 1: 写失败测试**

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

- [x] **Step 2: 运行测试确认失败**

Run: `node --test review-worker.test.mjs`
Expected: FAIL

- [x] **Step 3: 实现**

- `scripts/spawn-codex-chat.mjs`：新增 `--mcp`；`none` 时 `mcp_servers:{}`；默认 `full` 保持现有行为。
- `workers.mjs`：`start` 接受 `mcp`；`spawnChild` 传 `--mcp`。
- `worker-test-support.mjs`：fake script 写 `args.json`；新增 `reviewWorkerFixture`。

- [x] **Step 4: 运行测试**

Run: `node --test review-worker.test.mjs tiers.test.mjs`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add scripts/spawn-codex-chat.mjs workers.mjs worker-test-support.mjs review-worker.test.mjs
git commit -m "feat(worker): allow a review worker without the ai-bridge MCP"
```

### Task 4: 本地 HTTP 端点与 MCP 工具

**Files:**
- Modify: `native-inbox.mjs`
- Modify: `native-mcp.mjs`
- Modify: `control.mjs`（只加 `planReview` 透传）
- Test: `plan-review-api.test.mjs`，`plan-review-tool.test.mjs`

接口、校验与工具清单见 §4.6。

- [x] **Step 1: 写失败测试**

- `tools/list` 含七个工具（`bridge_plan_review`、`_result`、`_respond`、`_decide`、`_continue`、`_recover`、`_list`）。
- `/respond` 缺 evidence、非法 UUID、超字节预算分别报错。
- `createControl` 透传 `planReview`。

- [x] **Step 2: 运行测试确认失败**

Run: `node --test plan-review-api.test.mjs plan-review-tool.test.mjs`
Expected: FAIL

- [x] **Step 3: 实现**

- 按 §4.6 加端点/工具；复用现有 `own(body)` 租约；`/check` 在 `own(body)` 之前分流。
- 失败路径返回现有 `send(400,{error})`；MCP 错误返回 `isError`。

- [x] **Step 4: 运行测试**

Run: `node --test plan-review-api.test.mjs plan-review-tool.test.mjs native-inbox.test.mjs native-mcp.test.mjs`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add native-inbox.mjs native-mcp.mjs control.mjs plan-review-api.test.mjs plan-review-tool.test.mjs
git commit -m "feat(plan-review): add core HTTP endpoints and MCP tools"
```

### Task 5: Claude Code hooks（Stop / PreToolUse）

**Files:**
- Create: `scripts/sibyl-hook.mjs`
- Modify: `native-config.mjs`
- Test: `sibyl-hook.test.mjs`，`native-config.test.mjs`

接口见 §4.6，配置合并见 §4.7。

- [x] **Step 1: 写失败测试**

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

- [x] **Step 2: 运行测试确认失败**

Run: `node --test sibyl-hook.test.mjs native-config.test.mjs`
Expected: FAIL

- [x] **Step 3: 实现**

- hook 脚本：只在直接执行时读 stdin；导出 async `decideStop`/`decidePreTool`；runtime 校验 127.0.0.1/http；1.5s 超时；错误输出 `{}`；所有请求带 `protocol`。
- `configureClaudeHooks`：按 §4.7 精确识别受管叶子，fail-closed 合并。
- PreToolUse matcher 用 `Write|Edit|MultiEdit`；只在 `hookSpecificOutput` 形状下输出；未知事件返回 `{}`。
- 协议不一致返回合法 JSON `{}` 并带 `notice` 字段，不在 `{}` 后拼接文本。
- 进程级测试：真实 stdin/stdout/退出码；stop/pre-tool；deny/allow/超时；用户已有 hook 共存；Windows 空格路径。

- [x] **Step 4: 运行测试**

Run: `node --test sibyl-hook.test.mjs native-config.test.mjs`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add scripts/sibyl-hook.mjs native-config.mjs sibyl-hook.test.mjs native-config.test.mjs
git commit -m "feat(hooks): block unreviewed structural plans at Stop"
```

### Task 6: daemon 接线、状态、文档与端到端

**Files:**
- Modify: `control.mjs`
- Modify: `CLAUDE.md`
- Modify: `skills/agents-calling/SKILL.md`
- Modify: `使用说明.md`
- Modify: `README.md`
- Test: `control-v3.test.mjs`，`plan-review-e2e.test.mjs`

**Interfaces:**
- `createControl` 新增 `planReviewConfig`；创建 `planReviews`；传 `planReview` 给 inbox。
- `state()` 新增 `planReviews`。
- `close()` 先 `planReviews.close()`，再 `workers.closeAll()`。

- [x] **Step 1: 写失败测试**

- `/api/status` 有 `planReviews`。
- fake consult worker 走完整回路：start → result → changes-required → respond → approved。
- `close()` 清队列/定时器。
- 全量测试 0 fail。

- [x] **Step 2: 运行测试确认失败**

Run: `node --test control-v3.test.mjs plan-review-e2e.test.mjs`
Expected: FAIL

- [x] **Step 3: 实现**

- `control.mjs` 接线、state、close。
- `CLAUDE.md`/`SKILL.md`/`使用说明.md`/`README.md` 更新流程与 Phase 2 清单。
- 文档写明 §3 的边界：有 Stop + PreToolUse（提醒/ask/deny，不保证覆盖 Bash/git/worker 写入）；无微信、无 daemon gate、无 UserPromptSubmit；每轮新线程；占 consult 容量；不设 USD 硬上限。

- [x] **Step 4: 运行全量测试**

Run:
`"/d/LXY_workspace/AI Bridge/.tools/node26/node-v26.13.0-win-x64/node.exe" --test --test-concurrency=1 --test-timeout=30000 *.test.mjs`
Expected: 0 fail（允许既有 skip）。

- [x] **Step 5: 提交**

```bash
git add control.mjs CLAUDE.md skills/agents-calling/SKILL.md 使用说明.md README.md control-v3.test.mjs plan-review-e2e.test.mjs
git commit -m "feat(plan-review): wire the core review loop into the daemon"
```

---

## 8. Codex 评审记录

模型：`gpt-6.1-sol`（effort high），只读 consult worker。5 轮后 `approve`。

| 轮次 | Verdict | 问题 | 收敛为 |
|---|---|---|---|
| 1 | `changes-required` | 1 blocker + 19 major/minor：Stop/PreToolUse 无法保证「批准后才写」、两阶段可见启动缺失、执行方可自批 `waived`、hooks/inbox 契约未闭合、强制 Focus 覆盖会误杀、hash/生成块规范不足、`lastProcessedTurnId` 跨 worker 冲突、状态迁移竞态、轮数不是封闭状态机、USD 无计量来源、worker 异常未映射、100 条淘汰会删有效批准、hook 去重未隔离、`respond` 未强制覆盖 | Rev 2 |
| 2 | `changes-required` | 5 major + 3 minor：可见性未确认仍发 turn、canonical 缺默认值/向量、`changes-required` 恢复会绕过待回应、按 `worker.status` 判定完成会卡住、questions 无回应形状、扫描逻辑不统一、takeover actor 职责不清、旧文案残留 | Rev 3 |
| 3 | `changes-required` | 2 major + 4 minor：`awaiting-visibility` 无继续入口且缺状态、canonical 缺逐字段默认值/类型处理/hashVersion 查询规则、重启测试与规范相反、异常映射未逐项、issue 回应缺 `type`、`choice=2` 等残留 | Rev 4 |
| 4 | `changes-required` | 1 major + 1 minor：`continueReview` 与 `recover` 分支冲突、替代 worker 未确认可见就发 turn、旧文案与设计引用未更新 | Rev 5 |
| 5 | **`approve`** | 无 blocker/major；1 minor：恢复测试复用 fake，累计 `turnCount` 断言可能误报 | 改为基线计数断言 |

**采纳要点**：核心版收缩为「提醒 + 尽力拦截」；两阶段启动与可见性门禁；`hashVersion:1` 固定向量；共享生成块扫描器；`workerId:turnId` 去重；per-review 队列 + 全局 start 锁；同项目 takeover；`finalRoundUsed`；每轮不可变快照；`planApprovals` 索引；精确 hook 所有权；`respond` 覆盖校验；question 回应形状。

**未采纳/后置（Stage 2）**：daemon gate、persistent 同线程、微信、独立 review tier、强制 Focus coverage、USD 计量、Bash/git 写入硬拦。

## 9. Phase 2（不在本计划）

- 微信死锁通知/回复与高水位/增量导出。
- daemon 写门禁（worker-start/finalize/accept）；PreToolUse 已在核心版。
- 高风险不可逆操作的人批与 waiver 语义。
- 独立 `review` tier、persistent 同线程多轮、watchdog pause。
- 动作日志、崩溃精确重放、多计划批准绑定、可达性保留策略。
- 运行台可视化、本地模型第二意见、ACP `session/load`。
