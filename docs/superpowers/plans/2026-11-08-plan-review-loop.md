# Plan Review Loop Implementation Plan (Revision 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当 Claude 产出或修改一份结构性的实施计划时，自动让 Codex 在可见会话里评审；执行方逐条回应；卡住时发微信让人裁决；通过后才允许写代码。

**Architecture:** 复用 Phase B 的 daemon、worker 服务和 SQLite。新增只读、可持久多轮的 `review` worker tier（禁用 ai-bridge MCP）；一个 daemon 持有的 `plan-review` 服务（动作日志、watcher、状态机、接管、gate）；一个微信决策通道（发送走 Hermes，接收走远端过滤的 `hermes sessions export`）；以及 Claude Code 的 `Stop` / `PreToolUse` hooks。评审与决策存入现有 `meta` 表，不升 schema 版本。

**Tech Stack:** Node.js >= 26，零第三方依赖；`node:sqlite`；MCP stdio；Claude Code hooks；SSH + Hermes `send` / `sessions export`。

**Spec:** `docs/superpowers/specs/2026-11-08-plan-review-loop-design.md`

## Global Constraints

- Node.js >= 26；零第三方 npm 依赖；测试只能用 Node 26：
  `"/d/LXY_workspace/AI Bridge/.tools/node26/node-v26.13.0-win-x64/node.exe" --test --test-concurrency=1 --test-timeout=30000 *.test.mjs`
- 只在 `feat/windows-support` 的扁平布局上改；不碰 `develop`；不引入 `src/`。
- 每个任务独立提交；不 push，除非人明确要求。
- 与 Codex 的讨论必须从任务一开始可见；新建 Codex 会话后先运行聚焦脚本（见 Task 11）。
- 微信发送只走 `scripts/notify-wechat.mjs`；`.notify.json`、token、聊天 ID 不进仓库。
- 角色分工：Claude 出计划、协商、分配任务并验收；Codex 评审计划并执行任务。
- **评审输入 = `change` 声明 + 计划正文；`review` 状态是结果，不参与 hash。** `## Codex review` 只写在显式标记区内，不参与 hash。
- **不可逆定义**：只包括高风险操作（删除、数据迁移、部署、force push）。普通 git 提交/建分支不算 `irreversible`，只需 Codex 批准。
- **人工裁决**：死锁 `1` = 按 Codex 意见修改后复审（最后一轮）；`2` = 采纳执行方并记豁免；`0` = 取消计划。高风险 approval：`1` = 批准，`2` = 拒绝，`0` = 取消。
- 所有 daemon 写副作用（worker 启动、worktree 提交、accept）必须经过 gate；Claude Bash 走 PreToolUse；daemon 不可用时 PreToolUse fail-open，这是明确接受的边界。
- 所有新模块导出纯函数；服务通过参数注入 `store`、`workers`、`decisionChannel`、`now`、`onChange`、`focusThread`、`gate`。

## Review Focus

- 计划没有 frontmatter / frontmatter 损坏：不能误触发，也不能静默放行已声明 `required` 或曾被管理的计划。
- `review: not-required` 但 `scope`/`concurrency`/`irreversible`/规模实际是结构性：必须升级为 required。
- 批准写回后 `planInputHash` 必须不变；正文或 `change` 声明变化必须变化。
- Codex 返回散文、多个 JSON 块、缺字段、severity 非法、approve 带 blocker、issue ID 重复：必须判失败并保留原文。
- 执行方对每个 blocker 都 reject：3 轮后进死锁；人工裁决后最多一轮；再次失败必须进入确定终态。
- 微信回复来自错误 chat、旧 message_id、错误编号、迟到、只回 `1`：必须忽略；先判过期再匹配；远端只传 cursor 之后的数据。
- daemon 重启时评审 worker 已死、decision 未回答：decision 保留；动作日志可重放；回答后用新 worker 恢复。
- 两个 `result`/`respond`/poll 并发：不能重复批准、重复加轮、重复消费同一 turn/message。
- 超过 100 条历史后，最新批准、待决 decision、被人工保留的记录不能被裁剪。
- review worker 不能通过 ai-bridge MCP 创建写 worker；daemon 必须验证不可伪造的 reviewer 能力。
- 多计划并存时，一次写操作必须被所有相关计划的当前版本批准覆盖。
- `timed-out`/`failed`/`cancelled` 后必须有明确的恢复/重开入口，不能永久卡在 awaiting。

### Review Focus → 测试映射

| 关注点 | 测试 |
|---|---|
| hash 写回稳定 / 声明变化重审 | `plan-review-policy.test.mjs`：`hash excludes review status and includes change` |
| 无/坏 frontmatter、受管理文件损坏 | `plan-review.test.mjs`：`check blocks malformed managed plans` |
| verdict 多块/矛盾/重复 ID | `plan-review-policy.test.mjs`：`rejects ambiguous verdicts` |
| 3 轮死锁 + 人工后终态 | `plan-review.test.mjs`：`human rounds terminate` |
| 微信错误 chat/旧消息/迟到/大批历史 | `decision-channel.test.mjs`：`remote filter and freshness` |
| 动作日志崩溃重放 | `workspace.test.mjs` / `plan-review.test.mjs`：`replays pending actions` |
| 并发幂等 | `plan-review.test.mjs`：`concurrent result and respond are idempotent` |
| 多计划/未启动/批准后修改 gate | `plan-review-gate.test.mjs`：`gate binds every irreversible plan` |
| review worker 无写能力 | `review-tier.test.mjs`：`review worker starts with no ai-bridge MCP` |
| hook fail-open / 特殊路径 | `sibyl-hook.test.mjs` / `native-config.test.mjs` |
| 保留策略 | `workspace.test.mjs`：`retention keeps roots and trims groups` |
| 可选微信配置 | `control-v3.test.mjs`：`starts without notify config` |

---

## Before you start

- [ ] 确认 `git branch --show-current` 是 `feat/windows-support`，工作区除设计/计划文档外干净。
- [ ] **重启后台 daemon**：当前 `control.mjs` 是旧进程，没有 `/worker/start`。从 `D:\LXY_workspace\AI Bridge\Sibyl` 重新启动 `node control.mjs "D:\LXY_workspace\AI Bridge\data"`，确认 `/worker/start` 可用。
- [ ] 从 `D:\LXY_workspace\AI Bridge\Sibyl` 启动 Claude Code / MCP，确认工具列表里有 `bridge_worker_*`。
- [ ] 在云服务器给 Hermes 加规则：`SYBIL` 开头的微信消息只回复“已记录”，不执行其他动作。
- [ ] 确认 `.notify.json` 存在；缺失时 daemon 仍必须能启动。
- [ ] 跑一次全量测试，确认 0 fail。
- [ ] Revision 3 经第三轮 Codex 复审通过前，不执行任何任务。

---

### Task 1: 声明、输入 hash、状态枚举与协议

**Files:**
- Create: `plan-review-policy.mjs`
- Test: `plan-review-policy.test.mjs`

**Interfaces:**
- Produces:
  - `PLAN_REVIEW_OPEN = '<<<SIBYL_REVIEW'`，`PLAN_REVIEW_CLOSE = 'SIBYL_REVIEW>>>'`
  - `REVIEW_BEGIN = '<!-- SIBYL_REVIEW_BEGIN -->'`，`REVIEW_END = '<!-- SIBYL_REVIEW_END -->'`
  - `REVIEW_STATES = ['reviewing','changes-required','deadlock','awaiting-human','resuming','approving','awaiting-approval','approved','rejected','cancelled','timed-out','interrupted','failed','waived','recovery-required']`
  - `DECLARED_STATES = ['required','not-required','approved','provisional','waived','rejected','cancelled']`
  - `DEFAULT_PLAN_REVIEW = {maxRounds:3,maxHumanRounds:1,decisionTimeoutMs:1800000,wholeReviewMs:3600000,turnMs:600000,pollMs:5000,maxPlanBytes:204800,maxIssues:20,maxResponsesBytes:12000,reviewerModel:'gpt-6-astra',reviewerEffort:'high'}`
  - `parsePlanDeclaration(text) -> {review, change, body, inputHash, errors}`
  - `planInputHash(change, body) -> string`
  - `isStructural(parsed) -> {required, reasons}`
  - `stripGeneratedReview(text) -> string`
  - `findPlanFiles(projectPath) -> Promise<string[]>`
  - `parseVerdict(text) -> {ok, verdict?, error?}`（questions 自动编号 `Q1..Qn`）
  - `buildReviewPrompt(input)`, `buildReviewResponsePrompt(input)`, `buildResumePrompt(input)`
  - `writeCodexReviewSection(text, input) -> string`
  - `buildDecisionMessage({kind,code,question,optionA,optionB,reasonA,reasonB,recommendation}) -> string`
  - `parseDecisionReply(text) -> {code, choice} | null`（choice `1|2|0`）
  - `isHighRiskCommand(command) -> {highRisk, reason}`

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEW_STATES, parsePlanDeclaration, planInputHash, isStructural,
  parseVerdict, writeCodexReviewSection, parseDecisionReply, isHighRiskCommand
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
  const parsed = parsePlanDeclaration(text);
  assert.equal(parsed.body.includes('user text'), true);
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

test('parses 1/2/0 replies and flags high-risk commands', () => {
  assert.deepEqual(parseDecisionReply('SYBIL D-7f3a2c 1'), {code:'D-7f3a2c', choice:'1'});
  assert.deepEqual(parseDecisionReply('SYBIL A-7f3a2c 0'), {code:'A-7f3a2c', choice:'0'});
  assert.equal(parseDecisionReply('1'), null);
  assert.equal(isHighRiskCommand('git push origin main').highRisk, false);
  assert.equal(isHighRiskCommand('rm -rf build').highRisk, true);
  assert.equal(isHighRiskCommand('git push --force origin main').highRisk, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test plan-review-policy.test.mjs`
Expected: FAIL with `Cannot find module './plan-review-policy.mjs'`

- [ ] **Step 3: 实现**

- `planInputHash` 只接受 `change`（`scope` 排序后 + `concurrency` + `irreversible` + `tasks` + `files`）和 `stripGeneratedReview(body)`；**不包含 `review`**。
- `stripGeneratedReview` 只删除 `<!-- SIBYL_REVIEW_BEGIN -->` 到 `<!-- SIBYL_REVIEW_END -->` 之间的内容；没有标记时不删任何用户正文。
- `writeCodexReviewSection` 第一次写入时插入两个标记；更新 `review:` 行；生成区不参与 hash。
- `parseVerdict`：恰好一个完整 sentinel 块；issue ID 唯一且 `/^[A-Za-z0-9_-]{1,20}$/`；severity `blocker|major|minor`；`approve` 不能带 blocker/major；`changes-required` 至少一个 blocker/major；`discuss` 必须有 questions 或 issues；questions 转成 `{id:'Q1', text}`。
- `parseDecisionReply` 接受 `1|2|0`。
- `isHighRiskCommand` 保守匹配设计 §4.1 的高风险命令。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test plan-review-policy.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add plan-review-policy.mjs plan-review-policy.test.mjs
git commit -m "feat(plan-review): add stable input hash and strict verdict policy"
```

---

### Task 2: 只读、持久多轮、无写能力的 `review` worker tier

**Files:**
- Modify: `consult-policy.mjs`
- Modify: `workers.mjs`
- Modify: `scripts/spawn-codex-chat.mjs`
- Modify: `worker-test-support.mjs`
- Test: `review-tier.test.mjs`, `consult-policy.test.mjs`

**Interfaces:**
- `workers.start({session, tool:'codex', tier:'review', persistent:true, instructions, mcp:'none', scope?:[], prompt?, model?, effort?})`
- `DEFAULT_WORKER_LIMITS.review = {maxDurationMs:3600000,noProgressMs:600000,windowMs:3600000,maxPerWindow:12,maxLivePerSession:2,maxLivePerProject:3}`
- `checkReviewCapacity(records, {sourceSessionId, projectPath, now, limits})`：只看 `tier==='review'`。
- `workers.start` 对 review：`scope=[]`，跳过 `normalizeScope`、共享文件/暂存/租约检查、`assertSupportedRepository`。
- `workers.waitForThread(workerId, timeoutMs)`：等待 `threadId`。
- `workers.pause({session, workerId})` / `workers.resume({session, workerId})`：调整 `watchdogPaused`，暂停时长不计入 watchdog。
- `publicWorker` 增加 `threadId`、`persistent`、`watchdogPaused`。
- `spawn-codex-chat.mjs --mcp none`：`mcp_servers:{}`，review worker 不能调用任何 ai-bridge 工具。

- [ ] **Step 1: 写失败测试**

```js
test('review worker is read-only, persistent, has no ai-bridge MCP and survives the lead session', async () => {
  const f=await reviewWorkerFixture();
  const started=await f.service.start({session:f.session,tool:'codex',tier:'review',persistent:true,instructions:'REVIEW',mcp:'none',prompt:'title turn'});
  const ready=await f.service.waitForThread(started.workerId,5000);
  assert.ok(ready.threadId);
  await f.service.turn({session:f.session,workerId:started.workerId,prompt:'review turn'});
  const first=await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:100});return r.turns===2?r:null;});
  assert.equal(first.worktreePath,null);
  assert.equal(first.branch,null);
  assert.equal(first.status,'running');
  const args=JSON.parse(await readFile(join(f.project,'args.json'),'utf8'));
  assert.ok(args.includes('--mcp'));
  assert.ok(args.includes('none'));
  assert.ok(args.includes('read-only'));
  assert.ok(args.includes('--instructions'));
});

test('a paused review worker is not stopped by the watchdog', async () => {
  // start, pause, advance clock past noProgressMs/total; assert still running; resume; close
});

test('a running review does not consume dispatch capacity', async () => {
  // one running review + one dispatch; assert dispatch is allowed
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test review-tier.test.mjs consult-policy.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

- `consult-policy.mjs`：增加 `review` 限额与 `checkReviewCapacity`；`checkWorkerCapacity` 保持原样。
- `workers.mjs`：
  - `readOnly = tier==='consult'||tier==='review'`；review 不建 worktree、不做共享/暂存/租约；`assertSupportedRepository` 仅对非 review 调用。
  - `persistent`：首轮完成后不 finalize；后续 `turn` 允许；`close`/超时才 finalize。
  - `instructions`/`mcp` 传给启动脚本；review 不使用 `WORKER_POLICY`/`buildDispatchPrompt`。
  - `waitForThread`、`pause`、`resume`；`watchdogPaused` 不计入 no-progress/total；`resume` 累加 `pausedTotalMs`。
  - `publicWorker` 返回 `threadId/persistent/watchdogPaused`。
  - 容量调用侧：非 review 先排除 `tier==='review'` 再调 `checkWorkerCapacity`；review 用 `checkReviewCapacity`。
  - orphan watchdog 跳过 review。
- `scripts/spawn-codex-chat.mjs`：`--mcp none|full`；review 传 `none`。
- `worker-test-support.mjs`：fake script 记录 `args.json`，支持 `review` 模式；新增 `reviewWorkerFixture`。

- [ ] **Step 4: 运行测试**

Run: `node --test review-tier.test.mjs consult-policy.test.mjs tiers.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add consult-policy.mjs workers.mjs scripts/spawn-codex-chat.mjs worker-test-support.mjs review-tier.test.mjs consult-policy.test.mjs
git commit -m "feat(worker): add an isolated persistent review tier"
```

---

### Task 3: 持久化、动作日志、原子决策与可达性裁剪

**Files:**
- Modify: `workspace.mjs`
- Test: `workspace.test.mjs`

**Interfaces:**
- meta keys：`planReviews`、`decisions`、`reviewActions`、`decisionPoll`。
- `listPlanReviews()` / `savePlanReview(record)`
- `listDecisions()` / `saveDecision(record)`
- `listReviewActions()` / `saveReviewAction(record)`
- `getDecisionPoll()` / `saveDecisionPoll({lastMessageId, chatId})`
- `commitDecision({decisionId, choice, messageId, reviewId, reviewStatus, reviewPatch, actions})`：一个事务内更新 decision、review、action 列表、poll cursor。
- `finishAction({actionId, stage, result})`：一个事务内更新 action；可附带 review 状态。
- 保留策略（可达性）：
  - 根 = 所有非终态 review + 每个 `projectId+planPath` 的最新 `approved|waived` + 所有 pending/awaiting decision 所属 review + 人工 pinned。
  - 只保留根 review 及其 decisions/actions；非根终态按 `createdAt` 最多 100 组裁剪，被裁剪组的 decision/action 一并裁剪。
  - 不保留“被任意 review 引用”的 decision，避免双向引用导致永不裁剪。
- On open：
  - `reviewing|changes-required|resuming|approving` → `interrupted`；`deadlock|awaiting-*` 保留。
  - `decisions` 未回答且过期 → `timed-out`；关联 review 若仍在 `awaiting-*` → 同步 `timed-out`。
  - `reviewActions` 中 `pending` 保留，启动后重放。

- [ ] **Step 1: 写失败测试**

```js
test('commitDecision writes decision, review, actions and cursor atomically', async () => {
  const dir=await mkdtemp(join(tmpdir(),'plan-review-store-')); const w=await openWorkspace(dir);
  w.savePlanReview({id:'r1',projectId:'p',planPath:'plans/demo.md',planHash:'h',status:'awaiting-human',createdAt:new Date().toISOString()});
  w.saveDecision({id:'d1',reviewId:'r1',kind:'deadlock',code:'D-1a2b3c',status:'pending',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});
  w.commitDecision({decisionId:'d1',choice:'1',messageId:7,reviewId:'r1',reviewStatus:'resuming',actions:[{id:'a1',reviewId:'r1',type:'start-resume-worker',stage:'pending'}]});
  assert.equal(w.listDecisions()[0].status,'answered');
  assert.equal(w.listPlanReviews()[0].status,'resuming');
  assert.equal(w.listReviewActions()[0].stage,'pending');
  assert.equal(w.getDecisionPoll().lastMessageId,7);
  w.close(); await rm(dir,{recursive:true,force:true});
});

test('retention keeps roots and trims old groups including their decisions', async () => {
  // 120 terminal review groups, each with one answered decision; one latest approved root
  // assert approved root survives; old groups trimmed; no mutual-reference growth
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test workspace.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

- 用现有 `transaction` 实现 `commitDecision`/`finishAction`；所有 key 一起写，失败回滚。
- 保留根计算见上；裁剪时按组删除 review + decisions + actions。
- 重启调和 decision/review 关联状态。
- 不新建表，不升 schema 版本。

- [ ] **Step 4: 运行测试**

Run: `node --test workspace.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add workspace.mjs workspace.test.mjs
git commit -m "feat(plan-review): add action log and reachability retention"
```

---

### Task 4: 评审服务核心（watcher、状态机、接管、动作重放）

**Files:**
- Create: `plan-review.mjs`
- Create: `plan-review-test-support.mjs`
- Test: `plan-review.test.mjs`

**Interfaces:**
- `createPlanReviewService({store,workers,decisionChannel,focusThread,onChange,now,config,chatId})`
- `start({session,planPath,model?,effort?}) -> publicReview`
- `result({session,reviewId,waitMs}) -> publicReview`
- `respond({session,reviewId,responses,planPath,expectedRound,requestId}) -> publicReview`
- `recover({session,reviewId}) -> publicReview`
- `decide({reviewId,choice,messageId}) -> publicReview`
- `list({session,all})`, `listDecisions()`
- `check({projectPath})`, `gate({projectPath,command})`, `gateWrite({projectPath,action})`
- `resume()`, `close()`
- publicReview：`{reviewId,projectId,projectPath,planPath,planHash,status,structural,declaration,round,humanRounds,maxRounds,maxHumanRounds,reviewer:{tool,workerId,model,effort,threadId},verdict,issues,questions,responses,decision,lastActorSessionId,focusError,error,rawVerdict,createdAt,updatedAt,approvedAt,deadlineAt}`

**显式状态机**

| 当前 | 事件 | 下一状态 |
|---|---|---|
| reviewing | approve + 无 irreversible | approving → approved（写动作完成后） |
| reviewing | approve + irreversible | awaiting-approval |
| reviewing | changes-required/discuss + round<max | changes-required |
| reviewing | changes-required/discuss + round>=max | deadlock → awaiting-human |
| reviewing | turn failed / worker exited | failed |
| changes-required | respond | reviewing |
| awaiting-human | 人 1 | resuming → reviewing（`humanRounds++`） |
| awaiting-human | 人 2 | waived（`waiver:'executor-position'`） |
| awaiting-human | 人 0 | cancelled |
| awaiting-approval | 人 1 | approving → approved |
| awaiting-approval | 人 2 | rejected |
| awaiting-approval | 人 0 | cancelled |
| awaiting-* | 超时 | timed-out |
| reviewing/changes-required | daemon 重启 | interrupted |
| interrupted/recovery-required | recover | reviewing（新 worker） |

**人工后终态**：`humanRounds > maxHumanRounds` 且仍 `changes-required` → `rejected`；不再回到 deadlock。

- [ ] **Step 1: 写失败测试**

`plan-review-test-support.mjs` 提供：
- `reviewFixture({verdicts,irreversible,replies,clock})`：临时项目/计划、状态化 fake workers（同一 turn 重复读返回同一结果）、可控时钟、fake decisionChannel、fake focusThread。
- `driveToDeadlock(f)`：首轮 + 2 次 respond + 3 个 changes verdict。
- `driveToApproval(f)`：approve + irreversible。

```js
test('approve writes the review section and preserves the input hash', async () => {
  const f=await reviewFixture({verdicts:[approveVerdict]});
  const started=await f.service.start({session:f.session,planPath:'docs/superpowers/plans/demo.md'});
  const done=await waitReview(f,started.reviewId,'approved');
  const text=await readFile(join(f.project,'docs/superpowers/plans/demo.md'),'utf8');
  assert.match(text,/review: approved/);
  assert.equal(parsePlanDeclaration(text).inputHash, started.planHash);
});

test('changes-required then respond uses the same worker, approves on round 2', async () => {
  const f=await reviewFixture({verdicts:[changesVerdict,approveVerdict]});
  const started=await f.service.start({session:f.session,planPath:'docs/superpowers/plans/demo.md'});
  assert.equal((await f.service.result({session:f.session,reviewId:started.reviewId,waitMs:0})).status,'changes-required');
  await f.service.respond({session:f.session,reviewId:started.reviewId,responses:[{issueId:'R1',decision:'accept',evidence:'已改'}],expectedRound:1,requestId:'req-1'});
  assert.equal((await waitReview(f,started.reviewId,'approved')).status,'approved');
  assert.equal(f.fake.turnCount,2);
});

test('three unresolved blockers deadlock; human 1 gets exactly one last round, then rejected', async () => {
  const f=await reviewFixture({verdicts:Array(5).fill(changesVerdict),replies:['1']});
  const started=await driveToDeadlock(f);
  f.setReply(`SYBIL ${started.decision.code} 1`);
  await f.service.pollDecisions();
  // respond with a still-failing verdict; assert final status rejected, not deadlock again
});

test('an unparseable verdict fails and keeps raw text', async () => {
  const f=await reviewFixture({verdicts:['not a verdict']});
  const started=await f.service.start({session:f.session,planPath:'docs/superpowers/plans/demo.md'});
  const done=await waitReview(f,started.reviewId,'failed');
  assert.match(done.error,/verdict/i);
  assert.match(done.rawVerdict,/not a verdict/);
});

test('a same-project session can take over and pause/close the review worker', async () => {
  const f=await reviewFixture({verdicts:[changesVerdict,approveVerdict]});
  const started=await f.service.start({session:f.session,planPath:'docs/superpowers/plans/demo.md'});
  await f.service.result({session:f.session,reviewId:started.reviewId,waitMs:0});
  const other={...f.session,id:'s2'};
  const taken=await f.service.takeover({session:other,reviewId:started.reviewId});
  assert.equal(taken.lastActorSessionId,'s2');
  await f.service.pause({session:other,reviewId:started.reviewId});
  await f.service.resume({session:other,reviewId:started.reviewId});
  await f.service.recover({session:other,reviewId:started.reviewId});
});

test('concurrent result/respond and repeated watcher turns are idempotent', async () => {
  // Promise.all result x2, respond x2 with same requestId; assert one turn, one approval
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test plan-review.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

- `start`：路径锁 + 幂等查找；`readPlan`（realpath/普通文件/大小）；`session.tool==='claude'`；短标题 turn → `waitForThread` → `focusThread` → 完整评审 turn；watcher。
- `respond`：per-review 队列；`expectedRound`；`requestId` 去重；重新 `readPlan`；更新 snapshot/hash；`workers.resume` + `turn`；round++。
- `watch`：保存 `lastProcessedTurnId`；重复 turn 跳过；`parseVerdict`；按状态机迁移；`finish()` 统一清理。
- `finalizeApproved`：写动作 `write-review-section`；动作完成前状态 `approving`；完成后 `approved`。
- `deadlock`：第一个未解决 blocker → 否则 major → 否则 question；decision kind `deadlock`；`awaiting-human`；`workers.pause`。
- `awaiting-approval`：decision kind `approval`；`workers.pause`。
- `decide`：`commitDecision` + actions；重放动作；失败 `recovery-required`。
- `recover`：先清理旧 worker（确认退出），再按动作/上下文启动新 worker；`humanRounds`/deadline 保留。
- `resume`：重启调和；重放 pending actions；恢复 poller；过期 decision 同步 review。
- `takeover`/`pause`/`resume`：同项目授权；记录 `lastActorSessionId`。
- `check`：候选 = 磁盘结构性计划 ∪ 已管理路径；损坏/无声明但要管理 → block；frontmatter `approved` 必须有 DB 记录匹配 hash。
- `close`：拒绝新操作；等待所有在途 start/respond/watch/poll/send/focus；再关 worker。

- [ ] **Step 4: 运行测试**

Run: `node --test plan-review.test.mjs plan-review-policy.test.mjs workspace.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add plan-review.mjs plan-review-test-support.mjs plan-review.test.mjs
git commit -m "feat(plan-review): add watcher, state machine, takeover and action replay"
```

---

### Task 5: 微信决策通道（远端过滤、新鲜度、发送状态）

**Files:**
- Create: `decision-channel.mjs`
- Test: `decision-channel.test.mjs`

**Interfaces:**
- `chatIdFromTarget(target) -> string`
- `buildExportCommand({hermes,chatId,afterMessageId}) -> string`：远端 Python 过滤 `message_id > afterMessageId`，只传新行。
- `parseMessages(jsonl)`
- `findDecisionReply(messages,{code,afterMessageId,expiresAt,now})`
- `createDecisionChannel({config,run,readRun,now}) -> {send({title,body}),read({chatId,afterMessageId}),close()}`
- `send` 用 `notify({title,body,config,run})`，其中 `run({host,user,key,command,input})` 通过 `spawn` + `stdin.end(input)` 写正文。
- `read` 用 `readRun({host,user,key,command})`，流式解析，2MB 上限；截断时返回 `{truncated:true}`，调用方不得推进游标。

- [ ] **Step 1: 写失败测试**

```js
test('remote filter transfers only messages after the cursor', () => {
  const cmd=buildExportCommand({hermes:'/home/ubuntu/.local/bin/hermes',chatId:'o9cq@im.wechat',afterMessageId:42});
  assert.match(cmd,/python3/);
  assert.match(cmd,/message_id/);
  assert.match(cmd,/42/);
  assert.match(cmd,/--chat-id/);
});

test('ignores wrong chat, old message, late reply and handles 0', () => {
  const messages=parseMessages([
    '{"role":"user","text":"SYBIL D-1a2b3c 1","message_id":7}',
    '{"role":"user","text":"SYBIL D-1a2b3c 0","message_id":8}'
  ].join('\n'));
  assert.equal(findDecisionReply(messages,{code:'D-1a2b3c',afterMessageId:7,expiresAt:Date.now()+60000,now:Date.now()}),null); // message 7 is not after 7? use > semantics
  assert.deepEqual(findDecisionReply(messages,{code:'D-1a2b3c',afterMessageId:6,expiresAt:Date.now()+60000,now:Date.now()}),{choice:'0',messageId:8});
  assert.equal(findDecisionReply(messages,{code:'D-1a2b3c',afterMessageId:0,expiresAt:Date.now()-1,now:Date.now()}),null);
});

test('send writes the body through notify input and read fails closed on truncation', async () => {
  let input;
  const channel=createDecisionChannel({
    config:{host:'h',user:'u',key:'k',hermes:'hermes',target:'weixin:chat@im.wechat'},
    run:async ({input:body})=>{input=body;return 'ok';},
    readRun:async()=>({truncated:true,stdout:''})
  });
  await channel.send({title:'t',body:'b'});
  assert.equal(input,'b');
  await assert.rejects(channel.read({chatId:'chat@im.wechat',afterMessageId:0}),/truncated/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test decision-channel.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

- `buildExportCommand`：`hermes sessions export ... | python3 -c '...'`，Python 读取 JSONL，只打印 `message_id > baseline`。
- `parseMessages`：只保留 `role==='user'`。
- `findDecisionReply`：先判过期；`message_id > afterMessageId`；取最早命中；接受 choice `1|2|0`。
- `send`：复用 `notify` 的 `run({input})`；正文截断 2000 字符；失败抛错。
- `read`：`spawn` 流式；2MB 上限；超时 30 秒；截断抛错，调用方不推进游标。
- 校验 target 必须是 `weixin:` 非空。

- [ ] **Step 4: 运行测试**

Run: `node --test decision-channel.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add decision-channel.mjs decision-channel.test.mjs
git commit -m "feat(plan-review): add a bounded WeChat decision channel"
```

---

### Task 6: 死锁、审批、超时、并发与动作恢复

**Files:**
- Modify: `plan-review.mjs`
- Test: `plan-review.test.mjs`

**Interfaces:**
- 决策字段与 Task 3 一致；`code` 为 `D-`/`A-` + 8 hex，必须与所有活跃 decision 不冲突。
- 创建 decision 前读取该 chat 的当前高水位作为 `baselineMessageId`；读取失败则不发送可回答 decision，状态 `awaiting-config`/`recovery-required`。
- 发送失败：保持 pending，记录 `sendAttempts/lastSendError`，5s/15s/30s 退避；同一 code 重发。
- `pollDecisions`：single-flight；按 `message_id` 升序；每条 decision 单独 `commitDecision` + cursor；先判过期再匹配；截断/失败不推进游标。
- `decide`：条件更新 `pending → answered`；`0/1/2` 语义见 Global Constraints；动作日志保证副作用可重放。
- `humanRounds` 持久化；耗尽后 `rejected`，不再 deadlock。
- `close` 排空 poll/watch/start/respond/send/focus。

- [ ] **Step 1: 写失败测试**

```js
test('deadlock sends both positions, 1 gives one last round, 2 waives, 0 cancels', async () => {
  const f=await reviewFixture({verdicts:[changesVerdict,changesVerdict,changesVerdict,changesVerdict,changesVerdict],replies:['1']});
  const started=await driveToDeadlock(f);
  assert.match(started.decision.reasonA,/Codex/);
  assert.match(started.decision.reasonB,/执行方/);
  f.setReply(`SYBIL ${started.decision.code} 1`);
  await f.service.pollDecisions();
  // executor responds with another failing verdict; assert final rejected, not deadlock
});

test('irreversible approval: 1 approves, 2 rejects, 0 cancels', async () => {
  for (const [choice,status] of [['1','approved'],['2','rejected'],['0','cancelled']]) {
    const f=await reviewFixture({verdicts:[approveVerdict],irreversible:true,replies:[choice]});
    const started=await f.service.start({session:f.session,planPath:'docs/superpowers/plans/demo.md'});
    const waiting=await waitReview(f,started.reviewId,'awaiting-approval');
    f.setReply(`SYBIL ${waiting.decision.code} ${choice}`);
    await f.service.pollDecisions();
    assert.equal((await waitReview(f,started.reviewId,status)).status,status);
  }
});

test('a late reply is ignored and the review is timed-out', async () => {
  const f=await reviewFixture({verdicts:[changesVerdict,changesVerdict,changesVerdict,changesVerdict],expire:true,replies:['1']});
  await driveToDeadlock(f);
  await f.service.pollDecisions();
  assert.equal(f.service.list({session:f.session}).reviews[0].status,'timed-out');
});

test('concurrent poll and decide consume a reply once', async () => {
  // Promise.all(pollDecisions x2); assert one decision answered, one action group
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test plan-review.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

- `createDecision`：高水位、code 冲突、chat 绑定、expiresAt、baseline。
- `sendDecision`：notify；成功/失败状态；退避重试；正文带 `1/2/0`。
- `pollDecisions`：single-flight；升序；逐条 `decide`；截断不推进。
- `decide`：`commitDecision` + action；`runActions` 重放：`write-review-section`、`start-resume-worker`、`close-worker`。
- 人工 1：`resuming` + action `start-resume-worker`；新 worker 带 `buildResumePrompt`；`humanRounds++`。
- 人工 2：`waived` + `waiver:'executor-position'` + 写 review section；人工 0：`cancelled`。
- `finish`：统一关闭/暂停 worker、清 timer、持久化、通知。
- `close`：排空所有在途。

- [ ] **Step 4: 运行测试**

Run: `node --test plan-review.test.mjs decision-channel.test.mjs workspace.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add plan-review.mjs plan-review.test.mjs
git commit -m "feat(plan-review): handle decisions, actions and human rounds"
```

---

### Task 7: 多计划 gate 与 daemon 写门禁

**Files:**
- Create: `plan-review-gate.mjs`（纯策略）
- Modify: `workers.mjs`
- Modify: `control.mjs`
- Test: `plan-review-gate.test.mjs`

**Interfaces:**
- `structuralPlans({projectPath,reviewService}) -> [{planPath,inputHash,irreversible,review}]`：磁盘候选 ∪ 已管理路径。
- `gateWrite({projectPath,action:'worker-start'|'commit'|'accept'}, {reviewService}) -> {allow,reason}`：
  - 所有 `irreversible` 计划必须有当前 `inputHash` 的 `approved|waived` review。
  - `commit`/`accept` 还必须有该 review 的 answered approval（choice `1`）或 `waived`。
  - 任一未评审/版本不符/等待中 → deny，reason 列出全部计划。
- `workers.start` 对 `dispatch|parallel` 调 `gate('worker-start')`；`finalize` 在 `commitWorktree` 前调 `gate('commit')`；`workers.accept` 调 `gate('accept')`。
- `control.mjs` 创建可变 `gate` 包装，`planReviews` 创建后赋值。

- [ ] **Step 1: 写失败测试**

```js
test('gate binds every irreversible plan and current hash', async () => {
  const f=await reviewFixture({verdicts:[approveVerdict],irreversible:true});
  // plan A approved + approval; add plan B irreversible unapproved
  // assert gateWrite worker-start/commit/accept all deny and name plan B
});

test('gate denies when an approved plan changes after approval', async () => {
  // approve, then edit body; assert inputHash mismatch -> deny
});

test('workers.start/finalize/accept call the gate before side effects', async () => {
  // createWorkerService with gate returning false; assert no worktree/commit/accept
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test plan-review-gate.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

- `plan-review-gate.mjs` 纯函数，接受 `{plans, reviews}`，返回 allow/reason；不依赖文件系统，便于测试。
- `workers.start`/`finalize`/`accept` 在真实副作用前 await gate；拒绝时抛 `Plan review gate: ...`。
- `finalize` 拒绝时不 `commitWorktree`，报告标记 `needsReview`。
- `control.mjs` 包装；`planReviews` 未创建时 gate 返回 deny（不是 allow），避免启动窗口绕过。
- 测试覆盖：多计划、未启动、批准后修改、worker 运行中失效、普通命令不受影响。

- [ ] **Step 4: 运行测试**

Run: `node --test plan-review-gate.test.mjs worker-daemon.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add plan-review-gate.mjs workers.mjs control.mjs plan-review-gate.test.mjs
git commit -m "feat(plan-review): gate all daemon write paths"
```

---

### Task 8: 本地 HTTP 端点

**Files:**
- Modify: `native-inbox.mjs`
- Modify: `control.mjs`（只加 `planReview` 透传）
- Test: `plan-review-api.test.mjs`

**Interfaces:**
- `createNativeInbox({..., planReview = {}})`
- Token-only：`POST /plan-review/check`、`/plan-review/gate`
- Session lease：`/plan-review/start`、`/result`、`/respond`、`/recover`、`/list`
- 校验：`planPath` <=1024；`reviewId` UUID；`waitMs 0..25000`；`responses` 1..20 个对象，`issueId` `/^[A-Za-z0-9_-]{1,20}$/`、`decision accept|reject`、`evidence/planChange` <=2000；**`Buffer.byteLength(JSON.stringify(responses)) <= 12000`**。
- `/respond` 接收 `expectedRound`、`requestId`。

- [ ] **Step 1: 写失败测试**

```js
test('validates UUID, evidence and UTF-8 byte budget', async () => {
  const reviewId=randomUUID();
  const f=await workerFixture('read',{planReview:{start:async()=>({reviewId}),result:async()=>({reviewId,status:'approved'}),respond:async()=>({reviewId,status:'reviewing'}),recover:async()=>({reviewId,status:'reviewing'}),list:async()=>({reviews:[]}),check:async()=>({block:false}),gate:async()=>({decision:'allow'})}});
  const n=await registerNative(f);
  await assert.rejects(n.call('/plan-review/respond',{reviewId,responses:[{issueId:'R1',decision:'reject'}]}),/evidence/);
  const chinese='评'.repeat(5000);
  await assert.rejects(n.call('/plan-review/respond',{reviewId,responses:[{issueId:'R1',decision:'accept',evidence:chinese}]}),/too large/);
  await f.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test plan-review-api.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

- 按 Task 8 的端点加校验；token-only 端点不要求 session lease。
- 字节预算用 `Buffer.byteLength`。
- `createControl` 透传 `planReview`；真实服务在 Task 11 接入。

- [ ] **Step 4: 运行测试**

Run: `node --test plan-review-api.test.mjs native-inbox.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add native-inbox.mjs control.mjs plan-review-api.test.mjs
git commit -m "feat(plan-review): add validated local endpoints"
```

---

### Task 9: MCP 工具

**Files:**
- Modify: `native-mcp.mjs`
- Test: `plan-review-tool.test.mjs`, `native-mcp.test.mjs`

**Interfaces:**
- `bridge_plan_review({planPath,model?,effort?})`
- `bridge_plan_review_result({reviewId,waitMs?})`
- `bridge_plan_review_respond({reviewId,responses,expectedRound,requestId})`，`responses` 是 JSON 字符串
- `bridge_plan_review_recover({reviewId})`
- `bridge_plan_review_list({all?})`

- [ ] **Step 1: 写失败测试**

`tools/list` 包含五个工具；非法 JSON、超过 12000 **字节**、缺少 `requestId` 都报错；`result` 转发。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test plan-review-tool.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

- 五个工具定义；`respond` 解析后按 UTF-8 字节预算校验。
- `initialize.instructions` 写明流程和恢复入口。

- [ ] **Step 4: 运行测试**

Run: `node --test plan-review-tool.test.mjs native-mcp.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add native-mcp.mjs plan-review-tool.test.mjs native-mcp.test.mjs
git commit -m "feat(mcp): expose plan review tools"
```

---

### Task 10: Claude Code hooks 与安全配置

**Files:**
- Create: `scripts/sibyl-hook.mjs`
- Create: `scripts/sibyl-hook.cmd`（Windows wrapper）
- Create: `scripts/sibyl-hook.sh`（POSIX wrapper）
- Modify: `native-config.mjs`
- Test: `sibyl-hook.test.mjs`, `native-config.test.mjs`

**Interfaces:**
- Hook 命令不拼接用户路径：`native-config.mjs` 生成 wrapper + `scripts/sibyl-hook.config.json`（含 data dir）；settings 只引用 wrapper。
- `decideStop(input, call)` / `decidePreTool(input, call)`：async。
- Stop：`{decision:'block',reason}` / `{}`。
- PreToolUse：`{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny'|'ask',permissionDecisionReason}}` / `{}`。
- 叶子级合并：只替换命令含 `sibyl-hook` 的叶子，保留 matcher 和同组其他命令。
- 路径含 `$`、反引号、`%`、`!` 等 shell 元字符时，安装直接报错并给出说明（不生成可能执行错误命令的配置）；空格路径测试通过。

- [ ] **Step 1: 写失败测试**

```js
test('async stop/pre-tool decisions and fail-open', async () => {
  const input={cwd:'/p',stop_hook_active:false};
  const call=async p=>p==='/plan-review/check'?{block:true,reason:'请先评审'}:{};
  assert.deepEqual(await decideStop(input,call),{decision:'block',reason:'请先评审'});
  assert.deepEqual(await decideStop({...input,stop_hook_active:true},call),{});
  const tool={cwd:'/p',tool_input:{command:'rm -rf build'}};
  assert.equal((await decidePreTool(tool,async()=>({decision:'deny',reason:'等待人批'}))).hookSpecificOutput.permissionDecision,'deny');
  assert.deepEqual(await decidePreTool({...tool,tool_input:{command:'ls'}},async()=>({decision:'allow'})),{});
  assert.deepEqual(await decideStop(input,async()=>{throw Error('down');}),{});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test sibyl-hook.test.mjs native-config.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

- hook 脚本：只在直接执行时读 stdin；导出 async 函数；runtime 校验 127.0.0.1/http/禁止重定向/1.5s 超时；错误输出 `{}`。
- wrapper：Windows `.cmd` 用 `%~dp0`；POSIX `.sh` 用 `dirname "$0"`；settings 引用 wrapper。
- `configureClaudeHooks`：叶子级合并、备份一次、非法 JSON 原样保留、特殊字符路径 fail-fast。
- 进程级测试：真实 stdin/stdout/退出码、deny/ask/allow、非 2xx、超时、特殊路径。

- [ ] **Step 4: 运行测试**

Run: `node --test sibyl-hook.test.mjs native-config.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add scripts/sibyl-hook.mjs scripts/sibyl-hook.cmd scripts/sibyl-hook.sh native-config.mjs sibyl-hook.test.mjs native-config.test.mjs
git commit -m "feat(hooks): add a safe shell wrapper and strict hook contract"
```

---

### Task 11: daemon 接线、可见性、状态、文档与端到端

**Files:**
- Modify: `control.mjs`
- Modify: `CLAUDE.md`
- Modify: `skills/agents-calling/SKILL.md`
- Modify: `使用说明.md`
- Modify: `README.md`
- Test: `control-v3.test.mjs`, `plan-review-e2e.test.mjs`

**Interfaces:**
- `createControl` 新增：`planReviewConfig`、`notifyConfig`、`decisionRun`、`readRun`、`focusThread`、`chatId`、`gate`。
- 微信可选：配置缺失时 `decisionChannel=null`；需要人批的 review 停在 `awaiting-config`/`awaiting-human` 并显示 `lastNotifyError`；daemon 正常启动。
- `state()` 新增 `planReviews`、`decisions`。
- `close()`：`planReviews.close()` → `workers.closeAll()` → `store.close()`。
- 可见性：review 服务每启动一个新 worker 先发短标题 turn → `waitForThread` → `focusThread` → 完整评审 turn；`focusError` 记录；Windows 用 PowerShell 脚本，其他平台记录 `focusUnavailable`。
- `plan-review-gate.mjs` 接入 `workers.start/finalize/accept`；`planReviews` 未创建时 gate 默认 deny。

- [ ] **Step 1: 写失败测试**

- 无 `.notify.json` 时 `createControl` 启动；`/api/status` 有 `planReviews`/`decisions`。
- fake review worker 走完整回路；`focusThread` 每次新 worker 调用一次；失败记录。
- gate 拒绝时 `workers.start`/`finalize`/`accept` 无副作用。
- `close()` 排空在途并关闭 worker/store。
- 全量测试 0 fail。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test control-v3.test.mjs plan-review-e2e.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

- `control.mjs` 接线、可选微信、gate、focus、state、close。
- `CLAUDE.md`/`SKILL.md`/`使用说明.md`/`README.md` 更新流程与边界。
- 更新 `## Codex review`（第三轮结论）。

- [ ] **Step 4: 运行全量测试**

Run:
`"/d/LXY_workspace/AI Bridge/.tools/node26/node-v26.13.0-win-x64/node.exe" --test --test-concurrency=1 --test-timeout=30000 *.test.mjs`
Expected: 0 fail（允许既有 skip）。

- [ ] **Step 5: 提交**

```bash
git add control.mjs CLAUDE.md skills/agents-calling/SKILL.md 使用说明.md README.md control-v3.test.mjs plan-review-e2e.test.mjs
git commit -m "feat(plan-review): wire the loop, gate and visibility into the daemon"
```

---

## Codex review

### Review 1 — 2026-11-08

- 评审：Codex / gpt-6-astra / effort high；线程 `01a1bb59-ae82-74b0-b021-7cd01e7ec7a9`
- 结论：**changes-required**
- 全文：`D:\LXY_workspace\AI Bridge\review-driver-2026-11-08.log` 第 2 行 JSON 的 `text`
- 采纳：R01–R22 全部采纳；Revision 2 已重写任务顺序、持久 worker、hash、原子决策、独立容量、daemon gate、状态机、watcher/接管、并发、预算、保留、微信、SSH、输入边界、hooks、夹具。

### Review 2 — 2026-11-08

- 评审：Codex / gpt-6-astra / effort high；线程 `01a1bb64-6cf7-7653-84e7-984554802b1a`
- 结论：**changes-required**
- 全文：`D:\LXY_workspace\AI Bridge\review-driver-rev2-2026-11-08.log` 第 2 行 JSON 的 `text`
- 已闭合：R15、R17、R20、R22；R05 部分闭合。
- 未闭合：V2-01–V2-20；Revision 3 已按以下方式处理：
  - V2-01：hash 只含 `change` + 正文，排除 `review` 和标记生成区。
  - V2-02：gate 绑定**所有** irreversible 计划的当前 hash；覆盖 worker-start/commit/accept；未启动/修改后/运行中失效都 deny。
  - V2-03：新增动作日志；`commitDecision` 原子写 decision/review/action/cursor；恢复按动作重放；批准先 `approving` 后 `approved`。
  - V2-04：review worker 用 `--mcp none`，不能调用 ai-bridge 写工具。
  - V2-05：check 候选 = 磁盘结构性计划 ∪ 已管理路径；损坏声明也 block。
  - V2-06：显式状态机；`awaiting-human` 迁移；`humanRounds` 持久化；questions 编号；人工 1/2/0 语义。
  - V2-07：路径锁、expectedRound、requestId、turnId 去重、poll single-flight、close 排空。
  - V2-08：整体 deadline/活跃时长/暂停时长；统一 `finish()`。
  - V2-09：review `scope=[]`、跳过 repo 检查；turn failed 映射。
  - V2-10：同项目 takeover/pause/resume/close；recover 前清理旧 worker；启动调和 decision/review。
  - V2-11：短标题 turn → waitForThread → focus → 完整评审 turn；每新 worker 一次。
  - V2-12：调用侧排除 review；`checkWorkerCapacity` 不变。
  - V2-13/14：创建时高水位；远端 Python 过滤；截断不推进游标；过期优先。
  - V2-15：统一 `readPlan`；responses UTF-8 字节预算。
  - V2-16：可达性保留根；裁剪整组；逐轮 compact round 记录。
  - V2-17：Task 4 提供 resume/recover；Task 7 用真实 workers 验证 gate；Task 8 指向 Task 11。
  - V2-18：`plan-review-test-support.mjs` 有状态 fake、可控时钟、真实 reopen、事件等待、review 脚本模式、超时对齐。
  - V2-19：wrapper + 配置 JSON；特殊字符路径 fail-fast；进程级测试。
  - V2-20：复用 `notify` 的 `run({input})` 契约。

### Review 3 — 2026-11-08

- 评审：Codex / gpt-6-astra / effort high；线程 `01a1bb6f-5b7a-7720-90ff-42d516bea7da`
- 结论：**changes-required**
- 全文：`D:\LXY_workspace\AI Bridge\review-driver-rev3-2026-11-08.log` 第 2 行 JSON 的 `text`
- 已关闭：V2-01、V2-05、V2-12、V2-19、V2-20。
- 仍有关闭项：V3-01–V3-15。

**Residual blocker**

- **V3-01（V2-02 回归）**：gate 只检查 `irreversible` 集合，普通 `review:required` 计划的 Codex 批准没有进入 gate；已管理计划把 `irreversible:true` 改成 `false` 会先退出检查集合。需要把“所有结构计划都需要当前版本 Codex 批准”和“高风险子集额外需要人批”分开；声明降级/损坏/删除也要先判版本失效。
- **V3-02（V2-03/V2-15）**：`finalizeApproved` 和动作重放没有重新校验 `expectedInputHash`；批准旧快照可能覆盖新正文；人工选 2 直接写 `waived`，gate 在写动作完成前就接受。所有授权写回要持久化 `expectedInputHash`，写前统一受控读取；`approved`/`waived` 都以写动作完成为可用条件。
- **V3-03（V2-03）**：动作日志没有稳定 worker 操作 ID；`workers.start()` 每次随机 UUID，`save()` 还吞持久化异常，启动后崩溃重放会创建第二个 worker；`humanRounds++` 也可能随重放重复扣预算。需要在动作事务里预分配 workerId/operationId，`workers.start` 按 ID 幂等，持久化失败不得继续启动。

**Residual major**

- V3-04：`--mcp none` 只测 argv，没有验证实际 Codex 工具目录；daemon 也没有 reviewer 能力校验。
- V3-05：review 仍有真实分支遗漏：`workerTurnTimeoutMs` 不接受 `review`；跳过 repo 检查后 setup 仍 `listRefs`；`waitForThread` 不等标题 turn 完成，正式 turn 可能撞 `A turn is already running`。
- V3-06：`maxHumanRounds=1` 但终止条件是 `humanRounds > maxHumanRounds`，最后一轮失败仍会落回 deadlock；选择 1 没有“执行方先修改”的阶段；questions 与 issue 的 `Q1` 命名空间冲突。
- V3-07：`lastActorSessionId` 不改变 worker 的 `sourceSessionId`，新 session 接管后真实 `turn/result` 仍被 `own()` 拒绝；`resume()` 同时表示启动恢复和单 review 恢复；`awaiting-config` 不在状态表；终态重开入口未定义。
- V3-08：turn 去重键只有 `lastProcessedTurnId`，新 worker 的 serial 从 0 开始会撞号；watch/decide/recover/超时没有共用同一串行边界。
- V3-09：整体 deadline/活跃时长/暂停时长只有字段和摘要，没有执行规则；`changes-required` 没要求 pause；重启后暂停区间未定义。
- V3-10：微信通道没有高水位查询接口；首次创建 decision 仍可能拉全量历史；单次增量超过 2MB 会永久截断；store 只有单个全局 cursor，换 chat 未定义。
- V3-11：发送 runner 没有总超时/取消；`notify` 只有 SSH 连接超时，Hermes send 挂住时 `close()` 会一直等。
- V3-12：逐轮 compact round 记录只在摘要出现，Task 3/4 没有 producer/schema/保存时机。
- V3-13：Task 7 的 fail-closed gate 在真实服务 Task 11 之前会让 Task 7–10 的普通 dispatch 全部被拒；Task 4 又提前测试 Task 6 的 poll。
- V3-14：测试断言仍有确定错误：message 7=`1`、8=`0` 时 after=7 应命中 8，after=6 应命中 7；截断契约抛错/返回不一致；`waitMs:0` 异步竞态；evidence 5000 字先违反单字段 2000；MCP fixture 15 秒短于 25 秒等待。
- V3-15：服务层 respond 没执行同样的 UTF-8 字节预算，也没校验未知/重复 issueId、遗漏 blocker/major、expectedRound/requestId。

**仍需人拍板**

- 死锁选 2 是否同时豁免高风险操作的人批？当前 gate 接受 `waived` 会产生这个效果。
- 相同 plan hash 的批准是否允许任意次数/任意目标的删除、部署，还是要绑定操作、目标和一次执行。
- 谁能重开 rejected/cancelled/timed-out；同 hash 直接 start 新 review 是否重置全部轮数预算。
- 整体 60 分钟是否包含人工和执行方等待；费用/token 预算是否实施。
- 计划发现规则、相关文件/diff/项目约束由谁收集并冻结。
- `configureClaudeHooks` 由哪个入口调用；固定 `scripts/sibyl-hook.config.json` 在多项目/多 data dir 下如何避免覆盖。

**评审结论**：Revision 3 的方向正确，V2 的 5 项已关闭；剩余 3 个 blocker 都是可修的契约问题，12 个 major 多为生命周期、预算、微信边界和测试夹具。继续全量修会进入第四轮；也可以把 v1 缩成“核心评审 + Stop hook”，把微信死锁、daemon gate、动作日志留到第二阶段。

## Deferred (not in this plan)

- 本地模型第二意见/离线兜底：实现同样的 `workers` 接口（`start/turn/result/close`），通过 `reviewer` 注入替换；v1 不实现。
- 运行台的评审可视化；v1 只在 `/api/status` 暴露 `planReviews` / `decisions`。
- Codex 执行 → Claude 评审；v1 不支持。
- 跨平台 focus：Windows 用 PowerShell 脚本；macOS/Linux 记录 `focusUnavailable`。
- 包装脚本/PowerShell 变体的完整命令覆盖；v1 用固定正则 + 明确边界。
- Hermes 的 `SYBIL` 规则作为云端配置，不纳入本仓库测试。