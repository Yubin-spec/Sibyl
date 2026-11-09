---
review: approved
change:
  scope: [worker-start, plan-review-gate]
  concurrency: true
  irreversible: false
  tasks: 1
  files: 5
---

# Worker Gate — 实施计划

> **For agentic workers:** 按本计划逐步骤执行，用 `- [ ]` 跟踪。计划通过评审前不要写实现代码。

**Goal:** 当项目存在未通过评审的结构计划时，daemon 拒绝启动 `dispatch` / `parallel` 写型 worker；`consult` 不受影响。

**Why:** Stop hook 和 PreToolUse 只覆盖 Claude 自己的文件工具。Codex worker 是独立进程，hooks 观测不到——现在一个未评审的结构计划可以被 `bridge_worker_start({tier:'dispatch'})` 直接实现掉。worker 启动本来就走 daemon，这是唯一 100% 可执行的拦截点。

**Architecture:** 新增纯函数模块 `worker-gate.mjs` 做判定；`native-inbox.mjs` 的 `/worker/start` 在调用 `worker.start` 之前调用它。判定复用已有的 `planReview.check({projectPath, strict:true})`，不新增数据表和端点。为了真正 fail-closed，`plan-review.mjs` 与 `plan-review-policy.mjs` 增加严格模式：计划目录扫描失败、计划文件读取失败在严格模式下抛错，而不是像现在这样静默当作“没有计划”。

**Tech Stack:** Node.js >= 26，零第三方依赖。

**Spec:** `docs/superpowers/plans/2026-11-08-plan-review-loop-core.md`（核心版契约，§4.3 / §4.6）

## 范围

**做：**

- `dispatch` / `parallel` 启动前调用 `planReview.check({projectPath, strict:true})`；`block:true` → 拒绝启动，错误信息带具体计划路径。
- 检查结果必须显式 `block === false` 才放行；返回 `{}`、`{error:…}`、`{block:'true'}`、`null`、数组等不符合契约的结果 → 拒绝（fail-closed）。
- 检查函数缺失或抛错 → 拒绝（fail-closed）。
- `consult` 完全不经过 gate（只读，且计划评审自身就是 consult）。
- 没有 `projectPath` 的写型 worker → 拒绝。
- 严格扫描：计划目录不可读、计划文件不可读 → 检查抛错 → gate 拒绝；只有目录正常不存在（ENOENT）才视为“没有计划”。
- 单元测试 + 一个 inbox 级集成测试（含负向断言：拒绝时不得调用 `worker.start`）。

**不做（明确残留缺口）：**

- 不停掉已经在运行的 worker；计划撤回批准后，运行中的 worker 继续跑到结束。
- 不拦 `bridge_worker_turn`（已启动的 worker 续轮）。
- 不拦 `bridge_worker_accept`（accept 只记录验收，改动已在 worker 的 worktree 里）。
- 不拦 Bash / git 写入；那是 Phase 2 daemon gate 的范围。
- 不改 `workers.mjs` 内部逻辑，也不改 `checkWorkerCapacity`。
- 不改已有的 `/plan-review/check` HTTP 端点和 hook 默认行为：严格模式只由 worker gate 显式传入。

## Global Constraints

- Node.js >= 26；零第三方 npm 依赖。
- 只在 `feat/windows-support` 上改；不碰 `develop`；不引入 `src/`。
- 每个任务独立提交；不 push。
- 现有 `worker-daemon.test.mjs` 的临时项目没有计划文件，`check` 返回 `block:false`，不应因本改动失败。
- `worker-gate.mjs` 不读磁盘、不开 DB；`check` 通过参数注入。

## Review Focus

- 不能误伤 `consult`：计划评审自身依赖 consult，gate 若拦 consult 会死锁。
- 不能因为检查结果异常或检查器吞错而静默放行。
- 错误信息必须能定位到具体计划。
- 不能影响没有结构计划的项目。
- 现有 worker 生命周期测试保持通过。

## Task 1: `/worker/start` 前置 gate + 严格检查

**Files:**
- Create: `worker-gate.mjs`
- Modify: `native-inbox.mjs`
- Modify: `plan-review.mjs`（`check` 增加 `strict`）
- Modify: `plan-review-policy.mjs`（`findPlanFiles` 增加严格模式）
- Modify: `docs/superpowers/plans/2026-11-08-plan-review-loop-core.md`（已知限制补 gate 残留缺口）
- Test: `worker-gate.test.mjs`

**Interfaces:**

- `gateWorkerStart({tier, projectPath, check}) -> Promise<{allowed: true} | {allowed: false, reason: string}>`
  - `tier` 不是 `dispatch` / `parallel` → `{allowed:true}`，**不调用** `check`。
  - 写型 tier 且 `projectPath` 为空 → `{allowed:false, reason:'Worker start requires a project path'}`。
  - `check` 不是函数 → `{allowed:false, reason:'Plan review is unavailable: no reviewer is configured'}`。
  - `check` 抛错 → `{allowed:false, reason:'Plan review is unavailable: <error.message>'}`。
  - `check` 返回非对象、数组，或 `block` 不是布尔值 → `{allowed:false, reason:'Plan review returned an invalid result'}`。
  - `block === false` → `{allowed:true}`。
  - `block === true` → 拒绝；原因优先取 `result.reason`，但必须包含具体计划路径：若 `plans` 中存在 `approved === false` 的 `path` 且 reason 不含该路径，则用 `'结构计划未通过评审：' + path`；没有路径时退回 reason 或 `'结构计划未通过评审'`。
- `plan-review-policy.mjs`：`findPlanFiles(projectPath, {strict = false, readdir: list = readdir} = {})`。
  - 非严格：保持现有整项目递归扫描（行为不变）。
  - 严格：**只扫描受管计划路径**——项目根目录的 `*.plan.md`，以及 `docs/superpowers/plans/**/*.md`；不再进入源码、缓存等无关目录。
  - 严格模式下项目根 `readdir` 失败 → 抛 `Project directory could not be scanned: . (<message>)`；受管计划目录 `ENOENT` → 视为没有计划；受管计划目录其它读取错误 → 抛 `Plan directory could not be scanned: <受管相对路径> (<message>)`。
- `plan-review.mjs`：
  - `check({projectPath, filePath, mode = 'ask', strict = false})`；第 560 行的调用必须改为 `await findPlanFiles(project, {strict, readdir: fileSystem.readdir})`。
  - `createPlanReviewService` 增加仅供测试注入的 `fileSystem = {readdir, readFile}` 选项（默认真实 fs）；`check` 用 `fileSystem.readFile` 读取计划，严格模式下读取失败抛 `Plan could not be read: <relative> (<message>)`，非严格保持 `continue`。其余返回结构不变；`control.mjs` 不传该选项。
- `native-inbox.mjs`：`/worker/start` 在现有参数校验之后、`worker.start` 之前插入：

```js
const gate = await gateWorkerStart({tier: body.tier, projectPath: s.projectPath, check: planReview.check});
if (!gate.allowed) throw Error(gate.reason);
```

- 不改 `control.mjs`、`workers.mjs`。

- [ ] **Step 1: 写失败测试**

`worker-gate.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gateWorkerStart} from './worker-gate.mjs';
import {openNativeInbox} from './native-inbox.mjs';

test('consult bypasses the gate without calling check', async () => {
  let called = false;
  const result = await gateWorkerStart({tier: 'consult', projectPath: '/p', check: async () => { called = true; return {block: true}; }});
  assert.deepEqual(result, {allowed: true});
  assert.equal(called, false);
});

test('a write tier is refused while a structural plan is unapproved', async () => {
  const seen = [];
  const check = async input => { seen.push(input); return {block: true, mode: 'ask', reason: '结构计划未通过评审：demo.plan.md', plans: [{path: 'demo.plan.md', approved: false}]}; };
  assert.deepEqual(await gateWorkerStart({tier: 'dispatch', projectPath: '/p', check}),
    {allowed: false, reason: '结构计划未通过评审：demo.plan.md'});
  assert.equal((await gateWorkerStart({tier: 'parallel', projectPath: '/p', check})).allowed, false);
  assert.deepEqual(seen[0], {projectPath: '/p', strict: true});
});

test('a write tier passes only on an explicit block:false result', async () => {
  const check = async () => ({block: false, mode: 'ask', reason: null, plans: []});
  assert.deepEqual(await gateWorkerStart({tier: 'dispatch', projectPath: '/p', check}), {allowed: true});
  for (const result of [{}, {error: 'unavailable'}, {block: 'true'}, null, []]) {
    const denied = await gateWorkerStart({tier: 'dispatch', projectPath: '/p', check: async () => result});
    assert.equal(denied.allowed, false, JSON.stringify(result));
    assert.match(denied.reason, /invalid result/i);
  }
});

test('the refusal names the blocking plan even without a reason', async () => {
  const check = async () => ({block: true, plans: [{path: 'docs/superpowers/plans/demo.md', approved: false}]});
  const result = await gateWorkerStart({tier: 'dispatch', projectPath: '/p', check});
  assert.equal(result.allowed, false);
  assert.match(result.reason, /docs\/superpowers\/plans\/demo\.md/);
});

test('a write tier without a project is refused', async () => {
  const result = await gateWorkerStart({tier: 'dispatch', check: async () => ({block: false})});
  assert.equal(result.allowed, false);
  assert.match(result.reason, /project/i);
});

test('the gate fails closed when the review service is missing or throws', async () => {
  assert.equal((await gateWorkerStart({tier: 'dispatch', projectPath: '/p'})).allowed, false);
  const thrown = await gateWorkerStart({tier: 'dispatch', projectPath: '/p', check: async () => { throw Error('boom'); }});
  assert.equal(thrown.allowed, false);
  assert.match(thrown.reason, /plan review/i);
  assert.match(thrown.reason, /boom/);
});
```

集成测试（同一个文件）：注册**带 `projectPath`** 的会话，写型请求带合法 `scope`，并断言拒绝时 `worker.start` 从未被调用：

```js
test('the inbox refuses dispatch and parallel but still starts consult', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worker-gate-inbox-'));
  const starts = [], checks = [];
  const inbox = await openNativeInbox({
    dir,
    worker: {start: async input => { starts.push(input); return {workerId: '11111111-1111-1111-1111-111111111111', status: 'starting'}; }},
    planReview: {check: async input => {
      checks.push(input);
      return {block: true, mode: 'ask', reason: '结构计划未通过评审：demo.plan.md', plans: [{path: 'demo.plan.md', approved: false}]};
    }}
  });
  try {
    const runtime = JSON.parse(await readFile(join(dir, 'native-runtime.json'), 'utf8'));
    const post = async (path, body) => {
      const response = await fetch(new URL(path, runtime.url), {method: 'POST',
        headers: {authorization: 'Bearer ' + runtime.token, 'content-type': 'application/json'}, body: JSON.stringify(body)});
      return {status: response.status, value: await response.json()};
    };
    const registered = await post('/register', {tool: 'codex', title: 't', projectPath: process.cwd()});
    const session = {id: registered.value.id, lease: registered.value.lease};

    const dispatch = await post('/worker/start', {...session, tool: 'codex', tier: 'dispatch', scope: ['a.mjs']});
    assert.equal(dispatch.status, 400);
    assert.match(dispatch.value.error, /demo\.plan\.md/);
    const parallel = await post('/worker/start', {...session, tool: 'codex', tier: 'parallel', scope: ['a.mjs']});
    assert.equal(parallel.status, 400);
    assert.equal(starts.length, 0);
    assert.equal(checks.length, 2);
    assert.deepEqual(checks[0], {projectPath: process.cwd(), strict: true});

    const consult = await post('/worker/start', {...session, tool: 'codex', tier: 'consult'});
    assert.equal(consult.status, 202, JSON.stringify(consult.value));
    assert.equal(starts.length, 1);
  } finally { await inbox.close(); await rm(dir, {recursive: true, force: true}); }
});

test('a missing or throwing plan reviewer still allows consult', async () => {
  // 参数化两种场景：planReview 缺失（无 check）与 check 抛错
  // 各自断言：dispatch 400；consult 202；worker.start 只被 consult 调用一次；写型拒绝时未调用 worker.start
});
```

严格检查测试（新增到 `worker-gate.test.mjs`；用真实 `createPlanReviewService` + 临时项目 + 可注入的 `fileSystem`，不依赖 chmod）：

```js
test('strict check surfaces managed scan failures and ignores unrelated directories', async () => {
  // 1) 正常无计划：strict 与非 strict 都返回 block:false
  // 2) docs/superpowers/plans 的 readdir 抛 EACCES：strict 抛错且错误含该目录与原始 message；非 strict 返回 block:false
  // 3) 项目根存在 unrelated-cache，注入 readdir 看到它时抛 EACCES：strict 不访问 unrelated-cache（spy 断言）且仍返回 block:false
  // 4) 计划文件读取抛 EACCES（fileSystem.readFile 注入）：strict 抛错且错误含计划相对路径；非 strict 跳过并返回 block:false
  // 5) 上述 strict 抛错经 gateWorkerStart 转为 {allowed:false}
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test worker-gate.test.mjs`
Expected: FAIL（`Cannot find module './worker-gate.mjs'`）

- [ ] **Step 3: 实现**

- `worker-gate.mjs`：按 Interfaces 实现，只导出 `gateWorkerStart`；内部先判 tier，再判 projectPath、check、返回值契约。
- `plan-review-policy.mjs`：`findPlanFiles(projectPath, {strict = false, readdir: list = readdir} = {})`。非严格分支保持现有整项目递归扫描；严格分支只扫描受管路径：项目根只收 `*.plan.md`（不递归子目录），再递归 `docs/superpowers/plans/**/*.md`。严格模式下项目根 `list` 失败 → 抛 `Project directory could not be scanned: . (<message>)`；受管目录 `ENOENT` → 跳过；其它受管目录读取失败 → 抛 `Plan directory could not be scanned: <受管相对路径> (<message>)`（用当前递归层的 `prefix`，不要引用未声明的 `relative`）。
- `plan-review.mjs`：`createPlanReviewService` 增加 `fileSystem = {readdir, readFile}` 测试注入项（默认真实 fs，`control.mjs` 不传）；`check` 改为 `await findPlanFiles(project, {strict, readdir: fileSystem.readdir})`，并用 `fileSystem.readFile` 读取计划；严格模式读取失败时 `if (strict) throw Error('Plan could not be read: ' + relativePath + ' (' + error.message + ')');`。
- `native-inbox.mjs`：`import {gateWorkerStart} from './worker-gate.mjs'`；按上面代码插入 gate。
- 不改 `control.mjs`、`workers.mjs`；不改已有 `/plan-review/check` 端点与 hook 默认行为。

- [ ] **Step 4: 运行测试**

Run: `node --test worker-gate.test.mjs worker-daemon.test.mjs plan-review-api.test.mjs plan-review.test.mjs native-inbox.test.mjs`
Expected: PASS

再跑全量：

`"/d/LXY_workspace/AI Bridge/.tools/node26/node-v26.13.0-win-x64/node.exe" --test --test-concurrency=1 --test-timeout=30000 *.test.mjs`

Expected: 0 fail（允许既有 skip）

- [ ] **Step 5: 提交**

```bash
git add worker-gate.mjs worker-gate.test.mjs native-inbox.mjs plan-review.mjs plan-review-policy.mjs docs/superpowers/plans/2026-11-08-plan-review-loop-core.md
git commit -m "feat(worker): refuse write workers while a structural plan is unapproved"
```

## 验收标准

- 有未批准结构计划的项目：`bridge_worker_start({tier:'dispatch'})` 和 `{tier:'parallel'}` 被拒，错误信息含具体计划路径；拒绝时 `worker.start` 未被调用。
- 同一项目：`bridge_worker_start({tier:'consult'})` 仍成功；`bridge_plan_review` 不受影响；检查器缺失或抛错时 consult 仍成功。
- 没有计划文件的项目：dispatch 正常启动（现有 `worker-daemon.test.mjs` 通过）。
- 检查返回异常结构、检查器缺失或抛错、严格扫描失败：全部拒绝启动，不静默放行。
- 全量测试 0 fail。
- 残留缺口写进 `docs/superpowers/plans/2026-11-08-plan-review-loop-core.md` 的已知限制：运行中的 worker、`turn`、`accept` 不在 gate 内。

<!-- SIBYL_REVIEW_BEGIN -->
## Codex review

- 状态：approved
- 结论：完整复审后，严格参数传递、受管扫描边界、错误定位和确定性失败测试已明确，未发现 blocker/major；以下两项轻微修正可随实施完成。
- 评审模型：codex
- 轮次：3
- 采纳：R1, R2
- 残留风险：
<!-- SIBYL_REVIEW_END -->
