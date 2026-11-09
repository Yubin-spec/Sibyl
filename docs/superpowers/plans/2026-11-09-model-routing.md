---
review: approved
change:
  scope: [model-policy, worker-start]
  concurrency: false
  irreversible: false
  tasks: 3
  files: 3
---

# 执行模型静态路由 — 实施计划

> Revision 1（2026-11-09）：初稿。
> Revision 2（2026-11-09）：按 Codex 第 1 轮评审修订——配置读取移到租约/容量检查之前，修正接线变量，补 worker 级集成测试与并发测试。

> **For agentic workers:** 按本计划逐步骤执行，用 `- [ ]` 跟踪。计划通过评审前不要写实现代码。

**Goal:** 把「角色 → 模型 / effort」从硬编码函数升级为一份可读、可局部覆盖的静态路由表；Codex 工作方按项目配置选模型，Claude 保持默认。

**Why:** 现在 `model-policy.mjs` 把 6 种组合写死在代码里，换模型必须改代码再发版。用户明确要「默认表 + 项目 `.sibyl/models.json` 覆盖」，并且本轮只做静态路由，不做失败/额度切换。

**Architecture:** 只改 `model-policy.mjs`（纯策略 + 配置加载）、`workers.mjs`（启动时读取项目策略）和 `plan-review.mjs`（评审 worker 跳过项目策略）。不新增模块、不改 MCP 工具签名、不改 HTTP 端点、不改数据库。

**Tech Stack:** Node.js >= 26，零第三方依赖。

## 范围

**做：**

- `model-policy.mjs` 导出 `DEFAULT_CODEX_POLICY`、`normalizeModelPolicy`、`loadModelPolicy`；`chooseCodexModel` 接受可选 `policy`。
- 项目内 `.sibyl/models.json` 可覆盖任意叶子（`model` 和/或 `effort`）；未覆盖的叶子沿用默认。
- 配置非法（未知键、未知 kind、model 非字符串、effort 非法、version 不是 1）→ 抛错，错误信息带文件路径与具体字段。
- `workers.mjs`：`tool === 'codex' && model === 'auto'` 时按项目策略选模型；`tool === 'claude' && auto` 维持现状（`model=null`，`modelReason='claude-default'`）。
- 计划评审的 worker 显式传 `useProjectPolicy: false`，不受项目路由表影响；要改评审模型只能用计划评审配置里的 `reviewerModel` / `reviewerFinalModel`。
- 结果回显：命中项目配置时 `modelReason` 前缀 `project:`，便于在观测页和 `bridge_worker_result` 里区分。
- 测试、`使用说明.md`、`skills/agents-calling/SKILL.md` 同步。

**不做：**

- 不做失败/额度自动切换（fallback）。
- 不做设置页 UI。
- 不改 Claude 的自动选模型。
- 不改计划评审的显式 `reviewerModel` / `reviewerFinalModel` 语义（显式模型仍然优先）。
- 不引入用户级全局配置。

## Global Constraints

- Node.js >= 26；零第三方 npm 依赖。
- 只在 `feat/windows-support` 上改；不碰 `develop`；不引入 `src/`。
- 每个任务独立提交；不 push。
- 默认值必须与当前行为完全一致：现有 `model-policy.test.mjs` 不改断言即通过。
- `.sibyl/` 已在 `.gitignore` 中，因此 `.sibyl/models.json` 是本机配置，不提交。

## Review Focus

- 默认表必须逐条等价于现有 `chooseCodexModel`，不能悄悄换模型。
- 配置错误必须**大声失败**（worker 启动报错），不能静默回退到默认——静默回退会让用户以为改生效了。
- 不能让一个坏配置阻塞 `consult` 之外的所有工作却不说明原因；错误信息必须能定位字段。
- 显式 `model` 参数仍然压过路由表。
- 计划评审自己也在用 `model:"auto"`，路由表变化不能把它降级到弱模型（`review` + `high` 默认仍是 `gpt-6.1-sol` / `high`）。**项目配置也不能降级评审**：计划评审 worker 传 `useProjectPolicy:false`，显式使用默认表；只有 `reviewerModel` / `reviewerFinalModel` 能改。
- 不新增公共接口（MCP 工具、HTTP 端点、持久化字段）。
- **启动原子性不变式**：`workers.start` 中从最后一次租约/容量检查到 `records.set(record)` 之间**不得出现 `await`**。配置读取必须放在这些检查之前；否则两个并发启动会同时通过检查后各自登记，破坏租约与档位上限。

## 配置格式

`<project>/.sibyl/models.json`：

```json
{
  "version": 1,
  "codex": {
    "mechanical": {"model": "gpt-6-luna", "effort": "low"},
    "review": {
      "normal": {"model": "gpt-6.1-terra", "effort": "medium"},
      "high": {"model": "gpt-6.1-sol", "effort": "high"}
    },
    "implement": {
      "normal": {"model": "gpt-6.1-sol", "effort": "medium"},
      "high": {"model": "gpt-6.1-sol", "effort": "high"}
    },
    "frontier": {"model": "gpt-6-astra", "effort": "high"}
  }
}
```

规则：

- 顶层只允许 `version`、`codex`；`version` 必须是 `1`。
- `codex` 只允许 `mechanical`、`review`、`implement`、`frontier`。
- `mechanical` / `frontier` 是叶子对象；`review` / `implement` 必须按 `normal` / `high` 分档（可只写一档）。
- 叶子允许只写 `model` 或只写 `effort`；其余字段沿用默认。
- 文件不存在 → 用默认表；文件存在但非法 → 抛错。

## Task 1: 策略表与配置解析

**Files:**
- Modify: `model-policy.mjs`
- Test: `model-policy.test.mjs`

**Interfaces:**

- `DEFAULT_CODEX_POLICY`：`Object.freeze` 的完整默认表，形状与配置文件 `codex` 字段一致。
- `normalizeModelPolicy(value) -> policy`：校验并深合并到默认表；返回新对象，不修改默认表。
- `chooseCodexModel({tier, kind, risk, policy})`：`policy` 省略时用默认表；返回 `{model, effort, reason}`；命中非默认叶子的值来自 `policy` 时 `reason` 加 `project:` 前缀。
- 保留 `CODEX_MODELS` 导出，避免破坏现有调用。

- [x] **Step 1: 写失败测试**

在 `model-policy.test.mjs` 追加：

```js
import {DEFAULT_CODEX_POLICY, normalizeModelPolicy, chooseCodexModel} from './model-policy.mjs';

test('the default policy reproduces every current choice', () => {
  const cases = [
    [{tier: 'dispatch', kind: 'mechanical'}, {model: 'gpt-6-luna', effort: 'low', reason: 'mechanical'}],
    [{tier: 'consult', kind: 'review'}, {model: 'gpt-6.1-terra', effort: 'medium', reason: 'review'}],
    [{tier: 'consult', kind: 'review', risk: 'high'}, {model: 'gpt-6.1-sol', effort: 'high', reason: 'review-high-risk'}],
    [{tier: 'dispatch', kind: 'implement'}, {model: 'gpt-6.1-sol', effort: 'medium', reason: 'implement'}],
    [{tier: 'parallel', kind: 'implement', risk: 'high'}, {model: 'gpt-6.1-sol', effort: 'high', reason: 'implement-high-risk'}],
    [{kind: 'frontier'}, {model: 'gpt-6-astra', effort: 'high', reason: 'frontier'}]
  ];
  for (const [input, expected] of cases) assert.deepEqual(chooseCodexModel({...input, policy: DEFAULT_CODEX_POLICY}), expected);
});

test('a project policy overrides one leaf and leaves the rest intact', () => {
  const policy = normalizeModelPolicy({version: 1, codex: {implement: {normal: {model: 'gpt-6-luna'}}}});
  assert.deepEqual(chooseCodexModel({tier: 'dispatch', kind: 'implement', policy}),
    {model: 'gpt-6-luna', effort: 'medium', reason: 'project:implement'});
  assert.deepEqual(chooseCodexModel({tier: 'dispatch', kind: 'implement', risk: 'high', policy}),
    {model: 'gpt-6.1-sol', effort: 'high', reason: 'implement-high-risk'});
  assert.deepEqual(chooseCodexModel({tier: 'consult', kind: 'review', policy}),
    {model: 'gpt-6.1-terra', effort: 'medium', reason: 'review'});
});

test('an overridden effort alone keeps the default model', () => {
  const policy = normalizeModelPolicy({version: 1, codex: {review: {high: {effort: 'ultra'}}}});
  assert.deepEqual(chooseCodexModel({tier: 'consult', kind: 'review', risk: 'high', policy}),
    {model: 'gpt-6.1-sol', effort: 'ultra', reason: 'project:review-high-risk'});
});

test('invalid policy values are rejected with the offending key', () => {
  assert.throws(() => normalizeModelPolicy(null), /policy/i);
  assert.throws(() => normalizeModelPolicy({version: 2}), /version/i);
  assert.throws(() => normalizeModelPolicy({version: 1, codex: {unknown: {model: 'x'}}}), /unknown/);
  assert.throws(() => normalizeModelPolicy({version: 1, codex: {mechanical: {model: ''}}}), /mechanical\.model/);
  assert.throws(() => normalizeModelPolicy({version: 1, codex: {mechanical: {effort: 'max'}}}), /mechanical\.effort/);
  assert.throws(() => normalizeModelPolicy({version: 1, codex: {review: {model: 'x'}}}), /review/);
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `node --test model-policy.test.mjs`
Expected: FAIL（`DEFAULT_CODEX_POLICY` / `normalizeModelPolicy` 未导出）

- [x] **Step 3: 实现**

- 用今天的 6 组结果构造 `DEFAULT_CODEX_POLICY`。
- `normalizeModelPolicy` 逐层校验；深合并；返回冻结的新对象。
- `chooseCodexModel` 从 `policy` 取叶子；比较取到的值是否等于默认值，不一致时 `reason = 'project:' + reason`。
- 保留旧的 `reason` 取值。

- [x] **Step 4: 运行测试**

Run: `node --test model-policy.test.mjs`
Expected: PASS（含原有 6 个断言）

- [x] **Step 5: 提交**

```bash
git add model-policy.mjs model-policy.test.mjs
git commit -m "feat(model): make the Codex routing table configurable per project"
```

## Task 2: 工作方启动时读取项目策略

**Files:**
- Modify: `model-policy.mjs`（新增 `loadModelPolicy`）
- Modify: `workers.mjs`
- Modify: `plan-review.mjs`（`launch()` 传 `useProjectPolicy:false`）
- Test: `model-policy.test.mjs` + `worker-service.test.mjs` + `plan-review.test.mjs`

**Interfaces:**

- `loadModelPolicy(projectPath, {readFile = fs.readFile} = {}) -> Promise<{policy, configured}>`
  - `.sibyl/models.json` 不存在 → `{policy: DEFAULT_CODEX_POLICY, configured: false}`
  - 存在但 JSON 解析失败 → `Error('Invalid model policy: <path>: <reason>')`
  - 存在但校验失败 → 同上，带字段名
- `workers.mjs`：
  1. 在**租约/容量检查之前**（现有 `stagedPaths` 之后、`repositoryKey` 附近）读取一次项目策略：
     ```js
     const autoCodex = tool === 'codex' && (input.model ?? 'auto') === 'auto' && input.useProjectPolicy !== false;
     const modelPolicy = autoCodex ? await loadModelPolicy(projectPath) : null;
     ```
  2. 原 `auto` + `codex` 分支改为同步选择，使用 `input` 上的真实字段；`modelPolicy` 为 null 时回退默认表：
     ```js
     const choice = chooseCodexModel({tier, kind: input.kind ?? null, risk: input.risk ?? 'normal', policy: modelPolicy?.policy});
     model = choice.model;
     effort = input.effort ?? choice.effort;
     modelReason = choice.reason;
     ```
  3. 检查后到 `records.set(record)` 之间保持无 `await`；显式 `model` 分支与 `claude` 分支不变。
  4. `input.useProjectPolicy === false` 时跳过配置读取并使用默认表；`plan-review.mjs` 的 `launch()` 传 `useProjectPolicy: false`。

- 说明：`modelPolicy` 只在 `codex` + `auto` 时读取，因此配置损坏不会阻塞显式 `model` 或 Claude 工作方。

- [x] **Step 1: 写失败测试**

`model-policy.test.mjs`（纯加载器；路径断言必须同时包含文件路径与字段，不允许用「或」放过缺失路径的错误）：

```js
import {loadModelPolicy} from './model-policy.mjs';

test('a missing project policy falls back to defaults', async () => {
  const readFile = async () => { const e = Error('missing'); e.code = 'ENOENT'; throw e; };
  const result = await loadModelPolicy('C:/p', {readFile});
  assert.equal(result.configured, false);
  assert.deepEqual(result.policy, DEFAULT_CODEX_POLICY);
});

test('a project policy is loaded and marked configured', async () => {
  const readFile = async () => JSON.stringify({version: 1, codex: {mechanical: {model: 'gpt-6.1-terra'}}});
  const result = await loadModelPolicy('C:/p', {readFile});
  assert.equal(result.configured, true);
  assert.equal(chooseCodexModel({kind: 'mechanical', policy: result.policy}).model, 'gpt-6.1-terra');
});

test('a broken project policy fails loudly with its full path', async () => {
  const expected = join('C:/p', '.sibyl', 'models.json');
  const bad = async () => '{not json';
  await assert.rejects(() => loadModelPolicy('C:/p', {readFile: bad}),
    error => error.message.includes('Invalid model policy') && error.message.includes(expected));
  const invalid = async () => JSON.stringify({version: 2});
  await assert.rejects(() => loadModelPolicy('C:/p', {readFile: invalid}),
    error => error.message.includes(expected) && error.message.includes('version'));
});
```

（测试文件顶部加 `import {join} from 'node:path';`。）

`worker-service.test.mjs`（真实 git fixture + 真实 `.sibyl/models.json`，验证配置真的到达 worker 启动器）：

```js
test('a project policy changes the model the worker actually launches with', async () => {
  const f = await fixture();
  await mkdir(join(f.project, '.sibyl'), {recursive: true});
  await writeFile(join(f.project, '.sibyl', 'models.json'),
    JSON.stringify({version: 1, codex: {implement: {normal: {model: 'gpt-6-luna', effort: 'low'}}}}));
  const argsFile = join(f.root, 'args.json');
  process.env.FAKE_ARGS_FILE = argsFile;
  try {
    const started = await f.service.start({session: f.session, tool: 'codex', tier: 'dispatch', scope: ['src'], kind: 'implement'});
    assert.equal(started.model, 'gpt-6-luna');
    assert.equal(started.effort, 'low');
    assert.equal(started.modelReason, 'project:implement');
    const args = await wait(async () => { try { return JSON.parse(await readFile(argsFile, 'utf8')); } catch { return null; } });
    assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-luna');
  } finally { delete process.env.FAKE_ARGS_FILE; await f.cleanup(); }
});

test('an invalid project policy rejects an auto Codex start with the file and field', async () => {
  const f = await fixture();
  await mkdir(join(f.project, '.sibyl'), {recursive: true});
  await writeFile(join(f.project, '.sibyl', 'models.json'), JSON.stringify({version: 1, codex: {mechanical: {effort: 'max'}}}));
  try {
    await assert.rejects(
      () => f.service.start({session: f.session, tool: 'codex', tier: 'dispatch', scope: ['src'], kind: 'mechanical'}),
      error => error.message.includes(join(f.project, '.sibyl', 'models.json')) && error.message.includes('mechanical.effort'));
  } finally { await f.cleanup(); }
});

test('a broken policy does not block an explicit model or Claude auto', async () => {
  const f = await fixture();
  await mkdir(join(f.project, '.sibyl'), {recursive: true});
  await writeFile(join(f.project, '.sibyl', 'models.json'), '{not json');
  try {
    const explicit = await f.service.start({session: f.session, tool: 'codex', tier: 'consult', model: 'gpt-6-luna'});
    assert.equal(explicit.model, 'gpt-6-luna');
    const claude = await f.service.start({session: f.session, tool: 'claude', tier: 'consult', model: 'auto'});
    assert.equal(claude.model, null);
  } finally { await f.cleanup(); }
});

test('concurrent auto starts cannot both pass the lease check', async () => {
  const f = await fixture();
  await mkdir(join(f.project, '.sibyl'), {recursive: true});
  await writeFile(join(f.project, '.sibyl', 'models.json'),
    JSON.stringify({version: 1, codex: {implement: {normal: {model: 'gpt-6-luna'}}}}));
  try {
    const results = await Promise.allSettled([
      f.service.start({session: f.session, tool: 'codex', tier: 'parallel', scope: ['src']}),
      f.service.start({session: f.session, tool: 'codex', tier: 'parallel', scope: ['src/a.txt']})
    ]);
    const rejected = results.filter(r => r.status === 'rejected');
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /路径租约冲突/);
  } finally { await f.cleanup(); }
});

test('concurrent auto starts cannot both pass the per-session capacity check', async () => {
  const f = await fixture('write', {parallel: {maxLivePerSession: 1}});
  await mkdir(join(f.project, '.sibyl'), {recursive: true});
  await writeFile(join(f.project, '.sibyl', 'models.json'),
    JSON.stringify({version: 1, codex: {implement: {normal: {model: 'gpt-6-luna'}}}}));
  try {
    const results = await Promise.allSettled([
      f.service.start({session: f.session, tool: 'codex', tier: 'parallel', scope: ['src']}),
      f.service.start({session: f.session, tool: 'codex', tier: 'parallel', scope: ['docs']})
    ]);
    const rejected = results.filter(r => r.status === 'rejected');
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /该会话同时最多 1 个工作方/);
  } finally { await f.cleanup(); }
});

test('a worker started with useProjectPolicy false ignores the project policy', async () => {
  const f = await fixture();
  await mkdir(join(f.project, '.sibyl'), {recursive: true});
  await writeFile(join(f.project, '.sibyl', 'models.json'),
    JSON.stringify({version: 1, codex: {review: {high: {model: 'gpt-6-luna'}}}}));
  try {
    const started = await f.service.start({session: f.session, tool: 'codex', tier: 'consult', kind: 'review', risk: 'high', useProjectPolicy: false});
    assert.equal(started.model, 'gpt-6.1-sol');
    assert.equal(started.modelReason, 'review-high-risk');
  } finally { await f.cleanup(); }
});

test('useProjectPolicy false skips even a broken policy', async () => {
  const f = await fixture();
  await mkdir(join(f.project, '.sibyl'), {recursive: true});
  await writeFile(join(f.project, '.sibyl', 'models.json'), '{not json');
  try {
    const started = await f.service.start({session: f.session, tool: 'codex', tier: 'consult', kind: 'review', risk: 'high', useProjectPolicy: false});
    assert.equal(started.model, 'gpt-6.1-sol');
  } finally { await f.cleanup(); }
});

test('nothing awaits between the lease checks and registering the worker', async () => {
  const source = await readFile(new URL('./workers.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const repositoryKey = projectKey(projectPath);');
  const end = source.indexOf('records.set(id, record)', start);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /\bawait\b/);
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `node --test model-policy.test.mjs worker-service.test.mjs`
Expected: FAIL（`loadModelPolicy` 未导出；worker 级用例未接配置）

- [x] **Step 3: 实现**

- `loadModelPolicy` 读 `<projectPath>/.sibyl/models.json`，ENOENT → 默认；其余错误包装后抛出，消息包含完整文件路径。
- `workers.mjs`：把 `await loadModelPolicy` 放在 **`stagedPaths` 之后、租约检查之前**；模型选择保持同步；确认检查到 `records.set` 之间没有新增 `await`。只改 `auto` + `codex` 分支。

- [x] **Step 4: 运行测试**

Run:
`"/d/LXY_workspace/AI Bridge/.tools/node26/node-v26.13.0-win-x64/node.exe" --test model-policy.test.mjs worker-service.test.mjs worker-tool.test.mjs worker-daemon.test.mjs tiers.test.mjs`
Expected: PASS

再跑全量：

`"/d/LXY_workspace/AI Bridge/.tools/node26/node-v26.13.0-win-x64/node.exe" --test --test-concurrency=1 --test-timeout=30000 *.test.mjs`
Expected: 0 fail（允许既有 skip）

- [x] **Step 5: 提交**

```bash
git add model-policy.mjs workers.mjs plan-review.mjs model-policy.test.mjs worker-service.test.mjs plan-review.test.mjs
git commit -m "feat(worker): route Codex workers through the project model policy"
```

## Task 3: 文档同步

**Files:**
- Modify: `使用说明.md`（§模型选择）
- Modify: `skills/agents-calling/SKILL.md`（模型选择段）

**内容：**

- 说明默认表与今天一致。
- 给出 `.sibyl/models.json` 示例和“只写需要覆盖的叶子”规则。
- 说明优先级：显式 `model` > 项目配置 > 默认表；显式 `effort` 始终覆盖。
- 说明 `.sibyl/` 被 gitignore，该配置仅本机生效。
- 说明配置非法时 worker 启动会报错，不会静默回退。

- [x] **Step 1: 改两处文档**
- [x] **Step 2: 运行全量测试（文档不改代码，确认无回归）**
- [x] **Step 3: 提交**

```bash
git add 使用说明.md skills/agents-calling/SKILL.md
git commit -m "docs(model): document the per-project routing table"
```

## 验收标准

- 不写 `.sibyl/models.json` 时，6 种组合的结果与今天逐字一致。
- 只覆盖 `implement.normal.model` 时，`implement.normal` 用新模型 + 默认 effort，其余档位不变。
- 显式 `model` 参数仍然优先于配置表。
- 配置非法时 `bridge_worker_start` 返回明确错误，包含文件路径和字段名。
- `consult` 计划评审默认仍是 `gpt-6.1-sol` / `high`。
- Claude 工作方 `auto` 行为不变（`model=null`，`modelReason='claude-default'`）。
- 全量测试 0 fail。

## 已知限制（本计划之外）

- 不做失败/额度 fallback。
- 不做 UI 配置。
- 不支持用户级（跨项目）配置。
- 配置只在 worker 启动时读取；worker 运行中改配置不生效。
- 不做模型可用性探测；写错的模型名在当前流程里仍能进入启动阶段，失败点与显式 `model` 相同。
- 计划评审不走项目路由表；它的模型只能通过计划评审配置修改。

## Codex review

### 第 1 轮（2026-11-09）

- 模型：`auto` → `review` / `high`（`gpt-6.1-sol`，effort high），只读 consult worker。
- Verdict：`changes-required`。3 个 major，无 blocker。

| ID | 问题 | 采纳与修订 |
|---|---|---|
| R1 | `await loadModelPolicy` 放在租约/容量检查之后，会把检查到登记的同步区间切开，两个并发启动可能都通过检查 | 采纳。配置读取移到租约检查之前；补「并发 auto 启动只有 1 个成功」的测试 |
| R2 | 接线示例使用未定义的 `kind` / `risk`，会触发 ReferenceError | 采纳。改为 `input.kind ?? null`、`input.risk ?? 'normal'` |
| R3 | Task 2 测试只测加载器，没有证明配置真正影响 worker；错误断言允许缺少路径 | 采纳。补 worker 级集成测试（launcher 收到 `--model`、坏配置拒绝 auto、坏配置不阻塞显式模型与 Claude）；路径断言改为必须同时包含文件路径与字段 |

**未采纳**：无。评审提出的 `spawn EPERM` 是 Codex 沙箱限制，不影响本计划。

### 第 2 轮（2026-11-09）

- Verdict：**`approve`**。无 blocker/major；2 个 minor，均为测试验证缺口。
- R1（minor）：并发测试只数成功/失败，没确认拒绝来自租约；补容量并发用例，且不要带 `prompt`（带 prompt 的 worker 会很快结束释放租约）。→ 采纳：改为两个并发用例，分别断言「路径租约冲突」和「该会话同时最多 1 个工作方」。
- R2（minor）：错误断言仍允许缺少完整路径。→ 采纳：校验错误与语法错误都断言 `join(projectPath, '.sibyl', 'models.json')` 全路径 + 具体字段/原因。

### 第 3 轮（2026-11-09，最终版复审）

- Verdict：`discuss`。
- R1（major）：项目配置可以覆盖 `review.high.model`，计划评审的 `auto` 会直接采用它，等于配置文件能悄悄降级评审门禁。提出 Q1：F5 是否也约束项目覆盖？
  - **人决定**：保护计划评审。计划评审 worker 不受项目路由表影响，`reviewerModel` / `reviewerFinalModel` 仍可显式改。
- R2（minor）：并发测试没有控制读取时序，不能稳定捕获「检查后又加 `await`」的回归。
  - **采纳**：新增源码级断言——从 `checkWorkerCapacity` 到 `records.set(id, record)` 之间不得出现 `await`。
- 实现：`workers.mjs` 增加 `useProjectPolicy === false` 分支；`plan-review.mjs` 的 `launch()` 传 `useProjectPolicy:false`；新增两个测试（项目策略被忽略、检查到登记无 `await`）。

### 第 4 轮（2026-11-09）

- Verdict：`changes-required`。3 条都指向**计划文档与提交清单**，实现代码本身正确。
- R1（major）：Task 2 没把 `plan-review.mjs` / `plan-review.test.mjs` 纳入文件清单和 `git add`，按计划执行会漏掉评审保护。→ 采纳：补齐文件清单、提交命令、Architecture 与 frontmatter 的 `files`。
- R2（minor）：接线示例仍读 `modelPolicy.policy`，跳过后为 null 会抛错。→ 采纳：示例改为 `modelPolicy?.policy`，并补「跳过读取时坏配置也能启动」的用例。
- R3（minor）：无 `await` 断言只覆盖容量检查到登记。→ 采纳：断言范围扩大到 `const repositoryKey = projectKey(projectPath);` 到 `records.set(id, record)`，覆盖全部租约检查。

## 实施结果（2026-11-09）

- `0e89876` Task 1：默认路由表、`normalizeModelPolicy`、`loadModelPolicy`、13 个单元测试。
- `1feaead` Task 2：`workers.mjs` 在租约/容量检查之前读取项目策略；5 个 worker 级集成/并发测试。
- `1e43046` Task 3：`使用说明.md` 与 `skills/agents-calling/SKILL.md` 同步。
- 全量测试：275 项，270 通过 / 0 失败 / 5 跳过（Windows 符号链接权限与平台跳过）。
- 未 push。

<!-- SIBYL_REVIEW_BEGIN -->
## Codex review

- 状态：approved
- 结论：未发现需要阻止实施的 blocker/major；存在两处测试缺口。策略单测 13 项通过，worker 与评审集成测试因只读约束未运行。
- 评审模型：codex
- 轮次：1
- 采纳：
- 残留风险：
<!-- SIBYL_REVIEW_END -->
