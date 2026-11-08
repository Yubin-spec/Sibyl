# Phase B：三档、租约、快照与交工报告 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「派活 / 分头干」做成 daemon 持有的真实工作方：路径租约、共享文件边界、派活前快照、结构化交工报告、按档位时间预算，并用一个 Skill 在三档之间自动选择。

**Architecture:** 新增 5 个根目录模块：`path-scope.mjs`（scope 归一化、重叠、共享文件）、`worker-worktree.mjs`（git worktree + 快照 commit）、`worker-policy.mjs`（工作方系统提示与交工报告协议）、`worker-report.mjs`（从 git 取文件清单/diff，合并自报内容）、`workers.mjs`（工作方生命周期：启动、轮次、看门狗、交工、租约）。`control.mjs` 在 daemon 进程里创建这个服务，`native-inbox.mjs` 增加 `/worker/*` 与 `/lease/check` 端点（沿用会话租约鉴权），`native-mcp.mjs` 只做转发。工具由 `bridge_spawn*` 改名为 `bridge_worker_*`，并新增 `bridge_lease_check`。`consult-policy.mjs` 增加独立的 dispatch / parallel 预算。

**Tech Stack:** Node.js >= 26、`node:test`、`node:sqlite`（已有）、git CLI（2.53 已在 Windows 验证）、零第三方 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-11-08-agent-collaboration-design.md`

## Global Constraints

- Node >= 26；不新增任何 npm 依赖。
- 只在 `feat/windows-support` 的扁平布局上改；不碰 `develop`，不引入 `src/`。
- 测试必须用 Node 26：`NODE26="/d/LXY_workspace/AI Bridge/.tools/node26/node-v26.13.0-win-x64/node.exe"`，命令 `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 *.test.mjs`。PATH 上的 node 22 会让 `browser.test.mjs` 失败。
- 工作方只能是 `workspace-write`；只读问答默认 `bridge_ask` 原会话（可见），`bridge_consult` 只作人同意后的后台只读核对；永远不提供 `danger-full-access`。
- daemon 只允许在 `sibyl/worker/<workerId>` 分支上提交；主导方分支与历史一律不动。
- 工作树在 `<project>/.sibyl/worktrees/<workerId>`，报告在 `<project>/.sibyl/reports/<workerId>.{patch,json}`；`.sibyl/` 加入 `.gitignore`。
- 工具返回只带摘要、文件清单、路径；完整 diff 只落盘，绝不进工具输出。
- 工作方无网络、不装依赖；Codex 在 Windows 沙箱内无法创建子进程，自验失败要作为阻塞项出现在报告里，由主导方在沙箱外验收。
- 测试文件放仓库根目录 `*.test.mjs`；git 相关测试自己创建临时仓库并显式传 `-c user.name/-c user.email`。
- 长轮次一律异步：`worker_turn` 只入队并立即返回 `{turnId,status:'running',accepted:true}`；等待用 `worker_result`（每次 ≤25 秒）。任何 HTTP 端点都不许等一整轮。
- 收工顺序固定：取消 setup → 禁止新轮次 → 关子进程并等到 `close` 事件 → 冻结交付内容 → 写报告 → 释放租约。`finalize` 只允许一个 promise，所有路径共用。
- 只有 scope 内、非共享、非符号链接/子模块的改动进入 `<workerId>.deliverable.patch`；越界改动只进全量 `<workerId>.patch`，并把交工标成不可交付。
- daemon 首次派活时把 `/.sibyl/` 幂等写入 `.git/info/exclude`，不依赖项目自己的 `.gitignore`。
- 本计划属于「大计划」：执行前必须已完成 Codex 评审，且评审对话在 Codex 原会话里可见（见文末 `## Codex review`）；评审意见未处理完不得开始 Task 1。
- 「问一下」默认走 `bridge_ask` 到 Codex 原会话，保证讨论出现在 Codex 聊天列表；`bridge_consult` 只作人明确同意后的后台只读核对。

## Review Focus

- **共享文件藏在目录 scope 里**：`scope:['.']`、`scope:['.claude']` 或 scope 覆盖到 `package.json` 必须在建工作树之前拒绝；`src/a` 与 `src/a2` 不能被误判为重叠。
- **快照泄漏或被写进主导方分支**：被 ignore 的文件（`.env`、`node_modules`）不得复制；主导方 `HEAD` 与 `git status` 在派活前后必须不变。
- **工作方自报与 git 不符**：文件清单和 diff 永远从 git 计算；工作方谎报、或根本没输出报告块，验收信息仍必须真实。
- **工作方越界改文件**：改动路径不在声明 scope 内时，报告必须列出 `outOfScope` 并标记 `needsReview`。
- **重启或超时留下活的工作方与租约**：daemon 重启后旧记录标为 `interrupted`、租约不再占用；超时由对应档位的预算停止，而不是 consult 的 180 秒。

---

### Task 1: 按档位的时间预算与模型选择

**Files:**
- Modify: `consult-policy.mjs`
- Create: `model-policy.mjs`
- Test: `consult-policy.test.mjs`
- Test: `model-policy.test.mjs`

**Interfaces:**
- Consumes: 现有 `DEFAULT_CONSULT_LIMITS`、`checkProgress`。
- Produces:
  - `DEFAULT_WORKER_LIMITS` —— `{consult:{...},dispatch:{...},parallel:{...}}`。
  - `normalizeWorkerLimits(value={}) -> {consult,dispatch,parallel}`，非法值抛 `Invalid worker limit: <key>`，未知档位抛 `Invalid worker limit tier: <name>`。
  - `workerTurnTimeoutMs(tier) -> number`：`consult`/`dispatch`/`parallel` 都是 600000，其他抛 `tier must be consult, dispatch or parallel`。`bridge_consult`（后台只读核对）继续用 `DEFAULT_CONSULT_LIMITS` 的 180000，不受影响。
  - `checkWorkerCapacity(records,{sourceSessionId,projectPath,tier,now,limits}) -> {allow:true,...} | {allow:false,reason:'live-session'|'live-project'|'budget',...}`。
  - 预算数值：consult `15min / 10min / 12 每小时 / 每会话 2 / 每项目 3`；dispatch `30min / 15min / 6 每小时 / 每会话 1 / 每项目 2`；parallel `60min / 15min / 10 每小时 / 每会话 3 / 每项目 4`。
  - `model-policy.mjs`：`CODEX_MODELS`、`chooseCodexModel({tier='consult',kind=null,risk='normal'}) -> {model,effort,reason}`。`kind=null` 时按 tier 取默认（consult→review，dispatch/parallel→implement）；未知 `kind`/`risk` 抛错，不做静默回退。映射见 Step 5；`model:'auto'` 由它解析，显式 `model` 覆盖。

- [ ] **Step 1: 写失败测试**

在 `consult-policy.test.mjs` 追加：

```js
import {DEFAULT_WORKER_LIMITS,normalizeWorkerLimits,workerTurnTimeoutMs,checkWorkerCapacity} from './consult-policy.mjs';

test('worker tiers do not reuse the consult budget',()=>{
  const limits=normalizeWorkerLimits();
  assert.equal(limits.consult.maxDurationMs,15*60*1000);
  assert.equal(limits.consult.maxLivePerSession,2);
  assert.equal(limits.dispatch.maxDurationMs,30*60*1000);
  assert.equal(limits.dispatch.noProgressMs,15*60*1000);
  assert.equal(limits.dispatch.maxLivePerSession,1);
  assert.equal(limits.parallel.maxDurationMs,60*60*1000);
  assert.equal(limits.parallel.maxLivePerSession,3);
  assert.notEqual(limits.dispatch.maxDurationMs,180000);
  assert.notEqual(limits.dispatch.noProgressMs,120000);
  assert.equal(workerTurnTimeoutMs('consult'),600000);
  assert.equal(workerTurnTimeoutMs('dispatch'),600000);
  assert.throws(()=>workerTurnTimeoutMs('unknown'),/tier must be consult, dispatch or parallel/);
});

test('invalid worker limits are rejected',()=>{
  assert.throws(()=>normalizeWorkerLimits({dispatch:{maxPerWindow:0}}),/Invalid worker limit: maxPerWindow/);
  assert.throws(()=>normalizeWorkerLimits({parallel:{maxDurationMs:1.5}}),/Invalid worker limit: maxDurationMs/);
  assert.throws(()=>normalizeWorkerLimits({meeting:{}}),/Invalid worker limit tier: meeting/);
});

const worker=(id,over={})=>({id,sourceSessionId:'s',projectPath:'/p',status:'running',startedAt:new Date().toISOString(),...over});

test('a dispatch session may have only one live worker',()=>{
  const limits=normalizeWorkerLimits();
  const records=[worker('a'),worker('b')];
  const blocked=checkWorkerCapacity(records,{sourceSessionId:'s',projectPath:'/p',tier:'dispatch',now:Date.now(),limits:limits.dispatch});
  assert.equal(blocked.allow,false);
  assert.equal(blocked.reason,'live-session');
  const single=checkWorkerCapacity([worker('a')],{sourceSessionId:'s',projectPath:'/p',tier:'dispatch',now:Date.now(),limits:limits.dispatch});
  assert.equal(single.allow,false);
  assert.equal(checkWorkerCapacity([],{sourceSessionId:'s',projectPath:'/p',tier:'dispatch',now:Date.now(),limits:limits.dispatch}).allow,true);
});

test('parallel capacity counts live workers per project',()=>{
  const limits=normalizeWorkerLimits().parallel;
  const records=[worker('a',{sourceSessionId:'other',projectPath:'/p'}),worker('b',{sourceSessionId:'other',projectPath:'/p'}),worker('c',{sourceSessionId:'other',projectPath:'/p'}),worker('d',{sourceSessionId:'other',projectPath:'/p'})];
  const city=checkWorkerCapacity(records,{sourceSessionId:'s',projectPath:'/p',tier:'parallel',now:Date.now(),limits});
  assert.equal(city.reason,'live-project');
  assert.equal(checkWorkerCapacity(records.slice(0,3),{sourceSessionId:'s',projectPath:'/p',tier:'parallel',now:Date.now(),limits}).allow,true);
});

test('the rolling window budget stops runaway dispatch',()=>{
  const limits={...normalizeWorkerLimits().dispatch,maxPerWindow:2};
  const now=Date.now();
  const records=[worker('a',{status:'completed',startedAt:new Date(now-1000).toISOString()}),worker('b',{status:'completed',startedAt:new Date(now-2000).toISOString()})];
  const result=checkWorkerCapacity(records,{sourceSessionId:'s',projectPath:'/p',tier:'dispatch',now,limits});
  assert.equal(result.allow,false);
  assert.equal(result.reason,'budget');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 consult-policy.test.mjs`
Expected: FAIL，导入的 `DEFAULT_WORKER_LIMITS` 等不是有效导出。

- [ ] **Step 3: 实现**

在 `consult-policy.mjs` 追加：

```js
export const DEFAULT_WORKER_LIMITS = Object.freeze({
  consult: Object.freeze({maxDurationMs:15*60*1000,noProgressMs:10*60*1000,windowMs:60*60*1000,maxPerWindow:12,maxLivePerSession:2,maxLivePerProject:3}),
  dispatch: Object.freeze({maxDurationMs:30*60*1000,noProgressMs:15*60*1000,windowMs:60*60*1000,maxPerWindow:6,maxLivePerSession:1,maxLivePerProject:2}),
  parallel: Object.freeze({maxDurationMs:60*60*1000,noProgressMs:15*60*1000,windowMs:60*60*1000,maxPerWindow:10,maxLivePerSession:3,maxLivePerProject:4})
});
export function normalizeWorkerLimits(value={}){ /* 每个档位只允许 DEFAULT_WORKER_LIMITS 的键；整数且 >= 1；未知档位报错 */ }
export function workerTurnTimeoutMs(tier){ /* consult/dispatch/parallel 都是 600000；其余抛错 */ }
export function checkWorkerCapacity(records,{sourceSessionId,projectPath,tier,now,limits}){ /* 见测试：先 live-session，再 live-project，再 budget */ }
```

判定顺序固定：`live-session` → `live-project` → `budget`；`live` 只算 `starting`/`running`；`budget` 用 `startedAt` 落在 `windowMs` 内按 `sourceSessionId` 计数（复用 `started()` 的解析方式）。

- [ ] **Step 4: 跑预算测试确认通过**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 consult-policy.test.mjs`
Expected: PASS，原有用例 + 4 个新用例全过。

- [ ] **Step 5: 写失败测试 `model-policy.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {CODEX_MODELS,chooseCodexModel} from './model-policy.mjs';

test('the advertised Codex models are known',()=>{
  for(const m of ['gpt-6.1-sol','gpt-6-astra','gpt-6.1-terra','gpt-6-luna'])assert.ok(CODEX_MODELS.includes(m),m);
});

test('mechanical work uses the cheap fast model',()=>{
  assert.deepEqual(chooseCodexModel({tier:'dispatch',kind:'mechanical'}),{model:'gpt-6-luna',effort:'low',reason:'mechanical'});
});

test('normal review uses the balanced model, high-risk review escalates',()=>{
  assert.deepEqual(chooseCodexModel({tier:'consult',kind:'review'}),{model:'gpt-6.1-terra',effort:'medium',reason:'review'});
  assert.deepEqual(chooseCodexModel({tier:'consult',kind:'review',risk:'high'}),{model:'gpt-6.1-sol',effort:'high',reason:'review-high-risk'});
});

test('implementation uses the workhorse at medium and escalates by risk',()=>{
  assert.deepEqual(chooseCodexModel({tier:'dispatch',kind:'implement'}),{model:'gpt-6.1-sol',effort:'medium',reason:'implement'});
  assert.deepEqual(chooseCodexModel({tier:'parallel',kind:'implement',risk:'high'}),{model:'gpt-6.1-sol',effort:'high',reason:'implement-high-risk'});
});

test('frontier work alone uses Astra',()=>{
  assert.deepEqual(chooseCodexModel({kind:'frontier'}),{model:'gpt-6-astra',effort:'high',reason:'frontier'});
});

test('tier picks a sensible default kind and unknown values are rejected',()=>{
  assert.equal(chooseCodexModel({tier:'consult'}).model,'gpt-6.1-terra');
  assert.equal(chooseCodexModel({tier:'dispatch'}).model,'gpt-6.1-sol');
  assert.throws(()=>chooseCodexModel({kind:'unknown'}),/kind must be review, implement, mechanical or frontier/);
  assert.throws(()=>chooseCodexModel({risk:'unknown'}),/risk must be normal or high/);
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 model-policy.test.mjs`
Expected: FAIL，`Cannot find module ./model-policy.mjs`。

- [ ] **Step 7: 实现 `model-policy.mjs`**

```js
export const CODEX_MODELS=Object.freeze(['gpt-6.1-sol','gpt-6-astra','gpt-6.1-terra','gpt-6-sol','gpt-6-luna','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna']);
export function chooseCodexModel({tier='consult',kind=null,risk='normal'}={}){
  const k=kind??(tier==='consult'?'review':'implement');
  if(!['review','implement','mechanical','frontier'].includes(k))throw Error('kind must be review, implement, mechanical or frontier');
  if(!['normal','high'].includes(risk))throw Error('risk must be normal or high');
  if(k==='mechanical')return {model:'gpt-6-luna',effort:'low',reason:'mechanical'};
  if(k==='frontier')return {model:'gpt-6-astra',effort:'high',reason:'frontier'};
  if(k==='review')return risk==='high'
    ? {model:'gpt-6.1-sol',effort:'high',reason:'review-high-risk'}
    : {model:'gpt-6.1-terra',effort:'medium',reason:'review'};
  return risk==='high'
    ? {model:'gpt-6.1-sol',effort:'high',reason:'implement-high-risk'}
    : {model:'gpt-6.1-sol',effort:'medium',reason:'implement'};
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 model-policy.test.mjs`
Expected: PASS，6 个用例全过。

- [ ] **Step 9: 提交**

```bash
git add consult-policy.mjs consult-policy.test.mjs model-policy.mjs model-policy.test.mjs
git commit -m "feat(worker): choose a Codex model per task"
```

---

### Task 2: 路径 scope、共享文件与租约冲突

**Files:**
- Create: `path-scope.mjs`
- Test: `path-scope.test.mjs`

**Interfaces:**
- Consumes: `normalizedPath`（`project-path.mjs`）。
- Produces:
  - `DEFAULT_SHARED_FILES: string[]`。
  - `normalizeScope(paths: string[]) -> string[]`。
  - `pathWithin(scopeEntry: string, target: string) -> boolean`（按路径段边界）。
  - `scopeOverlaps(a: string[], b: string[]) -> boolean`。
  - `isSharedPath(path: string, {extra?: string[]} = {}) -> boolean`。
  - `scopeSharedConflicts(scope: string[], {extra?: string[]} = {}) -> string[]`。
  - `findLeaseConflict(leases: {leaseId?,repositoryKey?,workerId,scope}[], scope: string[], {repositoryKey?} = {}) -> {workerId,leaseId?,path}|null`；只比较 `repositoryKey` 相同（或任一方未提供）的租约。
  - `checkPaths(paths: string[], leases, {sharedExtra?,repositoryKey?} = {}) -> {allowed,blocked:[{path,workerId,leaseId?}],shared:string[],invalid:string[]}`。

共享文件内置集合：`package.json`、`package-lock.json`、`npm-shrinkwrap.json`、`yarn.lock`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`bun.lock`、`bun.lockb`、`tsconfig.json`、`jsconfig.json`、`.npmrc`、`.nvmrc`、`.node-version`、`lerna.json`、`nx.json`、`turbo.json`、`.editorconfig`；另有 `tsconfig.*.json` / `jsconfig.*.json` 模式，和目录前缀 `.github/`、`.vscode/`、`.claude/`、`.codex/`。

scope 拒绝：非数组、空数组、超过 64 项、非字符串、空串、超 1024 字符、绝对路径（`/` 或 `X:` 开头）、任何 `..` 段、`.`、`.git`、`.sibyl`。

- [ ] **Step 1: 写失败测试 `path-scope.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_SHARED_FILES,normalizeScope,pathWithin,scopeOverlaps,isSharedPath,scopeSharedConflicts,findLeaseConflict,checkPaths} from './path-scope.mjs';

test('scope is normalized and dangerous paths are refused',()=>{
  assert.deepEqual(normalizeScope(['./src\\api/','docs']),['src/api','docs']);
  for(const bad of [[],['./'],['/etc'],['C:/x'],['../x'],['src/../x'],['.git'],['.sibyl'],[''],123])
    assert.throws(()=>normalizeScope(bad),/scope must be a non-empty array|Invalid scope path/);
});

test('overlap respects path segment boundaries',()=>{
  assert.equal(pathWithin('src/a','src/a/b.txt'),true);
  assert.equal(scopeOverlaps(['src/a'],['src/a/b']),true);
  assert.equal(scopeOverlaps(['src/a'],['src/ab']),false);
  assert.equal(scopeOverlaps(['src/a'],['docs']),false);
});

test('shared files are recognized by name, pattern and directory',()=>{
  for(const p of ['package.json','web/package-lock.json','tsconfig.build.json','.claude/settings.local.json'])
    assert.equal(isSharedPath(p),true,p);
  assert.equal(isSharedPath('src/index.mjs'),false);
  assert.equal(isSharedPath('config/app.json',{extra:['config']}),true);
  assert.ok(DEFAULT_SHARED_FILES.includes('package.json'));
});

test('a scope may not cover a shared file or directory',()=>{
  assert.deepEqual(scopeSharedConflicts(['package.json']),['package.json']);
  assert.deepEqual(scopeSharedConflicts(['.claude']),['.claude']);
  assert.deepEqual(scopeSharedConflicts(['.']).length>0,true); // '.' 本身在 normalizeScope 里已拒绝，这里直接传入也必须有冲突
  assert.deepEqual(scopeSharedConflicts(['src']),[]);
  assert.deepEqual(scopeSharedConflicts(['config'],{extra:['config/keys.json']}),['config/keys.json']);
});

test('live leases expose their owner and block overlapping scopes',()=>{
  const leases=[{workerId:'w1',leaseId:'l1',repositoryKey:'r1',scope:['src/a']}];
  assert.deepEqual(findLeaseConflict(leases,['src/a/x'],{repositoryKey:'r1'}),{workerId:'w1',leaseId:'l1',path:'src/a'});
  assert.equal(findLeaseConflict(leases,['src/ab'],{repositoryKey:'r1'}),null);
  assert.equal(findLeaseConflict(leases,['src/a/x'],{repositoryKey:'r2'}),null,'independent repositories must not collide');
  const checks=checkPaths(['src/a/x','docs/y'],leases,{repositoryKey:'r1'});
  assert.equal(checks.allowed,false);
  assert.deepEqual(checks.blocked,[{path:'src/a/x',workerId:'w1',leaseId:'l1'}]);
  assert.equal(checkPaths(['package.json'],[]).shared.length,1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 path-scope.test.mjs`
Expected: FAIL，`Cannot find module ./path-scope.mjs`。

- [ ] **Step 3: 实现 `path-scope.mjs`**

要点：所有比较走 `normalizedPath`（Windows 大小写不敏感）但返回值保留原样；`pathWithin` 用段边界前缀；`scopeSharedConflicts` 对每个 scope 项检查（a）自身是否共享路径（含共享目录前缀），（b）任一内置共享文件是否在它内部；`checkPaths` 对每个待查路径分别找租约冲突，并标出共享文件。防御性处理：即使调用方绕过 `normalizeScope` 传入 `.`，`scopeSharedConflicts` 也必须返回全部内置共享文件（`.` 覆盖一切），不能返回空数组。

- [ ] **Step 4: 跑测试确认通过**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 path-scope.test.mjs`
Expected: PASS，5 个用例全过。

- [ ] **Step 5: 提交**

```bash
git add path-scope.mjs path-scope.test.mjs
git commit -m "feat(worker): enforce path scopes and shared-file ownership"
```

---

### Task 3: 工作树与派活前快照

**Files:**
- Create: `worker-worktree.mjs`
- Test: `worker-worktree.test.mjs`

**Interfaces:**
- Consumes: `canonicalProjectPath`（`project-path.mjs`）。
- Produces:
  - `isGitRepository(projectPath) -> Promise<boolean>`；只认仓库根目录。
  - `readSharedFiles(projectPath) -> Promise<string[]>`：内置集合 + `<project>/.sibyl/shared-files.json` 的 `{add?:string[],remove?:string[]}`。
  - `createWorkerWorktree({projectPath, workerId, branchPrefix='sibyl/worker', scope=[], onBeforeCopy}) -> Promise<{worktreePath,branch,baseCommit,snapshotCommit,snapshotFiles,copied,deleted,skipped,leadDigest}>`；`skipped` 形如 `{ignoredTracked:[],symlinks:[],submodules:[]}`；`leadDigest` 与 `scopeFingerprint` 同形，直接作为主导方改动基线。
  - `snapshotFingerprint(projectPath, files) -> Promise<{files:Record<string,string>,digest:string}>`：按 `path\0sha256(content)` 排序后求 digest。
  - `ensureSibylExcluded(projectPath) -> Promise<void>`：用 `git rev-parse --git-path info/exclude` 定位（linked worktree 里 `.git` 是文件），幂等写入 `/.sibyl/`。
  - `commitWorktree(worktreePath, message, {branch, snapshotCommit}) -> Promise<string|null>`：提交前断言当前分支等于 `branch`、`snapshotCommit` 是 HEAD 的祖先，否则抛 `Worker worktree is not on the expected branch or snapshot`；无改动返回 null。
  - `worktreeStatus(worktreePath) -> Promise<string>`。
  - `removeWorkerWorktree({projectPath, branch, worktreePath}) -> Promise<void>`：先校验 `worktreePath` 位于 `<project>/.sibyl/worktrees/` 且 branch 以 `sibyl/worker/` 开头。
  - `listRefs(projectPath) -> Promise<Record<string,string>>`（`git for-each-ref --format=%(refname) %(objectname)`）。
  - `stagedPaths(projectPath) -> Promise<string[]>`（`git diff --cached --name-only -z`）。
  - `refChanges(before, after, {ignore?: string[]} = {}) -> string[]`。
  - `scopeFingerprint(projectPath, scope) -> Promise<{files:Record<string,string>,truncated:boolean}>` 与 `fingerprintChanges(before, after) -> string[]`（Task 6 用）。

约定：
- 工作树路径 `<project>/.sibyl/worktrees/<workerId>`；分支 `sibyl/worker/<workerId>`。
- 建树前先 `assertSupportedRepository`：非 git、非仓库根、无提交、存在 `.gitmodules` 或 `git ls-files --stage` 里出现 mode `160000`（子模块）都在建树前拒绝；目标分支已存在（`git show-ref --verify`）也拒绝，避免 `sibyl` / `sibyl/worker` 的 ref 目录冲突。
- 快照复制前后各算一次 `snapshotFingerprint(projectPath, 快照集合)`；HEAD/status 不变但内容变了也要能发现。两次 digest 不同就删除本次工作树并重试一次（`onBeforeCopy` 是测试钩子，生产不传）；仍不同则抛 `Lead workspace changed during snapshot; retry dispatch`。
- `leadDigest` 从成功那一轮的 `snapshotFingerprint.files` 里按 scope 过滤得到，和快照使用同一份内容基线。
- 快照清单分三份取，避免把 ignored 文件带进来：
  - `tracked = git ls-files -z --cached`
  - `trackedIgnored = git ls-files -z --cached --ignored --exclude-standard`
  - `untracked = git ls-files -z --others --exclude-standard`
  - 快照集合 = `tracked - trackedIgnored + untracked`，再跳过 `.sibyl` 开头的路径。
- 复制前先算 `headFiles = git ls-tree -r --name-only -z <base>`；工作树里凡是 `headFiles` 有、快照集合没有的文件都删除。这覆盖 staged deletion 和「删除后又变成 ignored」的情况。
- 每个条目用 `lstat`：普通文件 `copyFile` + `chmod`；符号链接用 `readlink` 原样重建（绝对路径或指向仓库外的拒绝，文案 `Worker dispatch does not support symlinks outside the repository: <path>`）；目录（子模块或异常）拒绝。
- 有差异就在工作方分支提交 `sibyl: snapshot before <workerId>`。
- 提交统一带 `-c user.name=Agents Calling -c user.email=agents-calling@localhost`。
- `ensureSibylExcluded` 保证任意项目 `git status` 不因 `.sibyl` 变脏。
- 不链接 `node_modules`：本仓库零依赖，junction 会成为主仓库的可写别名；需要依赖的项目在任务里显式说明，不默认共享。
- 清理前校验 `worktreePath` 的真实路径位于 `<project>/.sibyl/worktrees/`、不是 reparse point、且 `git worktree list --porcelain` 里存在该路径与分支；只删除本次创建的资源。
- 错误文案：非 git `Worker dispatch needs a git repository: <path>`；不是仓库根 `Worker dispatch needs the repository root: <toplevel>`；无提交 `Repository has no commits yet; make one commit before dispatching a worker`；子模块 `Worker dispatch does not support submodules: <path>`；分支已存在 `Worker branch already exists: <branch>`。

- [ ] **Step 1: 写失败测试 `worker-worktree.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkerWorktree,isGitRepository,commitWorktree,removeWorkerWorktree} from './worker-worktree.mjs';

const git=(cwd,...args)=>execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com',...args],{cwd,encoding:'utf8'});
async function repo(){
  const root=await mkdtemp(join(tmpdir(),'worker-wt-'));
  git(root,'init','-q');await writeFile(join(root,'.gitignore'),'.sibyl/\n.env\nnode_modules/\n');
  await mkdir(join(root,'src'));await writeFile(join(root,'src','a.txt'),'base\n');await writeFile(join(root,'src','b.txt'),'b\n');
  git(root,'add','-A');git(root,'commit','-qm','base');
  return root;
}

test('snapshot carries uncommitted and untracked files without touching the lead branch',async()=>{
  const root=await repo();
  try{
    const head=git(root,'rev-parse','HEAD').trim();
    await writeFile(join(root,'src','a.txt'),'edited\n');
    await writeFile(join(root,'src','new.txt'),'new\n');
    await writeFile(join(root,'.env'),'SECRET=1\n');
    await rm(join(root,'src','b.txt'));
    const before=git(root,'status','--porcelain');

    const wt=await createWorkerWorktree({projectPath:root,workerId:'w1',branchPrefix:'sibyl/worker'});
    assert.equal(wt.branch,'sibyl/worker/w1');
    assert.equal(wt.baseCommit,head);
    assert.equal(await readFile(join(wt.worktreePath,'src','a.txt'),'utf8'),'edited\n');
    assert.equal(await readFile(join(wt.worktreePath,'src','new.txt'),'utf8'),'new\n');
    await assert.rejects(readFile(join(wt.worktreePath,'src','b.txt')),/ENOENT/);
    await assert.rejects(readFile(join(wt.worktreePath,'.env')),/ENOENT/);
    assert.equal(git(wt.worktreePath,'show','HEAD:src/new.txt').trim(),'new');
    assert.equal(git(root,'rev-parse','HEAD').trim(),head);
    assert.equal(git(root,'status','--porcelain'),before);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a clean lead workspace still yields a usable worker branch',async()=>{
  const root=await repo();
  try{
    const wt=await createWorkerWorktree({projectPath:root,workerId:'w2'});
    assert.equal(git(wt.worktreePath,'rev-parse','HEAD').trim(),git(root,'rev-parse','HEAD').trim());
    await writeFile(join(wt.worktreePath,'src','a.txt'),'worker\n');
    assert.match(await commitWorktree(wt.worktreePath,'sibyl: worker handoff',{branch:wt.branch,snapshotCommit:wt.snapshotCommit}),/^[a-f0-9]{40}$/);
    assert.equal(await commitWorktree(wt.worktreePath,'again',{branch:wt.branch,snapshotCommit:wt.snapshotCommit}),null);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('non-git, nested and empty repositories are refused in plain language',async()=>{
  const plain=await mkdtemp(join(tmpdir(),'worker-plain-'));
  const outer=await repo();const nested=join(outer,'src');
  const empty=await mkdtemp(join(tmpdir(),'worker-empty-'));git(empty,'init','-q');
  try{
    assert.equal(await isGitRepository(plain),false);
    await assert.rejects(createWorkerWorktree({projectPath:plain,workerId:'x'}),/needs a git repository|needs the repository root/);
    await assert.rejects(createWorkerWorktree({projectPath:nested,workerId:'x'}),/needs the repository root/);
    await assert.rejects(createWorkerWorktree({projectPath:empty,workerId:'x'}),/no commits yet/);
  }finally{for(const p of [plain,outer,empty])await rm(p,{recursive:true,force:true});}
});

test('a worktree can be removed together with its branch',async()=>{
  const root=await repo();
  try{
    const wt=await createWorkerWorktree({projectPath:root,workerId:'w3'});
    await removeWorkerWorktree({projectPath:root,worktreePath:wt.worktreePath,branch:wt.branch});
    await assert.rejects(stat(wt.worktreePath),/ENOENT/);
    assert.throws(()=>git(root,'rev-parse','--verify','sibyl/worker/w3'),/Command failed/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('ref changes outside the worker branch are reported',async()=>{
  const root=await repo();
  try{
    const {listRefs,refChanges}=await import('./worker-worktree.mjs');
    const before=await listRefs(root);
    git(root,'branch','lead-side');
    const after=await listRefs(root);
    assert.deepEqual(refChanges(before,after),['refs/heads/lead-side']);
    assert.deepEqual(refChanges(before,after,{ignore:['refs/heads/lead-side']}),[]);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('ignored tracked files and staged deletions do not leak into the snapshot',async()=>{
  const root=await repo();
  try{
    await writeFile(join(root,'.env'),'SECRET=1\n');
    git(root,'add','-f','.env');git(root,'commit','-qm','tracked ignored');
    git(root,'rm','-q','src/b.txt');
    const wt=await createWorkerWorktree({projectPath:root,workerId:'w4'});
    await assert.rejects(readFile(join(wt.worktreePath,'.env')),/ENOENT/);
    await assert.rejects(readFile(join(wt.worktreePath,'src','b.txt')),/ENOENT/);
    assert.ok(wt.skipped.ignoredTracked.includes('.env'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('creating .sibyl leaves the lead status clean without a project gitignore',async()=>{
  const root=await mkdtemp(join(tmpdir(),'worker-nogignore-'));
  try{
    git(root,'init','-q');await writeFile(join(root,'a.txt'),'a\n');git(root,'add','-A');git(root,'commit','-qm','base');
    const before=git(root,'status','--porcelain');
    await createWorkerWorktree({projectPath:root,workerId:'w5'});
    assert.equal(git(root,'status','--porcelain'),before);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('submodules are refused before a worktree is created',async()=>{
  const root=await repo();
  try{
    await writeFile(join(root,'.gitmodules'),'[submodule "x"]\n\tpath = x\n\turl = https://example.invalid/x\n');
    git(root,'add','.gitmodules');git(root,'commit','-qm','submodule');
    await assert.rejects(createWorkerWorktree({projectPath:root,workerId:'w6'}),/does not support submodules/);
    await assert.rejects(stat(join(root,'.sibyl','worktrees')),/ENOENT/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('staged paths are listable for lease checks',async()=>{
  const root=await repo();
  try{
    const {stagedPaths}=await import('./worker-worktree.mjs');
    await writeFile(join(root,'src','a.txt'),'staged\n');git(root,'add','src/a.txt');
    assert.deepEqual(await stagedPaths(root),['src/a.txt']);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('snapshot fingerprint detects content changes without status changes',async()=>{
  const root=await repo();
  try{
    const {snapshotFingerprint}=await import('./worker-worktree.mjs');
    await writeFile(join(root,'src','a.txt'),'A\n');
    const first=await snapshotFingerprint(root,['src/a.txt']);
    await writeFile(join(root,'src','a.txt'),'B\n');
    const second=await snapshotFingerprint(root,['src/a.txt']);
    assert.notEqual(first.digest,second.digest);
    assert.equal(git(root,'status','--porcelain').trim(),'M src/a.txt');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a change during copy is retried and the snapshot uses the new content',async()=>{
  const root=await repo();
  try{
    await writeFile(join(root,'src','a.txt'),'A\n');
    let once=false;
    const wt=await createWorkerWorktree({projectPath:root,workerId:'w8',scope:['src'],onBeforeCopy:async()=>{if(!once){once=true;await writeFile(join(root,'src','a.txt'),'B\n');}}});
    assert.equal(await readFile(join(wt.worktreePath,'src','a.txt'),'utf8'),'B\n');
    assert.ok(wt.leadDigest.files['src/a.txt']);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('commitWorktree refuses a worktree on the wrong branch',async()=>{
  const root=await repo();
  try{
    const wt=await createWorkerWorktree({projectPath:root,workerId:'w9'});
    git(wt.worktreePath,'checkout','-q','-b','other');
    await writeFile(join(wt.worktreePath,'src','a.txt'),'x\n');
    await assert.rejects(commitWorktree(wt.worktreePath,'m',{branch:wt.branch,snapshotCommit:wt.snapshotCommit}),/not on the expected branch/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('in-repo symlinks are copied as links, not expanded',async t=>{
  if(process.platform==='win32')return t.skip('creating symlinks needs privileges on Windows');
  const root=await repo();
  try{
    const fs=await import('node:fs/promises');
    await writeFile(join(root,'src','target.txt'),'t\n');await fs.symlink('target.txt',join(root,'src','link.txt'));
    git(root,'add','-A');git(root,'commit','-qm','link');
    const wt=await createWorkerWorktree({projectPath:root,workerId:'w7'});
    assert.equal((await fs.lstat(join(wt.worktreePath,'src','link.txt'))).isSymbolicLink(),true);
  }finally{await rm(root,{recursive:true,force:true});}
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 worker-worktree.test.mjs`
Expected: FAIL，`Cannot find module ./worker-worktree.mjs`。

- [ ] **Step 3: 实现 `worker-worktree.mjs`**

要点：`execFile('git',...)`（不经过 shell）；`git rev-parse --show-toplevel` 与 `canonicalProjectPath` 比较（Windows 用 `normalizedPath`）；按约定用 `tracked - trackedIgnored + untracked` 三份 `-z` 清单，再用 `git ls-tree -r --name-only -z <base>` 删除 HEAD 有而快照集合没有的文件；复制用 `lstat` 分派（文件 `copyFile`+`chmod`、符号链接 `readlink`+`symlink`、目录/子模块拒绝）；复制前后比对 `rev-parse HEAD` 与 `status --porcelain`；`git status --porcelain` 非空才 `add -A` 并在需要时提交；失败时尽量 `git worktree remove --force` + `git branch -D` 回滚。`scopeFingerprint` 递归遍历 scope 覆盖的现有文件，跳过 `.git`、`.sibyl`、`node_modules`，用 sha256 内容哈希，最多 2000 个文件，超过则 `truncated:true`。

- [ ] **Step 4: 跑测试确认通过**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 worker-worktree.test.mjs`
Expected: PASS，13 个用例全过。

- [ ] **Step 5: 提交**

```bash
git add worker-worktree.mjs worker-worktree.test.mjs
git commit -m "feat(worker): snapshot the lead workspace into a worker worktree"
```

---

### Task 4: 交工报告（git 为准 + 自报补充）

**Files:**
- Create: `worker-policy.mjs`
- Create: `worker-report.mjs`
- Modify: `scripts/spawn-claude-chat.mjs`（改为从 `worker-policy.mjs` 引入 `WORKER_POLICY`）
- Test: `worker-report.test.mjs`

**Interfaces:**
- Produces:
  - `WORKER_POLICY: string` —— 工作方系统提示（通用纪律 + 报告块格式）。
  - `buildDispatchPrompt({task, scope, worktreePath, branch, sharedFiles}) -> string`。
  - `REPORT_OPEN = '<<<SIBYL_REPORT'`、`REPORT_CLOSE = 'SIBYL_REPORT>>>'`。
  - `parseWorkerReport(text) -> {reported,summary,verification:[{command,result,exitCode?,cwd?,logPath?}],unfinished[],blockers[],changeRequests:[{path,reason}],acceptanceCriteria:[{criterion,status,evidence}],risks[]}`。
  - `collectWorkerReport({worktreePath, projectPath, workerId, snapshotCommit, headCommit, text, scope, sharedExtra}) -> report`。
  - `writeWorkerReport({projectPath, workerId, report, patch, deliverablePatch}) -> Promise<{reportPath,patchPath,deliverablePatchPath}>`。
  - report 形状：`{workerId,snapshotCommit,headCommit,changed:[{status,path,from?}],files:{added,modified,deleted,renamed:[{from,to}]},stats:{files,insertions,deletions,patchBytes},scope:{declared,outOfScope,sharedChanged},unsafeChanges,verification,verificationSource:'worker-self-report',unfinished,blockers,changeRequests,acceptanceCriteria,risks,acceptance:'pending',summary,reported,needsReview,reviewReasons,deliverable:{path:string|null,reason:string|null},patchError?}`。
  - `deliverable.path` 只有在「无越界、无共享文件、无符号链接/子模块改动、无补丁超限、无主导方冲突/ref 异常」时才非空；否则为 null 并给出中文 `reason`。全量补丁仍写 `<workerId>.patch` 供人看，可交付补丁写 `<workerId>.deliverable.patch`。
  - 解析 git 输出时用 `-z`；rename 的源路径与目标路径都要检查 scope 与共享文件。
  - 写文件一律「临时文件 + rename」原子落盘；`report.acceptance` 由主导方之后通过 `bridge_worker_accept` 更新（Task 8），daemon 不替主导方验收。

报告块约定（工作方必须在最后一轮输出）：

```json
{"summary":"一句话","verification":[{"command":"node --test","result":"pass|fail|not-run","exitCode":0,"cwd":"...","logPath":"..."}],"unfinished":[],"blockers":[],"changeRequests":[{"path":"package.json","reason":"..."}],"acceptanceCriteria":[{"criterion":"...","status":"pass|fail|unknown","evidence":"..."}],"risks":[]}
```

- [ ] **Step 1: 写失败测试 `worker-report.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseWorkerReport,collectWorkerReport,writeWorkerReport} from './worker-report.mjs';
import {buildDispatchPrompt,WORKER_POLICY} from './worker-policy.mjs';

const block=value=>'done\n<<<SIBYL_REPORT\n'+JSON.stringify(value)+'\nSIBYL_REPORT>>>';

test('the report block is parsed and the last block wins',()=>{
  const parsed=parseWorkerReport('x\n'+block({summary:'first',verification:[],unfinished:[],blockers:[],changeRequests:[]})+'\n'+block({summary:'second',verification:[{command:'node --test',result:'pass'}],unfinished:['docs'],blockers:['sandbox'],changeRequests:[{path:'package.json',reason:'dep'}]}));
  assert.equal(parsed.reported,true);
  assert.equal(parsed.summary,'second');
  assert.deepEqual(parsed.verification,[{command:'node --test',result:'pass'}]);
  assert.deepEqual(parsed.unfinished,['docs']);
  assert.deepEqual(parsed.changeRequests,[{path:'package.json',reason:'dep'}]);
});

test('missing or malformed reports degrade instead of throwing',()=>{
  const missing=parseWorkerReport('just prose');
  assert.equal(missing.reported,false);
  assert.match(missing.summary,/just prose/);
  const broken=parseWorkerReport('<<<SIBYL_REPORT\n{no json\nSIBYL_REPORT>>>');
  assert.equal(broken.reported,false);
  assert.equal(broken.summary,'');
});

test('oversized self-reported fields are clipped',()=>{
  const parsed=parseWorkerReport(block({summary:'s'.repeat(5000),verification:[],unfinished:Array.from({length:40},()=> 'u'),blockers:[],changeRequests:[]}));
  assert.equal(parsed.summary.length,2000);
  assert.equal(parsed.unfinished.length,20);
});

test('the dispatch prompt carries scope, shared files and the report block',()=>{
  const prompt=buildDispatchPrompt({task:'add endpoint',scope:['src'],worktreePath:'/w',branch:'sibyl/worker/x',sharedFiles:['package.json']});
  assert.match(prompt,/add endpoint/);
  assert.match(prompt,/src/);
  assert.match(prompt,/package\.json/);
  assert.match(prompt,/SIBYL_REPORT/);
  assert.match(WORKER_POLICY,/SIBYL_REPORT/);
});

const git=(cwd,...args)=>execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com',...args],{cwd,encoding:'utf8'});
async function base(){
  const root=await mkdtemp(join(tmpdir(),'worker-report-'));
  git(root,'init','-q');await mkdir(join(root,'src'));await writeFile(join(root,'src','a.txt'),'a\n');await writeFile(join(root,'keep.txt'),'k\n');
  git(root,'add','-A');git(root,'commit','-qm','base');
  return {root,snapshot:git(root,'rev-parse','HEAD').trim()};
}

test('files and diff come from git, not from the worker say-so',async()=>{
  const {root,snapshot}=await base();
  try{
    await writeFile(join(root,'src','a.txt'),'a2\n');
    await writeFile(join(root,'src','new.txt'),'n\n');
    git(root,'add','-A');git(root,'commit','-qm','work');
    const head=git(root,'rev-parse','HEAD').trim();
    const lie=block({summary:'I changed docs',verification:[{command:'node --test',result:'pass'}],unfinished:[],blockers:[],changeRequests:[]});
    const report=await collectWorkerReport({worktreePath:root,projectPath:root,workerId:'w1',snapshotCommit:snapshot,headCommit:head,text:lie,scope:['src']});
    assert.deepEqual(report.files.modified,['src/a.txt']);
    assert.deepEqual(report.files.added,['src/new.txt']);
    assert.equal(report.stats.insertions,2);
    assert.deepEqual(report.scope.outOfScope,[]);
    assert.equal(report.needsReview,false);
    assert.deepEqual(report.reviewReasons,[]);
    assert.equal(report.deliverable.reason,null);
    const paths=await writeWorkerReport({projectPath:root,workerId:'w1',report,patch:'diff --git a/x b/x\n+secret\n',deliverablePatch:'diff --git a/src/a.txt b/src/a.txt\n+ok\n'});
    assert.match(await readFile(paths.patchPath,'utf8'),/\+secret/);
    assert.match(await readFile(paths.deliverablePatchPath,'utf8'),/\+ok/);
    assert.equal(JSON.parse(await readFile(paths.reportPath,'utf8')).workerId,'w1');
    assert.ok(!JSON.stringify(report).includes('diff --git'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('out-of-scope and shared-file edits block the deliverable patch',async()=>{
  const {root,snapshot}=await base();
  try{
    await mkdir(join(root,'docs'));await writeFile(join(root,'docs','evil.txt'),'x\n');await writeFile(join(root,'package.json'),'{}\n');
    git(root,'add','-A');git(root,'commit','-qm','work');
    const head=git(root,'rev-parse','HEAD').trim();
    const report=await collectWorkerReport({worktreePath:root,projectPath:root,workerId:'w2',snapshotCommit:snapshot,headCommit:head,text:'',scope:['src']});
    assert.deepEqual(report.scope.outOfScope,['docs/evil.txt']);
    assert.deepEqual(report.scope.sharedChanged,['package.json']);
    assert.equal(report.needsReview,true);
    assert.ok(report.reviewReasons.length>=2);
    assert.equal(report.deliverable.path,null);
    assert.match(report.deliverable.reason,/越界|共享/);
    const paths=await writeWorkerReport({projectPath:root,workerId:'w2',report,patch:'full',deliverablePatch:'should-not-be-written'});
    assert.equal(paths.deliverablePatchPath,null);
    await assert.rejects(readFile(join(root,'.sibyl','reports','w2.deliverable.patch')),/ENOENT/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('missing verification makes the report need review but stays deliverable',async()=>{
  const {root,snapshot}=await base();
  try{
    await writeFile(join(root,'src','a.txt'),'a2\n');
    git(root,'add','-A');git(root,'commit','-qm','work');
    const head=git(root,'rev-parse','HEAD').trim();
    const report=await collectWorkerReport({worktreePath:root,projectPath:root,workerId:'w5',snapshotCommit:snapshot,headCommit:head,text:block({summary:'no tests',verification:[],unfinished:[],blockers:[],changeRequests:[]}),scope:['src']});
    assert.equal(report.needsReview,true);
    assert.ok(report.reviewReasons.some(r=>/验证/.test(r)));
    assert.equal(report.deliverable.reason,null,'verification gaps do not block the patch');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a rename into an out-of-scope path is not deliverable',async()=>{
  const {root,snapshot}=await base();
  try{
    await mkdir(join(root,'docs'));
    git(root,'mv','src/a.txt','docs/a.txt');
    git(root,'commit','-qm','move');
    const head=git(root,'rev-parse','HEAD').trim();
    const report=await collectWorkerReport({worktreePath:root,projectPath:root,workerId:'w3',snapshotCommit:snapshot,headCommit:head,text:'',scope:['src']});
    assert.deepEqual(report.files.renamed,[{from:'src/a.txt',to:'docs/a.txt'}]);
    assert.ok(report.scope.outOfScope.includes('docs/a.txt'));
    assert.equal(report.deliverable.path,null);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('symlink changes are unsafe and not deliverable',async t=>{
  if(process.platform==='win32')return t.skip('symlink creation needs privileges on Windows');
  const {root,snapshot}=await base();
  try{
    const fs=await import('node:fs/promises');
    await fs.symlink('/etc/passwd',join(root,'src','link.txt'));
    git(root,'add','-A');git(root,'commit','-qm','link');
    const head=git(root,'rev-parse','HEAD').trim();
    const report=await collectWorkerReport({worktreePath:root,projectPath:root,workerId:'w4',snapshotCommit:snapshot,headCommit:head,text:'',scope:['src']});
    assert.ok(report.unsafeChanges.includes('src/link.txt'));
    assert.equal(report.deliverable.path,null);
  }finally{await rm(root,{recursive:true,force:true});}
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 worker-report.test.mjs`
Expected: FAIL，`Cannot find module ./worker-report.mjs`。

- [ ] **Step 3: 实现**

`worker-policy.mjs`：`WORKER_POLICY` 保留 Phase A 的三条纪律，明确禁止 `git push/reset/restore/checkout/branch -D/config/commit --amend/worktree` 和任何改动共享 `.git` 的命令，并追加报告块格式；`buildDispatchPrompt` 按 Interfaces 拼出工作树、分支、scope、共享文件、任务与验收要求（逐条 `acceptanceCriteria`）。`scripts/spawn-claude-chat.mjs` 改为 `import {WORKER_POLICY} from '../worker-policy.mjs'`，删除本地定义。`scripts/spawn-codex-chat.mjs` 通过 `--instructions` 收到同一份文本。

`worker-report.mjs`：`git diff --name-status -z --find-renames` 出清单、`--numstat -z` 出统计、`--raw -z` 看 mode、`--binary` 出补丁（`execFile` 的 `maxBuffer` 设为 64MB）；rename 的 `from/to` 都做越界与共享检查；mode `120000`（符号链接）或 `160000`（子模块）进 `unsafeChanges`。`outOfScope` 用 `pathWithin`，`sharedChanged` 用 `isSharedPath`；`reviewReasons` 收集越界、共享改动、不安全改动、`reported:false`、验证为空或含 `fail`/`not-run`、补丁超 64MB、指纹截断等；`needsReview = reviewReasons.length>0`；只有「越界/共享/不安全/补丁超限」才让 `deliverable.reason` 非空（验证类问题只进 reviewReasons，不阻断补丁）。`writeWorkerReport` 写 `<project>/.sibyl/reports/<workerId>.{patch,json}`，只有 `deliverable.reason===null` 时才写 `<workerId>.deliverable.patch`，JSON 中不含 patch 正文；两个文件都先写 `.tmp` 再 rename。`parseWorkerReport` 取最后一个块；完全没有块时 `summary` 取正文末尾 2000 字，有块但 JSON 非法时 `reported:false,summary:''`；任何字段超限都裁剪而不是抛错。

- [ ] **Step 4: 跑测试确认通过**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 worker-report.test.mjs`
Expected: PASS，9 个用例全过（1 个符号链接用例在 Windows 跳过）。

- [ ] **Step 5: 提交**

```bash
git add worker-policy.mjs worker-report.mjs worker-report.test.mjs scripts/spawn-claude-chat.mjs
git commit -m "feat(worker): produce structured handoff reports"
```

---

### Task 5: daemon 里的工作方生命周期

**Files:**
- Create: `workers.mjs`
- Modify: `scripts/spawn-codex-chat.mjs`（close/SIGTERM 立即终止下游）
- Modify: `scripts/spawn-claude-chat.mjs`（同上）
- Test: `worker-service.test.mjs`

**Interfaces:**
- Consumes: Task 1 的预算、Task 2 的 scope、Task 3 的工作树、Task 4 的报告；`scripts/spawn-codex-chat.mjs` 与 `scripts/spawn-claude-chat.mjs` 的 `thread/turn/error/closed` 行协议。
- Produces:
  - `createWorkerService({dataDir, store, limits=normalizeWorkerLimits(), scripts={}, now=Date.now, onChange=()=>{}, worktrees, reports, killTree, isAlive, sessionAlive, orphanGraceMs})`。
  - 返回 `{start(input) -> Promise<publicWorker>, turn({session,workerId,prompt,timeoutMs}), result({session,workerId,waitMs}), close({session,workerId}), accept({session,workerId,accepted,note}), list({session?,all?}) -> publicWorker[], checkLease({session,paths}), closeAll(), stop()}`。
  - `accept` 只能作用于已收工的自己的 worker，写 `report.acceptance='accepted'|'rejected'` 与 `acceptanceNote` 并落库；未收工时抛 `Worker has not finished`。
  - `start` 入参 `{session:{id,projectPath},tool,tier='dispatch',scope,leadScope?,prompt?,model='auto',kind=null,risk='normal',effort?,timeoutMs?}`。解析规则：**先按 tool 分流**——`tool==='claude' && model==='auto'` 时不传模型（`model:null`），显式 model 原样传；`tool==='codex' && model==='auto'` 用 `chooseCodexModel({tier,kind,risk})`；显式 `model` 两者都原样传。显式 `effort` 永远优先于策略值。不支持的模型由 launcher 报错并失败，**不静默换模型**。立即返回 `{workerId,status:'starting',tool,tier,scope,model,effort,worktreePath,branch,leadMustWaitFor,notice}`。
  - `turn` 只入队并**立即**返回 `{workerId,turnId,status:'running',accepted:true}`，绝不等待整轮；轮次结果通过 `result` 的 `lastTurn` 读取。`starting` 时报 `Worker is still starting; call bridge_worker_result first`，非 `running` 时报 `Worker is not running`，已有轮次时报 `A turn is already running in this worker`。
  - `result` 返回 `{...publicWorker,lastTurn}`；`lastTurn` 形状 `{id,status:'running'|'completed'|'failed',text?,error?,startedAt,endedAt?}`。记录持有 `lastTurnPromise`（每轮结束时 resolve）与 `done`（finalize 时 resolve）；`result` 只在 `lastTurn.status==='running'` 时按 `waitMs` 等 `lastTurnPromise`，一轮结束立即返回，不等满 25 秒。
  - 收工协议：`finalize` 第一次调用时创建 `record.finalizing` promise，所有路径复用它；步骤固定为「先 `record.cancelled=true` 并释放 setup 的等待点 → `await record.setupPromise.catch(()=>{})` → 拒绝在跑轮次 → 发 `{op:'close'}` 并等子进程 `close`（5 秒）→ `taskkill /T /F`（Windows，根进程还活着时就能杀整棵树）/ 进程组（POSIX）→ 再等 2 秒 → `commitWorktree(...,{branch,snapshotCommit})` → 生成报告 → 释放租约 → 落库 → resolve `done`」。Windows 上只杀 Node 包装进程不算退出，必须等 `close` 事件。
  - `setup()` 只负责初始化到 `running`（工作树、子进程、thread 行），**绝不调用 finalize、也不包含第一轮**；第一轮由 `start` 在 `setupPromise` 之外调度。已取消就在下一检查点返回；finalize 先标取消再等 setup，避免关闭时等完整轮次。
  - 退出无法确认（`taskkill`/进程组操作后仍存活）：记录 `status:'orphan'`、`stopReason:'exit-unconfirmed'`、`childPid`，**保留租约与记录**，立即 `store.saveWorker` 并返回，不提交、不生成可交付报告。服务构造时对 `stopReason==='exit-unconfirmed'` 的记录**一律保留租约**（包装 PID 死亡不能证明整棵树退出）；只有对 orphan 再次 `close` 且 `killTree` 后确认死亡，才释放租约并标 `interrupted`。
  - 工作树与分支在交工后保留（供主导方验收/贴补丁）；`removeWorkerWorktree` 只用于显式清理与测试。第一阶段不做自动清理，Phase C 再加。
  - 记录形状：`{id,sourceSessionId,status,tool,tier,scope,leadScope,projectPath,worktreePath,branch,baseCommit,snapshotCommit,model,effort,modelReason,startedAt,updatedAt,lastProgressAt,endedAt,stopReason,error,turns,lastTurn,report}`；状态集合 `starting|running|completed|failed|stopped|interrupted`（Task 7 再加 `orphan`）。
  - 存储契约：`store.listWorkers()` / `store.saveWorker(record)`（Task 7 落地；本任务测试用内存桩）。
  - 子进程参数：`node <script> --rpc --dir <dataDir> --project <worktreePath> --sandbox workspace-write --model <model> --effort <effort> --timeout-ms 600000`；Codex 额外 `--instructions <WORKER_POLICY>`；启动 30 秒拿 `thread` 行。`spawn-codex-chat.mjs` 把 `--model` 变成 `-c model=<slug>`；`spawn-claude-chat.mjs` 把 `--model` 传给 Claude 的 `--model`（不传则用 Claude 默认）。
  - 第一轮 prompt 用 `buildDispatchPrompt`；`prompt` 给定时默认自动收工（第一轮完成 → 提交剩余改动 → 出报告 → 关进程 → `completed`），轮次失败也收工并标 `failed`。无 `prompt` 时只建好工作方，状态 `running`。
  - **consult 档**：`tier:'consult'` 时不建工作树、不需要 `scope`，用 `--sandbox read-only --project <projectPath>` 启动工作方；`worktreePath/branch` 为 `null`，不发补丁、不写报告，`report` 只有文本与 `verificationSource`。这就是「问一下」的可见会话（Codex app-server thread）。
  - **启动器必须可中断**：改 `scripts/spawn-codex-chat.mjs` / `scripts/spawn-claude-chat.mjs`，收到 `{op:'close'}` 或 SIGTERM 时立刻终止下游 app-server/Claude 进程，不排队等当前轮次；`workers.mjs` 在 Windows 用 `taskkill /pid <pid> /T /F`、POSIX 用进程组，确保孙进程退出。退出无法确认时状态 `stopped` + `stopReason:'exit-unconfirmed'`，不提交、不释放租约。
  - **setup 与 finalize 协调**：`start` 保存 `record.setupPromise`；`finalize` 先 `await record.setupPromise.catch(()=>{})`，再冻结内容。快照复制期间主导方 `HEAD` 或 `git status` 变化则重试一次，仍变化就拒绝派活（`Lead workspace changed during snapshot; retry dispatch`）。
  - **启动器必须可中断**：改 `scripts/spawn-codex-chat.mjs` / `scripts/spawn-claude-chat.mjs`，收到 `{op:'close'}` 或 SIGTERM 时立刻终止下游 app-server/Claude 进程，不排队等当前轮次；`workers.mjs` 在 Windows 用 `taskkill /pid <pid> /T /F`（根进程存活时执行）、POSIX 用进程组，确保孙进程退出。服务测试可注入 `killTree(pid)` 与 `isAlive(pid)`。
  - 每次启动 launcher 都传 `--timeout-ms 600000`；`turn` 的 `timeoutMs` 不得超过它，实际计时由 daemon 的 `spawnTurn` 负责。
  - daemon 关闭时先置 `closing=true`，新的 `start` 报 `Daemon is shutting down`；再 `closeAll()` 等所有 worker 收工。

- [ ] **Step 1: 写失败测试 `worker-service.test.mjs`**

测试里的假工作方脚本（每个用例自己写一份，内容如下；`fixture(mode)` 把 `__MODE__` 替换成 `write|evil|hang|fail`）：

```js
const fake=`import {spawn} from 'node:child_process';import {writeFileSync,mkdirSync} from 'node:fs';import {join} from 'node:path';import {createInterface} from 'node:readline';
const args=process.argv.slice(2),opt=n=>{const i=args.indexOf('--'+n);return i>=0?args[i+1]:undefined;};
const mode='__MODE__';
if(process.env.FAKE_WORKER_PID)writeFileSync(process.env.FAKE_WORKER_PID,String(process.pid));
if(process.env.FAKE_ARGS_FILE)writeFileSync(process.env.FAKE_ARGS_FILE,JSON.stringify(args));
if(process.env.FAKE_TICK_FILE&&mode==='tree')spawn(process.execPath,['-e',"const fs=require('fs');setInterval(()=>fs.appendFileSync(process.env.FAKE_TICK_FILE,'x'),50)"],{stdio:'ignore',env:process.env});
process.stdout.write(JSON.stringify({type:'thread',threadId:'fake-'+process.pid,sessionId:'fake',cwd:opt('project')})+'\\n');
const report=v=>'done\\n<<<SIBYL_REPORT\\n'+JSON.stringify(v)+'\\nSIBYL_REPORT>>>';
const rl=createInterface({input:process.stdin});
rl.on('line',line=>{const c=JSON.parse(line);
 if(c.op==='close'){if(mode==='tree')return;process.stdout.write(JSON.stringify({id:c.id,type:'closed'})+'\\n');process.exit(0);}
 if(c.op!=='turn')return;
 if(mode==='hang')return;
 if(mode==='fail'){process.stdout.write(JSON.stringify({id:c.id,type:'error',error:'worker exploded'})+'\\n');return;}
 const model=opt('model');
 if(mode==='modelcheck'&&model&&!['gpt-6.1-sol','gpt-6.1-terra','gpt-6-luna','gpt-6-astra'].includes(model)){process.stdout.write(JSON.stringify({id:c.id,type:'error',error:'Unsupported model: '+model})+'\\n');return;}
 if(mode!=='read'){mkdirSync(join(process.cwd(),'src'),{recursive:true});writeFileSync(join(process.cwd(),'src','a.txt'),'worker\\n');}
 if(mode==='evil'){mkdirSync(join(process.cwd(),'docs'),{recursive:true});writeFileSync(join(process.cwd(),'docs','evil.txt'),'x\\n');}
 process.stdout.write(JSON.stringify({id:c.id,type:'turn',text:report({summary:'done',verification:[{command:'none',result:'not-run'}],unfinished:[],blockers:[],changeRequests:[]}),tools:[]})+'\\n');
});
rl.on('close',()=>process.exit(0));`;
```

fixture（`mode` 与 `limits` 都由参数注入，供 Task 6 复用）：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkerService} from './workers.mjs';
import {projectKey} from './project-path.mjs';

const git=(cwd,...args)=>execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com',...args],{cwd,encoding:'utf8'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(mode='write',limits=undefined){
  const root=await mkdtemp(join(tmpdir(),'worker-svc-'));
  const project=join(root,'project'),dataDir=join(root,'data');await mkdir(join(project,'src'),{recursive:true});await mkdir(dataDir);
  git(project,'init','-q');await writeFile(join(project,'.gitignore'),'.sibyl/\n');await writeFile(join(project,'src','a.txt'),'base\n');
  git(project,'add','-A');git(project,'commit','-qm','base');
  const script=join(root,'fake-worker.mjs');await writeFile(script,fake.replace('__MODE__',mode));
  const records=new Map();
  const store={listWorkers:()=>[...records.values()],saveWorker:r=>{records.set(r.id,r);return r;}};
  const service=createWorkerService({dataDir,store,scripts:{codex:script,claude:script},onChange:()=>{},...(limits?{limits}:{})});
  const session={id:'s1',projectPath:project};
  return {root,project,dataDir,script,service,session,store,async cleanup(){service.stop();await service.closeAll();await rm(root,{recursive:true,force:true});}};
}
const wait=async(fn,ms=8000)=>{const end=Date.now()+ms;let last;while(Date.now()<end){last=await fn();if(last)return last;await sleep(50);}throw Error('timed out waiting');};

test('start returns before the first turn and the report is built from git',async()=>{
  const f=await fixture();
  try{
    const head=git(f.project,'rev-parse','HEAD').trim();
    const started=await f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['src'],prompt:'do it'});
    assert.equal(started.status,'starting');
    assert.equal(started.report,undefined);
    assert.ok(started.worktreePath.endsWith(join('.sibyl','worktrees',started.workerId)));
    const done=await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:200});return r.status==='completed'?r:null;});
    assert.deepEqual(done.report.files.modified,['src/a.txt']);
    assert.ok(await stat(join(f.project,'.sibyl','reports',started.workerId+'.patch')));
    assert.equal(git(f.project,'rev-parse','HEAD').trim(),head);
    assert.equal((await readFile(join(f.project,'src','a.txt'),'utf8')),'base\n');
  }finally{await f.cleanup();}
});

test('a failed turn still hands back a report',async()=>{
  const f=await fixture('fail');
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src'],prompt:'x'});
    const done=await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:200});return r.status==='failed'?r:null;});
    assert.match(done.error,/worker exploded/);
    assert.equal(done.report.reported,false);
  }finally{await f.cleanup();}
});

test('an explicit close stops a live turn and releases the worker',async()=>{
  const f=await fixture('hang');
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src'],prompt:'x'});
    await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:50});return ['starting','running'].includes(r.status)?r:null;});
    const closed=await f.service.close({session:f.session,workerId:started.workerId});
    assert.equal(closed.status,'stopped');
    assert.equal(f.service.list({session:f.session}).length,1);
  }finally{await f.cleanup();}
});

test('workers from another session are invisible',async()=>{
  const f=await fixture();
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src']});
    await assert.rejects(f.service.result({session:{id:'other'},workerId:started.workerId}),/Unknown worker/);
    await assert.rejects(f.service.close({session:{id:'other'},workerId:started.workerId}),/Unknown worker/);
    assert.equal(f.service.list({session:{id:'other'}}).length,0);
  }finally{await f.cleanup();}
});

test('a non-git project is refused before any worker is recorded',async()=>{
  const root=await mkdtemp(join(tmpdir(),'worker-nogit-'));
  try{
    const store={listWorkers:()=>[],saveWorker:()=>{}};
    const service=createWorkerService({dataDir:root,store,scripts:{codex:'x'}});
    await assert.rejects(service.start({session:{id:'s',projectPath:root},tool:'codex',scope:['src']}),/needs a git repository/);
    assert.equal(service.list({session:{id:'s'}}).length,0);
    service.stop();
  }finally{await rm(root,{recursive:true,force:true});}
});

test('turn returns immediately and result exposes lastTurn',async()=>{
  const f=await fixture('hang');
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src']});
    await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:50});return r.status==='running'?r:null;});
    const before=Date.now();
    const turn=await f.service.turn({session:f.session,workerId:started.workerId,prompt:'work'});
    assert.ok(Date.now()-before<1000,'turn waited for the turn to finish');
    assert.equal(turn.accepted,true);
    assert.equal(turn.status,'running');
    const state=await f.service.result({session:f.session,workerId:started.workerId,waitMs:50});
    assert.equal(state.lastTurn.status,'running');
    await f.service.close({session:f.session,workerId:started.workerId});
  }finally{await f.cleanup();}
});

test('closing during startup finalizes once and frees the lease',async()=>{
  const f=await fixture('hang');
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src']});
    const closed=await f.service.close({session:f.session,workerId:started.workerId});
    assert.ok(['stopped','completed'].includes(closed.status),closed.status);
    const again=await f.service.start({session:f.session,tool:'codex',scope:['src']});
    assert.ok(again.workerId);
  }finally{await f.cleanup();}
});

test('closing waits for the spawned process to exit',async()=>{
  const f=await fixture('hang');
  const pidFile=join(f.root,'worker.pid');
  process.env.FAKE_WORKER_PID=pidFile;
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src'],prompt:'x'});
    const pid=await wait(async()=>{try{const n=Number(await readFile(pidFile,'utf8'));return n>0?n:null;}catch{return null;}});
    await f.service.close({session:f.session,workerId:started.workerId});
    let dead=false;for(let i=0;i<60;i++){try{process.kill(pid,0);}catch{dead=true;break;}await sleep(50);}
    assert.equal(dead,true,'worker child survived close');
  }finally{delete process.env.FAKE_WORKER_PID;await f.cleanup();}
});

test('closing kills the whole worker process tree',async()=>{
  const f=await fixture('tree');
  const tick=join(f.root,'tick.txt');
  process.env.FAKE_TICK_FILE=tick;
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src'],prompt:'x'});
    await wait(async()=>{try{return (await readFile(tick,'utf8')).length>0;}catch{return null;}});
    await f.service.close({session:f.session,workerId:started.workerId});
    const size=(await readFile(tick,'utf8')).length;
    await sleep(600);
    assert.equal((await readFile(tick,'utf8')).length,size,'grandchild kept writing after close');
  }finally{delete process.env.FAKE_TICK_FILE;await f.cleanup();}
});

test('a completed turn is visible while the worker stays running',async()=>{
  const f=await fixture();
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src']});
    await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:50});return r.status==='running'?r:null;});
    await f.service.turn({session:f.session,workerId:started.workerId,prompt:'work'});
    const state=await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:50});return r.lastTurn?.status==='completed'?r:null;});
    assert.equal(state.status,'running');
  }finally{await f.cleanup();}
});

test('start records the auto-selected model and effort',async()=>{
  const f=await fixture();
  try{
    const cheap=await f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['src'],kind:'mechanical'});
    assert.equal(cheap.model,'gpt-6-luna');
    assert.equal(cheap.effort,'low');
    const review=await f.service.start({session:f.session,tool:'codex',tier:'consult',kind:'review',risk:'high',prompt:'x'});
    assert.equal(review.model,'gpt-6.1-sol');
    assert.equal(review.effort,'high');
  }finally{await f.cleanup();}
});

test('the launcher receives the chosen model and effort',async()=>{
  const f=await fixture();
  const argsFile=join(f.root,'args.json');process.env.FAKE_ARGS_FILE=argsFile;
  try{
    const started=await f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['src'],kind:'mechanical'});
    await wait(async()=>{try{return JSON.parse(await readFile(argsFile,'utf8'));}catch{return null;}});
    const args=JSON.parse(await readFile(argsFile,'utf8'));
    assert.equal(args[args.indexOf('--model')+1],'gpt-6-luna');
    assert.equal(args[args.indexOf('--effort')+1],'low');
    assert.ok(started.workerId);
  }finally{delete process.env.FAKE_ARGS_FILE;await f.cleanup();}
});

test('explicit effort wins and Claude auto gets no model',async()=>{
  const f=await fixture();
  try{
    const claude=await f.service.start({session:f.session,tool:'claude',tier:'consult',model:'auto'});
    assert.equal(claude.model,null);
    const codex=await f.service.start({session:f.session,tool:'codex',tier:'consult',kind:'review',effort:'low'});
    assert.equal(codex.model,'gpt-6.1-terra');
    assert.equal(codex.effort,'low');
  }finally{await f.cleanup();}
});

test('an unsupported explicit model fails without falling back',async()=>{
  const f=await fixture('modelcheck');
  try{
    const started=await f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['src'],prompt:'x',model:'not-a-model'});
    const done=await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:200});return r.status==='failed'?r:null;});
    assert.match(done.error,/Unsupported model/);
  }finally{await f.cleanup();}
});

test('consult tier runs read-only without a worktree',async()=>{
  const f=await fixture('read');
  try{
    const started=await f.service.start({session:f.session,tool:'codex',tier:'consult',prompt:'look'});
    const done=await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:200});return r.status==='completed'?r:null;});
    assert.equal(done.worktreePath,null);
    assert.equal(done.report.patchPath,undefined);
    await assert.rejects(stat(join(f.project,'.sibyl')),/ENOENT/);
  }finally{await f.cleanup();}
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 worker-service.test.mjs`
Expected: FAIL，`Cannot find module ./workers.mjs`。

- [ ] **Step 3: 实现 `workers.mjs` 核心**

要点：
- 构造时把 `store.listWorkers()` 装进内存 `records`（只读展示）；对 `stopReason==='exit-unconfirmed'` 的记录保留 `status:'orphan'` 并按其 scope 建租约，**一律不自动释放**；其余历史 live 记录按 `interrupted` 展示，不重建租约（同 scope 可以重新派活）。`start` 的容量与租约只看 live 记录。
- `start` 同步校验（tool、tier、canonical 项目、scope、共享文件、租约、容量、staged-in-scope、model/kind/risk）后立刻记录并返回；`model==='auto'` 用 `chooseCodexModel` 解析，`effort` 未传用策略值；`setup()` 异步执行工作树 → 检查 `cancelled` → 子进程 → `thread` 行 → `running`，第一轮由 `start` 在 `setupPromise` 之外调度。每次状态变化都 `store.saveWorker(record)`。`record.leadDigest` 直接用 `createWorkerWorktree` 返回的 `leadDigest`，不再单独采集。
- 子进程 RPC 与 Phase A 的 `native-mcp.startSpawn` 相同：30 秒启动超时、单轮超时、stderr 留 2000 字、`error`/`close` 都要拒绝在跑的轮次。
- Launcher 修改：`spawn-codex-chat.mjs` 接受 `--model` 并写入 `overrides.model`（未传不加）；`spawn-claude-chat.mjs` 的 `buildClaudeArgs` 接受 `model`，非空时加 `--model <value>`；`tool==='claude'` 且 `model==='auto'` 时不传，用 Claude 默认模型。
- 模型解析顺序：先按 tool 分流，再解析 auto；显式 `model` 和显式 `effort` 永远优先；`--model` 只在值非空时传给 launcher。launcher 返回 unknown model 时直接失败并保留原始错误，**不重试、不换模型**。
- `turn` 只入队并立即返回；`runTurn` 在后台执行，成功/失败都更新 `lastTurn` 与 `lastProgressAt`，并 resolve `lastTurnPromise`。每轮串行，重复轮次报 `A turn is already running in this worker`。
- `finalize(record, status, error)` 用一次性 `record.finalizing` promise：先 `record.cancelled=true` 并释放 setup 等待点 → `await record.setupPromise.catch(()=>{})` → 拒绝在跑轮次 → `{op:'close'}` + 等 `close`（5 秒）→ `taskkill /T /F` 或进程组 + 等 2 秒 → 确认退出失败时落库 `status='orphan', stopReason='exit-unconfirmed'`、**保留租约并立即返回**（不提交、不出报告）→ `commitWorktree('sibyl: worker handoff',{branch,snapshotCommit})`（工作树未建立时跳过）→ `headCommit` → `collectWorkerReport` → `writeWorkerReport` → 把返回的 `reportPath/patchPath/deliverablePatchPath` 写进 report（`deliverable.path`）→ 写状态与 `endedAt` → `store.saveWorker` → `onChange` → resolve `record.done`。自动收工走 `completed`，轮次失败走 `failed`，显式关闭/超时走 `stopped`。报告写入失败不阻断交工：记 `reportError` 并继续落库。
- `setupPromise` 的拒绝只记录错误，不调用 finalize；第一轮在 setup 之外调度，`finalize` 负责统一收尾，避免互相 await。
- 对 `status:'orphan'` 的 `close`：再次调用 `killTree(childPid)`，`isAlive` 为 false 才释放租约并标 `interrupted`；否则报 `Worker process tree is still alive; cannot release the lease`。
- `closeAll()` 对所有活工作方走同一收工路径并标 `interrupted`，报告尽力生成；等子进程退出后再释放租约。
- 启动失败（工作树、子进程）也要 `finalize`，并把租约释放。
- 内部 `leases` 数组由 live 工作方（worker scope）与 `leadScope` 组成，`checkLease` 用 Task 2 的函数。

- [ ] **Step 4: 跑测试确认通过**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 worker-service.test.mjs`
Expected: PASS，15 个用例全过。

- [ ] **Step 5: 提交**

```bash
git add workers.mjs worker-service.test.mjs scripts/spawn-codex-chat.mjs scripts/spawn-claude-chat.mjs
git commit -m "feat(worker): run workers from the daemon"
```

---

### Task 6: 租约、档位上限、越界与主导方改动

**Files:**
- Modify: `workers.mjs`
- Test: `worker-service.test.mjs`

**Interfaces:**
- Consumes: Task 1 `checkWorkerCapacity`、Task 2 租约与共享文件、Task 3 `scopeFingerprint/fingerprintChanges/listRefs/refChanges/stagedPaths`。
- Produces: **不新增导出**；`start` 增加以下拒绝文案与报告字段：
  - 共享文件（含项目级 `.sibyl/shared-files.json` 的 `add`）：`共享文件只能由主导方修改：<paths>；请让工作方在交工报告里提出 changeRequests`
  - 租约：`路径租约冲突：<path> 已被工作方 <workerId> 占用；等它交工后再派`；被 `leadScope` 占用时写 `已被主导方租约占用`。
  - 单工作方：`派个活（dispatch）同时只能有一个工作方；多工作方请用分头干（tier: parallel）`
  - 会话上限：`该会话同时最多 <n> 个工作方；先等工作方交工`
  - 项目上限：`该项目同时最多 <n> 个工作方；先等工作方交工`
  - 预算：`<window 分钟> 内已派 <n> 个工作方；先处理已有报告`
  - 租约条目统一为 `{leaseId,repositoryKey,ownerSessionId,ownerRole,workerId,scope,generation}`；`repositoryKey` 用 `projectKey(projectPath)`，不同仓库的同名路径互不冲突。worker 记录自己的 `leaseIds`，收工时按 `leaseId` 精确释放。
  - `start` 在建树前用 `stagedPaths(projectPath)` 与请求 `scope` 求交；有交集就拒绝：`主导方在 scope 内有已暂存改动；先提交或取消暂存再派活`。未暂存改动允许（快照会带上，补丁可贴）。
  - `leadScope` 与 worker `scope` 一起进租约表；两者重叠、或 leadScope 与已在跑的工作方重叠都拒绝。lead 租约按 `(repositoryKey,ownerSessionId,scope)` 复用，最后一个引用它的 worker 收工时释放。**`leadScope` 允许包含共享文件**（主导方本来就拥有 package.json/锁文件）；共享文件校验只针对 worker `scope`。
  - 报告新增 `leadChanges:string[]`（派活后被主导方改动的 scope 内文件）、`refsChanged:string[]`（除**当前 live 工作方的分支**外，派活后变动的 ref）与 `reviewReasons`（越界/共享改动/不安全改动/指纹截断）。`refsChanged` 只忽略 `live records` 自己的 `branch`，不忽略整个 `sibyl/*` 命名空间。
  - 指纹 `truncated:true` 时追加 reviewReason `主导方改动指纹被截断，验收需人工确认`。
  - `list` 的记录带 `elapsedMs/idleMs`；看门狗用 `checkProgress(record,{now,limits:{maxDurationMs,noProgressMs}})`。

- [ ] **Step 1: 写失败测试（追加到 `worker-service.test.mjs`）**

```js
test('dispatch allows only one live worker per session',async()=>{
  const f=await fixture();
  try{
    const first=await f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['src/a']});
    assert.ok(first.workerId);
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['docs']}),/只能有一个工作方/);
  }finally{await f.cleanup();}
});

test('parallel allows disjoint workers up to the session limit',async()=>{
  const f=await fixture();
  try{
    await f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src/a']});
    await f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['docs']});
    await f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src/b']});
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src/c']}),/该会话同时最多 3 个工作方/);
  }finally{await f.cleanup();}
});

test('leadScope reserves paths against every worker',async()=>{
  const f=await fixture();
  try{
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['docs'],leadScope:['docs']}),/路径租约冲突/);
    const first=await f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src/a'],leadScope:['docs','package.json']});
    assert.ok(first.workerId);
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['docs']}),/主导方租约/);
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['package.json']}),/共享文件只能由主导方修改/);
  }finally{await f.cleanup();}
});

test('overlapping scopes are refused and lease checks name the owner',async()=>{
  const f=await fixture();
  try{
    const first=await f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src']});
    const lease=await f.service.checkLease({session:f.session,paths:['src/a.txt','docs/x.md']});
    assert.deepEqual(lease.blocked,[{path:'src/a.txt',workerId:first.workerId}]);
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src/a']}),/路径租约冲突/);
    const docs=await f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['docs']});
    assert.ok(docs.workerId);
  }finally{await f.cleanup();}
});

test('a scope covering a shared file is refused before any worktree exists',async()=>{
  const f=await fixture();
  try{
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['package.json']}),/共享文件只能由主导方修改/);
    await assert.rejects(stat(join(f.project,'.sibyl','worktrees')).then(()=>true),/ENOENT/);
  }finally{await f.cleanup();}
});

test('an out-of-scope edit is flagged in the report',async()=>{
  const f=await fixture('evil');
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src'],prompt:'x'});
    const done=await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:200});return r.status==='completed'?r:null;});
    assert.deepEqual(done.report.scope.outOfScope,['docs/evil.txt']);
    assert.equal(done.report.needsReview,true);
  }finally{await f.cleanup();}
});

test('edits the lead makes inside the lease while a worker runs are reported',async()=>{
  const f=await fixture('hang');
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src']});
    await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:50});return r.status==='running'?r:null;});
    await writeFile(join(f.project,'src','a.txt'),'lead changed\n');
    git(f.project,'branch','lead-side');
    git(f.project,'branch','sibyl/worker/rogue');
    const closed=await f.service.close({session:f.session,workerId:started.workerId});
    assert.deepEqual(closed.report.leadChanges,['src/a.txt']);
    assert.deepEqual(closed.report.refsChanged.sort(),['refs/heads/lead-side','refs/heads/sibyl/worker/rogue']);
  }finally{await f.cleanup();}
});

test('project-level shared overrides are enforced',async()=>{
  const f=await fixture();
  try{
    await mkdir(join(f.project,'.sibyl'),{recursive:true});
    await writeFile(join(f.project,'.sibyl','shared-files.json'),JSON.stringify({add:['config']}));
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['config/x.json']}),/共享文件只能由主导方修改/);
  }finally{await f.cleanup();}
});

test('staged changes inside the worker scope are refused before dispatch',async()=>{
  const f=await fixture();
  try{
    await writeFile(join(f.project,'src','a.txt'),'staged\n');
    git(f.project,'add','src/a.txt');
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['src']}),/已暂存改动/);
  }finally{await f.cleanup();}
});

test('an unconfirmed exit keeps its lease until close confirms the tree is gone',async()=>{
  const f=await fixture();
  try{
    const record={id:'old',sourceSessionId:'s1',status:'orphan',stopReason:'exit-unconfirmed',childPid:process.pid,projectPath:f.project,repositoryKey:projectKey(f.project),scope:['src'],startedAt:new Date().toISOString()};
    const store={listWorkers:()=>[record],saveWorker:()=>{}};
    const service=createWorkerService({dataDir:f.dataDir,store,scripts:{codex:f.script,claude:f.script},isAlive:()=>false,killTree:async()=>true});
    await assert.rejects(service.start({session:{id:'s1',projectPath:f.project},tool:'codex',tier:'parallel',scope:['src']}),/路径租约冲突/);
    const closed=await service.close({session:{id:'s1'},workerId:'old'});
    assert.equal(closed.status,'interrupted');
    const allowed=await service.start({session:{id:'s1',projectPath:f.project},tool:'codex',tier:'parallel',scope:['src']});
    assert.ok(allowed.workerId);
    await service.close({session:{id:'s1'},workerId:allowed.workerId});
    service.stop();
  }finally{await f.cleanup();}
});

test('the watchdog uses the tier budget, not the consult numbers',async()=>{
  const limits={dispatch:{maxDurationMs:300,noProgressMs:300,windowMs:60000,maxPerWindow:10,maxLivePerSession:1,maxLivePerProject:2},parallel:{maxDurationMs:300,noProgressMs:300,windowMs:60000,maxPerWindow:10,maxLivePerSession:2,maxLivePerProject:4}};
  const f=await fixture('hang',limits);
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src'],prompt:'hang'});
    const stopped=await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:100});return r.status==='stopped'?r:null;},4000);
    assert.match(stopped.error,/超过最长运行时间|长时间没有收到/);
  }finally{await f.cleanup();}
});
```

注：`fixture` 第二参数直接传给 `createWorkerService({limits})`；测试结束后 `cleanup` 会 `stop()` 与 `closeAll()`。

- [ ] **Step 2: 跑测试确认失败**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 worker-service.test.mjs`
Expected: FAIL，`start` 没有租约/档位/共享文件校验，也没有 `checkLease` 或 `leadChanges`。

- [ ] **Step 3: 实现**

在 `start` 的同步段按顺序加入：`sharedExtra = await readSharedFiles(projectPath)` → 归一化 `leadScope`（可选）→ **只对 worker `scope`** 做共享文件检查 → `stagedPaths` 与 scope 求交（有交集就拒绝）→ 租约（请求 scope 对 live worker scope + 所有 live leadScope；`leadScope` 也不能与请求 scope 或已有租约重叠，但允许共享文件）→ `checkWorkerCapacity`（dispatch/parallel/consult 文案分开）；创建记录时生成 `leaseId` 并 push `{leaseId,repositoryKey:projectKey(projectPath),ownerSessionId:session.id,ownerRole:'worker',workerId,scope,generation}`；lead 租约按 `(repositoryKey,ownerSessionId,scope)` 复用并记录 `leaseIds`；收工按 `leaseId` 精确移除，lead 租约在无 live worker 引用时移除。工作树创建后把返回的 `leadDigest` 存为 `record.leadDigest`，并在同一 `setup` 里取 `record.refsBefore = await listRefs(projectPath)`；`finalize` 用 `scopeFingerprint(projectPath, scope)` 与 `fingerprintChanges(record.leadDigest, after)` 写 `report.leadChanges`；`truncated` 时追加 reviewReason；`refChanges(refsBefore, refsAfter, {ignore: liveBranches})` 写进 `report.refsChanged`，`liveBranches` 是收工那一刻其他 live 工作方的分支列表（含自己）。**服务补完 `leadChanges/refsChanged` 后必须重算 `reviewReasons` 与 `deliverable`**：越界/共享/不安全/leadChanges/refsChanged 任一项非空就把 `deliverable.path` 置 null 并原子重写 JSON。看门狗 `setInterval` 间隔取 `Math.min(1000,Math.max(50,Math.floor(limits.noProgressMs/4)))`，`unref()`；超时/无进展 → `stopReason`、走统一收工路径、`finalize('stopped', Error(...))`。`publicWorker` 补 `elapsedMs/idleMs/leadScope`。

并行上限默认 3：设计 §6 说第一阶段 N 收在 1，但 Phase B 明确要「多个工作方」；上限做成可配置（`maxLivePerSession`/`maxLivePerProject`），由租约保证路径不相交。

- [ ] **Step 4: 跑测试确认通过**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 worker-service.test.mjs`
Expected: PASS，22 个用例全过。

- [ ] **Step 5: 提交**

```bash
git add workers.mjs worker-service.test.mjs
git commit -m "feat(worker): enforce leases, tiers and worker budgets"
```

---

### Task 7: 持久化、native 端点与 control 接线

**Files:**
- Modify: `workspace.mjs`
- Modify: `native-inbox.mjs`
- Modify: `control.mjs`
- Modify: `workers.mjs`（加载持久化记录、孤儿判定）
- Test: `workspace.test.mjs`
- Test: `worker-daemon.test.mjs`（新建）
- Test: `worker-test-support.mjs`（新建，Task 8 / Task 10 共用）

**Interfaces:**
- `openWorkspace` 新增：`listWorkers() -> record[]`、`saveWorker(record)`（保留**所有 live 记录 + 所有 `orphan`/`exit-unconfirmed` 记录** + 最近 100 条已结束记录，按 `startedAt` 倒序，绝不能裁掉 `starting/running/orphan`）；打开库时把 `starting/running` 的工作方标成 `interrupted`，`error='后台已重启；该工作方未完成，工作树和分支保留。'`；`orphan` 记录原样保留。
- `openNativeInbox` 新增选项 `worker:{start,turn,result,close,list,check}`，新增端点（都在 `own(body)` 之后）：
  - `POST /worker/start` → 202 `worker.start({session:{...publicSession(s),projectPath:s.projectPath},tool,tier,scope,prompt?,model?,kind?,risk?,effort?,timeoutMs?})`
  - `POST /worker/turn` → `{workerId,prompt,timeoutMs?}`
  - `POST /worker/result` → `{workerId,waitMs}`（0..25000）
  - `POST /worker/close` → `{workerId}`
  - `POST /worker/accept` → `{workerId,accepted,note?}`
  - `POST /worker/list` → `{all?}`，返回 `{workers: publicWorker[]}`。
  - `POST /lease/check` → `{paths}`
  校验：`tool` ∈ codex/claude；`tier` ∈ consult/dispatch/parallel（consult 时 `scope` 可省略）；`scope` 为 1..64 个字符串；`leadScope` 可选、同样是 1..64 个字符串；`prompt` ≤20000；`model` 为 `auto` 或 ≤80 字符的模型名；`kind` ∈ review/implement/mechanical/frontier；`risk` ∈ normal/high；`effort` ∈ low/medium/high/ultra；`timeoutMs` 1000..600000；`workerId` 为 UUID；`accepted` 为 boolean、`note` ≤2000；错误文案 `Invalid worker start request` / `Invalid worker request`。
- `createWorkerService` 新增选项 `sessionAlive(id)->boolean` 与 `orphanGraceMs`；构造时加载 `store.listWorkers()` 并把历史 live 记录按 `interrupted` 展示。
- `createControl({...,workerLimits={},workerScripts,workerOrphanGraceMs=10*60*1000,sessionAlive})`：创建 `createWorkerService`，把接口挂到 `native-inbox` 的 `worker` 选项；`sessionAlive` 默认由 `nativeInbox.catalog()` 推导（`status==='available'`）。`state()` 增加 `workers: workers.list({all:true})`；`close()` 里 `await workers.closeAll(); workers.stop();`。
- 孤儿判定：看门狗发现 `sourceSessionId` 已不在 native catalog、且 `now-lastProgressAt > orphanGraceMs` 时，走统一收工路径并标 `orphan`，错误文案 `主导方会话已结束且工作方长时间没有进展，已作为孤儿停止；工作树和分支保留。`；`orphan` 加入工作方状态集合。

- [ ] **Step 1: 写失败测试**

`workspace.test.mjs` 追加：

```js
test('worker records persist and running ones become interrupted after a restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'workspace-workers-'));
  try{
    const first=await openWorkspace(dir);
    first.saveWorker({id:'w1',status:'running',startedAt:new Date().toISOString(),scope:['src'],projectPath:'/p'});
    first.saveWorker({id:'w2',status:'completed',startedAt:new Date().toISOString(),scope:['src'],projectPath:'/p'});
    assert.equal(first.listWorkers().length,2);
    first.close();
    const second=await openWorkspace(dir);
    try{
      const byId=Object.fromEntries(second.listWorkers().map(w=>[w.id,w]));
      assert.equal(byId.w1.status,'interrupted');
      assert.match(byId.w1.error,/后台已重启/);
      assert.equal(byId.w2.status,'completed');
    }finally{second.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('saving many ended workers never evicts a live one',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'workspace-workers-live-'));
  try{
    const ws=await openWorkspace(dir);
    ws.saveWorker({id:'live',status:'running',startedAt:new Date(0).toISOString(),scope:['src'],projectPath:'/p'});
    ws.saveWorker({id:'orphan',status:'orphan',stopReason:'exit-unconfirmed',startedAt:new Date(1).toISOString(),scope:['src'],projectPath:'/p'});
    for(let i=0;i<120;i++)ws.saveWorker({id:'done-'+i,status:'completed',startedAt:new Date(1000+i).toISOString(),scope:['src'],projectPath:'/p'});
    const workers=ws.listWorkers();
    assert.ok(workers.some(w=>w.id==='live'));
    assert.ok(workers.some(w=>w.id==='orphan'));
    assert.ok(workers.length<=122);
    ws.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});
```

新建 `worker-test-support.mjs`（Task 8 / Task 10 共用；文件名不匹配 `*.test.mjs`，不会被全量测试直接执行）：

```js
import {execFileSync,spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createControl} from './control.mjs';

export const git=(cwd,...args)=>execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com',...args],{cwd,encoding:'utf8'});
const fake=`import {writeFileSync,mkdirSync} from 'node:fs';import {join} from 'node:path';import {createInterface} from 'node:readline';
const mode='__MODE__';
process.stdout.write(JSON.stringify({type:'thread',threadId:'fake-'+process.pid,sessionId:'fake'})+'\\n');
const rl=createInterface({input:process.stdin});
rl.on('line',l=>{const c=JSON.parse(l);
 if(c.op==='close'){if(mode==='tree')return;process.stdout.write(JSON.stringify({id:c.id,type:'closed'})+'\\n');process.exit(0);}
 if(c.op!=='turn')return;
 if(mode==='hang')return;
 if(mode!=='read'){mkdirSync(join(process.cwd(),'src'),{recursive:true});writeFileSync(join(process.cwd(),'src','a.txt'),'worker\\n');}
 process.stdout.write(JSON.stringify({id:c.id,type:'turn',text:'done\\n<<<SIBYL_REPORT\\n{"summary":"done","verification":[],"unfinished":[],"blockers":[],"changeRequests":[]}\\nSIBYL_REPORT>>>',tools:[]})+'\\n');
});
rl.on('close',()=>process.exit(0));`;

export const wait=async(fn,ms=8000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,50));}throw Error('timed out');};

export async function workerFixture(mode='write',extras={}){
  const root=await mkdtemp(join(tmpdir(),'worker-daemon-'));
  const project=join(root,'project'),dir=join(root,'data'),script=join(root,'fake.mjs');
  await mkdir(join(project,'src'),{recursive:true});await writeFile(script,fake.replace('__MODE__',mode));
  git(project,'init','-q');await writeFile(join(project,'.gitignore'),'.sibyl/\n');await writeFile(join(project,'src','a.txt'),'base\n');
  git(project,'add','-A');git(project,'commit','-qm','base');
  const control=await createControl({dir,detect:async()=>({claude:'test',codex:'test'}),workerScripts:{codex:script,claude:script},runner:async()=>({session_id:'c',result:'consult ok'}),...extras});
  await new Promise(r=>control.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${control.server.address().port}`;
  const call=async(path,body)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{origin:base,'x-bridge-ui':control.csrf,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const v=await r.json();assert.equal(r.status,200,JSON.stringify(v));return v;};
  return {root,project,dir,control,call,close:async()=>{await control.close();await rm(root,{recursive:true,force:true});}};
}

export async function registerNative(f){
  const runtime=JSON.parse(await readFile(join(f.dir,'native-runtime.json'),'utf8'));
  const post=async(path,body)=>{const r=await fetch(new URL(path,runtime.url),{method:'POST',headers:{authorization:'Bearer '+runtime.token,'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();assert.ok(r.ok,JSON.stringify(v)+' (status '+r.status+')');return v;};
  const registered=await post('/register',{tool:'claude',title:'t',projectPath:f.project});
  const identity={id:registered.id,lease:registered.lease};
  return {runtime,post,call:async(path,body)=>post(path,{...identity,...body})};
}

export function mcpClient(dir,tool,cwd){
 const entry=fileURLToPath(new URL('./native-mcp.mjs',import.meta.url));
 const child=spawn(process.execPath,[entry,'--dir',dir,'--tool',tool],{cwd,stdio:['pipe','pipe','pipe'],windowsHide:true});
 const pending=new Map();let serial=0,stderr='',gone=false;
 const exited=new Promise(resolve=>child.once('close',()=>{gone=true;resolve();}));
 child.stderr.on('data',b=>stderr+=b);
 createInterface({input:child.stdout}).on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}const p=pending.get(value.id);if(!p)return;pending.delete(value.id);value.error?p.reject(Error(value.error.message)):p.resolve(value.result);});
 child.once('close',()=>{for(const p of pending.values())p.reject(Error('MCP exited: '+stderr));pending.clear();});
 return {child,exited,
  call(method,params={}){const id=++serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('MCP call timeout'));},15000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});},
  async tool(name,args={}){const value=await this.call('tools/call',{name,arguments:args});if(value.isError)throw Error(value.content[0].text);return JSON.parse(value.content[0].text);},
  async close(){if(gone)return;child.stdin.end();await exited;}};
}
```

`worker-daemon.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {workerFixture,registerNative,wait} from './worker-test-support.mjs';

test('the daemon exposes worker lifecycle over the local API',async()=>{
  const f=await workerFixture();
  try{
    const {call}=await registerNative(f);
    const started=await call('/worker/start',{tool:'codex',tier:'dispatch',scope:['src'],prompt:'go'});
    assert.equal(started.status,'starting');
    const done=await wait(async()=>{const r=await call('/worker/result',{workerId:started.workerId,waitMs:200});return r.status==='completed'?r:null;});
    assert.deepEqual(done.report.files.modified,['src/a.txt']);
    const listed=await call('/worker/list',{});
    assert.equal(listed.workers.length,1);
    assert.equal((await f.call('/api/status')).workers.length,1);
    const mechanical=await call('/worker/start',{tool:'codex',tier:'dispatch',scope:['src'],kind:'mechanical'});
    assert.equal(mechanical.model,'gpt-6-luna');
    assert.equal(mechanical.effort,'low');
    await call('/worker/close',{workerId:mechanical.workerId});
    const lease=await call('/lease/check',{paths:['package.json','src/a.txt']});
    assert.ok(lease.shared.includes('package.json'));
    await assert.rejects(call('/worker/result',{workerId:'00000000-0000-0000-0000-000000000000',waitMs:0}),/Unknown worker/);
  }finally{await f.close();}
});

test('a worker whose lead session disappeared becomes an orphan',async()=>{
  const f=await workerFixture('hang',{sessionAlive:()=>false,workerOrphanGraceMs:200});
  try{
    const {call}=await registerNative(f);
    const started=await call('/worker/start',{tool:'codex',tier:'dispatch',scope:['src'],prompt:'go'});
    const orphan=await wait(async()=>{const r=await call('/worker/result',{workerId:started.workerId,waitMs:100});return r.status==='orphan'?r:null;},4000);
    assert.match(orphan.error,/孤儿/);
  }finally{await f.close();}
});
```

`worker-daemon.test.mjs` 的导入只需 `test`、`assert` 与 `./worker-test-support.mjs` 的三个导出；`registerNative` 用 `native-runtime.json` 的 url+token 直接注册，不走二次 `openNativeInbox`。

- [ ] **Step 2: 跑测试确认失败**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 workspace.test.mjs worker-daemon.test.mjs`
Expected: FAIL，`listWorkers` 不存在；`/worker/start` 返回 Unknown endpoint。

- [ ] **Step 3: 实现**

`workspace.mjs`：`meta('workers')`、`listWorkers`、`saveWorker`（保留所有 live + 所有 orphan/exit-unconfirmed + 最近 100 条已结束，绝不能裁掉 `starting/running/orphan`），启动时把 `starting/running` 标 `interrupted`，`orphan` 原样保留。
`native-inbox.mjs`：按 Interfaces 增加 `worker` 选项与 6 个端点，放在 `own(body)` 之后；所有调用都带 `session:{...publicSession(s),projectPath:s.projectPath}`；`/worker/start` 返回 202。
`control.mjs`：`import {createWorkerService} from './workers.mjs'` 与 `normalizeWorkerLimits`；在 `consultStart` 附近声明 `let workerStart,workerTurn,workerResult,workerClose,workerAccept,workerList,workerCheck;`，`openNativeInbox` 传入 `worker:{start:i=>workerStart(i),...}`；`changed` 定义之后创建服务并赋值（`sessionAlive` 默认用 `nativeInbox.catalog()`，`orphanGraceMs:workerOrphanGraceMs`）；`state()` 加 `workers: workers.list({all:true})`；`close()` 里先设置 `workersClosing=true`（`start` 报 `Daemon is shutting down`），再 `await workers.closeAll(); await workers.stop();`，最后关 inbox/store。

- [ ] **Step 4: 跑测试确认通过**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 workspace.test.mjs worker-daemon.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add workspace.mjs native-inbox.mjs control.mjs workers.mjs workspace.test.mjs worker-daemon.test.mjs worker-test-support.mjs
git commit -m "feat(daemon): persist workers and expose them over the local API"
```

---

### Task 8: MCP 工具改名与转发

**Files:**
- Modify: `native-mcp.mjs`
- Delete: `spawn-tool.test.mjs`
- Create: `worker-tool.test.mjs`

**Interfaces:**
- Consumes: Task 7 的 `/worker/*`、`/lease/check`。
- Produces 工具（旧的 `bridge_spawn*` 删除）：
  - `bridge_worker_start({tool,tier,scope?,leadScope?,prompt?,model?,kind?,risk?,effort?,timeoutMs?})` → `{workerId,status:'starting',scope,leadScope,tier,model,effort,worktreePath,branch,leadMustWaitFor,notice}`；`tier:'consult'` 时 `scope` 可省略；`model` 默认 `"auto"`。
  - `bridge_worker_turn({workerId,prompt,timeoutMs?})` → 立即返回 `{workerId,turnId,status:'running',accepted:true}`（不等待整轮）。
  - `bridge_worker_result({workerId,waitMs?})`：`starting/running` 时最多等 25 秒；如果 `lastTurn.status` 已经是 `completed`/`failed`，立即返回，不再等满。返回 `{...,lastTurn}` 与 `notice:'Still running; keep workerId and call bridge_worker_result; do not resubmit.'`。
  - `bridge_worker_close({workerId})`。
  - `bridge_worker_accept({workerId,accepted,note?})` → 记录主导方验收结果。
  - `bridge_worker_list({all?})`。
  - `bridge_lease_check({paths})` → `{allowed,blocked,shared,invalid}`。
- `--spawn-script` / `--claude-spawn-script` 从 `native-mcp.mjs` 移除（脚本归 daemon）。
- 参数校验循环补数组：`type:'array'` 时必须是 1..64 个非空字符串、每项 ≤1024。`bridge_worker_start` 在转发前先校验语义：`tool must be codex or claude`、`tier must be consult, dispatch or parallel`、非 consult 时缺少 scope 报 `scope is required unless tier is consult`、`model` 默认 `auto`、`kind` 默认 null、`risk` 默认 normal。

- [ ] **Step 1: 写失败测试 `worker-tool.test.mjs`**

复用 `worker-test-support.mjs`（Task 7 建好的临时 git 仓库 + 注入假脚本 + MCP 客户端）：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {workerFixture,mcpClient,wait} from './worker-test-support.mjs';
```

用例：

```js
test('bridge_worker_start dispatches and result returns the git report',async()=>{
  const f=await workerFixture();
  const c=mcpClient(f.dir,'claude',f.project);
  try{
    const started=await c.tool('bridge_worker_start',{tool:'codex',tier:'dispatch',scope:['src'],prompt:'go'});
    assert.equal(started.status,'starting');
    assert.deepEqual(started.leadMustWaitFor,['src']);
    const done=await wait(async()=>{const r=await c.tool('bridge_worker_result',{workerId:started.workerId,waitMs:1000});return r.status==='completed'?r:null;});
    assert.deepEqual(done.report.files.modified,['src/a.txt']);
    assert.ok(done.report.patchPath.endsWith(started.workerId+'.patch'));
    assert.ok(!JSON.stringify(done).includes('diff --git'));
  }finally{await c.close();await f.close();}
});

test('overlapping scopes and shared files are refused through the MCP layer',async()=>{
  const f=await workerFixture();
  const c=mcpClient(f.dir,'claude',f.project);
  try{
    const first=await c.tool('bridge_worker_start',{tool:'codex',tier:'parallel',scope:['src']});
    await assert.rejects(c.tool('bridge_worker_start',{tool:'codex',tier:'parallel',scope:['src/a']}),/路径租约冲突/);
    await assert.rejects(c.tool('bridge_worker_start',{tool:'codex',tier:'dispatch',scope:['package.json']}),/共享文件只能由主导方修改/);
    const check=await c.tool('bridge_lease_check',{paths:['src/a.txt','docs/x.md']});
    assert.equal(check.allowed,false);
    assert.deepEqual(check.blocked,[{path:'src/a.txt',workerId:first.workerId}]);
    await c.tool('bridge_worker_close',{workerId:first.workerId});
  }finally{await c.close();await f.close();}
});

test('worker tools reject malformed arguments before contacting the daemon',async()=>{
  const f=await workerFixture();
  const c=mcpClient(f.dir,'claude',f.project);
  try{
    await assert.rejects(c.tool('bridge_worker_start',{tool:'cursor',tier:'dispatch',scope:['src']}),/Invalid tool|tool must be/);
    await assert.rejects(c.tool('bridge_worker_start',{tool:'codex',tier:'meeting',scope:['src']}),/tier must be consult, dispatch or parallel/);
    await assert.rejects(c.tool('bridge_worker_start',{tool:'codex',tier:'dispatch',scope:'src'}),/Invalid scope/);
    await assert.rejects(c.tool('bridge_worker_start',{tool:'codex',tier:'dispatch'}),/scope is required unless tier is consult/);
    await assert.rejects(c.tool('bridge_worker_result',{workerId:'00000000-0000-0000-0000-000000000000',waitMs:10}),/Unknown worker/);
  }finally{await c.close();await f.close();}
});

test('bridge_worker_turn returns before the turn finishes',async()=>{
  const f=await workerFixture('hang');
  const c=mcpClient(f.dir,'claude',f.project);
  try{
    const started=await c.tool('bridge_worker_start',{tool:'codex',tier:'parallel',scope:['src']});
    await wait(async()=>{const r=await c.tool('bridge_worker_result',{workerId:started.workerId,waitMs:100});return r.status==='running'?r:null;});
    const before=Date.now();
    const turn=await c.tool('bridge_worker_turn',{workerId:started.workerId,prompt:'work'});
    assert.ok(Date.now()-before<1000,'turn waited for completion');
    assert.equal(turn.accepted,true);
    const state=await c.tool('bridge_worker_result',{workerId:started.workerId,waitMs:50});
    assert.equal(state.lastTurn.status,'running');
    await c.tool('bridge_worker_close',{workerId:started.workerId});
  }finally{await c.close();await f.close();}
});

test('bridge_worker_accept records the lead decision and rejects an unfinished worker',async()=>{
  const f=await workerFixture('hang');
  const c=mcpClient(f.dir,'claude',f.project);
  try{
    const started=await c.tool('bridge_worker_start',{tool:'codex',tier:'dispatch',scope:['src'],prompt:'go'});
    await assert.rejects(c.tool('bridge_worker_accept',{workerId:started.workerId,accepted:true}),/has not finished/);
    await c.tool('bridge_worker_close',{workerId:started.workerId});
    const accepted=await c.tool('bridge_worker_accept',{workerId:started.workerId,accepted:false,note:'please split'});
    assert.equal(accepted.report.acceptance,'rejected');
    assert.equal(accepted.report.acceptanceNote,'please split');
  }finally{await c.close();await f.close();}
});

test('closing the MCP process no longer kills the daemon-owned worker',async()=>{
  const f=await workerFixture('hang');
  const c=mcpClient(f.dir,'claude',f.project);
  try{
    const started=await c.tool('bridge_worker_start',{tool:'codex',tier:'dispatch',scope:['src'],prompt:'hang'});
    await c.close();
    const after=await wait(async()=>{const state=await f.call('/api/status');return state.workers.find(w=>w.workerId===started.workerId&&w.status==='running')||null;});
    assert.equal(after.status,'running');
  }finally{await f.close();}
});
```

`/api/status` 的 `workers` 每项必须带 `workerId` 字段（与服务对外的命名一致）。

- [ ] **Step 2: 跑测试确认失败**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 worker-tool.test.mjs`
Expected: FAIL，`Unknown tool`（schema 里没有 `bridge_worker_start`）。

- [ ] **Step 3: 实现 `native-mcp.mjs`**

删除 `spawnSettings/startSpawn/spawnTurn/closeSpawn/spawns/SPAWN_MAX/SPAWN_TIMEOUT` 与两个 `--*-spawn-script` 选项；`definitions` 换成 7 个新工具；`tool()` 里 `bridge_worker_start` 先做 tool/tier/scope 语义校验（consult 允许省略 scope），再用 `local('/worker/start',{...identity,...args})` 转发；`bridge_worker_result` 的轮询条件是「worker 仍是 `starting/running` **且** `lastTurn` 仍是 `running`」，`lastTurn` 一结束就返回；`close()` 不再关闭 spawns。数组参数校验加进通用循环。

- [ ] **Step 4: 跑测试确认通过**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 worker-tool.test.mjs`
Expected: PASS，6 个用例全过；`git status` 里 `spawn-tool.test.mjs` 已删除。

- [ ] **Step 5: 提交**

```bash
git rm spawn-tool.test.mjs
git add native-mcp.mjs worker-tool.test.mjs
git commit -m "feat(mcp): replace bridge_spawn with daemon-backed worker tools"
```

---

### Task 9: 档位 Skill 与文档

**Files:**
- Create: `skills/agents-calling/SKILL.md`
- Modify: `README.md`
- Modify: `使用说明.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Task 8 的 6 个工具与现有 `bridge_consult*`。
- Produces: 无代码接口。

- [ ] **Step 1: 写 Skill**

`skills/agents-calling/SKILL.md` 必须包含：

```markdown
---
name: agents-calling
description: Use when the user says "你和 Codex/Claude 协作", asks another local AI tool to review or change this repository, or wants two tools to work on different parts. All discussions with Codex must be visible in its chat list, so questions go through bridge_ask to the live Codex chat; changes go through bridge_worker_*.
---

# Agents Calling 协作档位

收到「你和 X 协作」时，先选档位，不要问人：

| 档位 | 什么时候 | 用什么 | 是否合并 |
|---|---|---|---|
| 问一下 | 只需要对方看、评、核对，不改文件 | `bridge_worker_start({tier:"consult",prompt})`：自动新建可见的只读 Codex 会话；要续原会话用 `bridge_ask`；后台核对才用 `bridge_consult` | 不合并 |
| 派个活 | 一块改动，一个工作方动手 | `bridge_worker_start`（`tier:"dispatch"`） | 主导方验收后贴补丁 |
| 分头干 | 两块以上互不相交的改动 | 多次 `bridge_worker_start`（`tier:"parallel"`）+ 不相交 `scope` | 按顺序贴补丁 |

## 第 0 步：和 Codex 的讨论必须可见

所有讨论（评审、核对、问答）必须自动出现在 Codex 桌面聊天列表里，不需要人做中间操作。默认用 `bridge_worker_start({tier:"consult"})` 或 `bridge_spawn` 新建一个只读 Codex 会话，把问题作为 `prompt` 发进去；它走 app-server，会进列表。长评审的 `timeoutMs` 用 600000。`bridge_ask` 只用于续接已有原会话（不唤醒，需对方 `bridge_receive`）；`bridge_consult` 是后台 `codex exec` Worker，不进列表，仅人明确同意时用，事后必须同步到可见会话。

## 第 1 步：大计划先评审

写实施计划之后、动代码之前，如果属于**大计划**，先用上面的可见方式让 Codex 评审计划，拿到回答并采纳后再开工：

- 必评项（不看任务数）：新增/删除/改公共接口（工具、HTTP 端点、持久化字段、鉴权、配置格式、模块导出）；改变并发所有权（锁、租约、进程生命周期、异步/超时/取消/重启）；自动 git 写、数据迁移/删除、部署等不可逆操作；偏离已批准设计。
- 规模兜底：≥5 个可独立交付任务（测试步骤不算任务），或 ≥5 个产品代码文件，或新增模块/目录。
- 小计划可跳过：1–2 个任务、≤3 个产品文件、无必评项、可逆、≤30 分钟。
- 边界不清按大计划处理；Codex 原会话不在线时停下来告诉人，不要静默跳过。

**模型选择：** 默认 `model:"auto"`，不要手动指定。用 `kind` 和 `risk` 告诉 daemon 任务形状：
- `kind:"mechanical"`（改名、格式、文档小修）→ 便宜快的 `gpt-6-luna` + low；
- `kind:"review"` + `risk:"normal"`（普通评审）→ `gpt-6.1-terra` + medium；
- `kind:"review"` + `risk:"high"`（并发/租约/持久化/安全/不可逆）→ `gpt-6.1-sol` + high；
- `kind:"implement"` → `gpt-6.1-sol` + medium，`risk:"high"` 时 high；
- `kind:"frontier"`（确实很难、前几次都失败）→ `gpt-6-astra` + high。

只有人明确要求换模型时才传 `model`；`bridge_worker_result`/`bridge_worker_list` 会回显实际使用的 `model` 和 `effort`。

**规则：**
- `scope` 写项目相对路径，只列这次真的要改的目录/文件；共享文件（package.json、锁文件、tsconfig、.github/.claude 等）不能进 scope，工作方要改只能写进 `changeRequests`。主导方自己要改的路径用 `leadScope` 登记，工作方就不能占用。
- 派活后主导方不得改该 `scope` 内的文件；需要动时先 `bridge_worker_result` 等它交工，或用 `bridge_lease_check` 确认。
- `bridge_worker_start` 立刻返回 `workerId`；用 `bridge_worker_result` 轮询，不要重复派同一件事。`bridge_worker_turn` 只入队，轮次结果看 `result.lastTurn`。
- 验收看报告里的 `files`、`stats`、`scope.outOfScope`、`scope.sharedChanged`、`unsafeChanges`、`verification`、`verificationSource`、`acceptanceCriteria`、`risks`、`blockers`、`leadChanges`、`refsChanged`。只有 `deliverable.path` 非空时才贴 `<workerId>.deliverable.patch`；为 null 时先让工作方修正或人工处理，不要贴全量 patch。验收完成后调用 `bridge_worker_accept` 记录 accepted/rejected。
- 贴补丁协议：一次只贴一个；贴前 `git status` 记下主导方已有的 staged/unstaged 改动，并重新 `bridge_lease_check`；**只用 `git apply <deliverable.patch>`，失败就停下来报告，不自动解、不 `reset`、不用 `--3way`/`--index`**。主导方在 scope 内有 staged 改动时不要贴，先提交或取消暂存。贴完用 `bridge_worker_accept` 记录验收结果。
- Codex 在 Windows 沙箱内跑不了测试，`verification` 是工作方自报，测试由主导方在沙箱外执行。
- 非 git 项目不能派活，只能「问一下」。
```

- [ ] **Step 2: 更新文档与 ignore**

- `.gitignore` 增加 `/.sibyl/`。注意：`.gitignore` 里已有一行未提交的 `/.claude/settings.local.json`，它与 `/.sibyl/` 都是本地运行产物，一起提交。
- `README.md` 能力清单：把 `bridge_spawn` 那段换成 `bridge_worker_start/turn/result/close/list` 与 `bridge_lease_check`，并写一句「三档由 `skills/agents-calling` 判断；`model:"auto"` 按任务形状选 Codex 模型」。
- `使用说明.md` 第 9 条：改写成 worker 流程（`tier`、`scope`、共享文件、快照、报告路径 `.sibyl/reports/<workerId>.patch`、主导方验收与贴补丁、Codex 自验限制、非 git 拒绝），并说明 `model`/`kind`/`risk` 的自动选择与覆盖方式。

- [ ] **Step 3: 检查文档没有旧工具名**

Run: `grep -rn "bridge_spawn" README.md 使用说明.md skills || true`
Expected: 无输出。

- [ ] **Step 4: 提交**

```bash
git add skills/agents-calling/SKILL.md README.md 使用说明.md .gitignore
git commit -m "docs(skill): add the collaboration tier skill"
```

---

### Task 10: 三档端到端覆盖与全量验证

**Files:**
- Create: `tiers.test.mjs`
- 不改产品代码。

**Interfaces:**
- Consumes: Task 7/8 的 daemon + MCP。

- [ ] **Step 1: 写 `tiers.test.mjs`**

用 `worker-test-support.mjs` 的 fixture 与客户端：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {stat,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {workerFixture,mcpClient,wait,git} from './worker-test-support.mjs';
test('问一下 uses a read-only visible worker and creates no worktree',async()=>{
  const f=await workerFixture('read');const c=mcpClient(f.dir,'claude',f.project);
  try{
    const started=await c.tool('bridge_worker_start',{tool:'codex',tier:'consult',prompt:'look at src'});
    const done=await wait(async()=>{const r=await c.tool('bridge_worker_result',{workerId:started.workerId,waitMs:500});return r.status==='completed'?r:null;});
    assert.equal(done.worktreePath,null);
    assert.equal(done.report.patchPath,undefined);
    await assert.rejects(stat(join(f.project,'.sibyl')),/ENOENT/);
  }finally{await c.close();await f.close();}
});

test('派个活 runs one live worker and refuses a second',async()=>{
  const f=await workerFixture('hang');const c=mcpClient(f.dir,'claude',f.project);
  try{
    const one=await c.tool('bridge_worker_start',{tool:'codex',tier:'dispatch',scope:['src'],prompt:'go'});
    await wait(async()=>{const r=await c.tool('bridge_worker_result',{workerId:one.workerId,waitMs:100});return r.status==='running'?r:null;});
    await assert.rejects(c.tool('bridge_worker_start',{tool:'codex',tier:'dispatch',scope:['docs'],prompt:'again'}),/只能有一个工作方/);
    const closed=await c.tool('bridge_worker_close',{workerId:one.workerId});
    assert.equal(closed.status,'stopped');
  }finally{await c.close();await f.close();}
});

test('a deliverable patch applies over dirty files, including the worker file',async()=>{
  const f=await workerFixture();const c=mcpClient(f.dir,'claude',f.project);
  try{
    await mkdir(join(f.project,'docs'),{recursive:true});
    await writeFile(join(f.project,'docs','lead.txt'),'clean\n');
    git(f.project,'add','-A');git(f.project,'commit','-qm','docs');
    await writeFile(join(f.project,'docs','lead.txt'),'lead dirty\n');
    await writeFile(join(f.project,'src','a.txt'),'lead dirty\n');
    const started=await c.tool('bridge_worker_start',{tool:'codex',tier:'dispatch',scope:['src'],prompt:'go'});
    const done=await wait(async()=>{const r=await c.tool('bridge_worker_result',{workerId:started.workerId,waitMs:1000});return r.status==='completed'?r:null;});
    assert.ok(done.report.deliverable.path);
    git(f.project,'apply',done.report.deliverable.path);
    assert.equal(await readFile(join(f.project,'src','a.txt'),'utf8'),'worker\n');
    assert.equal(await readFile(join(f.project,'docs','lead.txt'),'utf8'),'lead dirty\n');
  }finally{await c.close();await f.close();}
});

test('分头干 keeps two disjoint workers alive and rejects overlap',async()=>{
  const f=await workerFixture();const c=mcpClient(f.dir,'claude',f.project);
  try{
    const a=await c.tool('bridge_worker_start',{tool:'codex',tier:'parallel',scope:['src']});
    const b=await c.tool('bridge_worker_start',{tool:'codex',tier:'parallel',scope:['docs']});
    const list=await c.tool('bridge_worker_list',{});
    assert.deepEqual(list.workers.map(w=>w.workerId).sort(),[a.workerId,b.workerId].sort());
    await assert.rejects(c.tool('bridge_worker_start',{tool:'codex',tier:'parallel',scope:['src/x']}),/路径租约冲突/);
    await c.tool('bridge_worker_close',{workerId:a.workerId});
    await c.tool('bridge_worker_close',{workerId:b.workerId});
  }finally{await c.close();await f.close();}
});

test('the symmetric Claude worker hands off through the daemon',async()=>{
  const f=await workerFixture();const c=mcpClient(f.dir,'claude',f.project);
  try{
    const started=await c.tool('bridge_worker_start',{tool:'claude',tier:'dispatch',scope:['src'],prompt:'go'});
    const done=await wait(async()=>{const r=await c.tool('bridge_worker_result',{workerId:started.workerId,waitMs:1000});return r.status==='completed'?r:null;});
    assert.deepEqual(done.report.files.modified,['src/a.txt']);
  }finally{await c.close();await f.close();}
});
```

`scope:['docs']` 不要求目录已存在，租约只按声明路径判断。

- [ ] **Step 2: 跑新测试确认通过**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 tiers.test.mjs`
Expected: PASS，5 个用例全过。

- [ ] **Step 3: 跑全量测试**

Run: `"$NODE26" --test --test-concurrency=1 --test-timeout=30000 *.test.mjs`
Expected: 全部通过。任何失败都先停下来修复，不要用 `--test-skip` 绕过。

- [ ] **Step 4: 提交**

```bash
git add tiers.test.mjs
git commit -m "test(tiers): cover consult, dispatch and parallel end to end"
```

- [ ] **Step 5: 发阶段通知**

```bash
node scripts/notify-wechat.mjs --title "Phase B 完成" --body "三档、路径租约、共享文件边界、派活前快照、结构化交工报告与按档位预算已落地；全量测试通过。观测页（Phase C）还没做。"
```

---

## Self-Review

**Spec coverage**

- G2 三档 → Task 9（Skill 判档）+ Task 6（dispatch/parallel 上限）+ Task 10（三档用例）。
- G3 可验收 → Task 4（git 为准的报告 + 补丁落盘）+ Task 5/6（收工时生成）。
- G4 写边界 → Task 2（scope/共享文件/租约）、Task 3（快照且不动主导方分支）、Task 6（主导方改动检测 + 派活后 ref 比对）。
- G5 观测页 → 不在 Phase B 范围；Task 7 把 `workers` 放进 `/api/status` 供 Phase C 使用。
- 「生命周期归 daemon」→ Task 5/7；MCP 只转发 → Task 8。
- 「按档位重设预算」→ Task 1 + Task 6 看门狗。
- 「合并由主导方执行，daemon 只比对 ref」→ Task 3 `listRefs/refChanges` + Task 6 `report.refsChanged`；贴补丁与三方合并写在 Task 9 的 Skill 里。
- 「报告写文件、正文只回摘要」→ Task 4 + Task 8 的断言（工具结果不含 `diff --git`）。
- 非 git 拒绝 → Task 3 + Task 5 的早期拒绝用例。

**Review Focus 对应测试**

1. 共享文件/段边界 → Task 2 的 `scopeSharedConflicts`、`scopeOverlaps(['src/a'],['src/ab'])`、Task 6 的共享文件拒绝。
2. 快照泄漏/主导方分支 → Task 3 第一个用例（`.env` 不存在、`HEAD`/`status` 不变）。
3. 自报与 git 不符 → Task 4 的 `files and diff come from git, not from the worker say-so`。
4. 越界改动 → Task 4 的 `out-of-scope` 用例 + Task 6 的 `evil` 用例。
5. 重启/超时残留 → Task 7 的 `interrupted` 持久化 + Task 6 的看门狗用例。

**Type consistency**

- `workerId` 在服务、端点、MCP、报告、测试里统一；记录主键用 `id`，对外一律 `workerId`。
- `scope` 始终是字符串数组；`checkLease` 的参数叫 `paths`。
- 状态集合统一：`starting|running|completed|failed|stopped|interrupted|orphan`。
- 报告字段统一 `files/stats/scope/unsafeChanges/verification/verificationSource/unfinished/blockers/changeRequests/summary/reported/needsReview/reviewReasons/deliverable`；`leadChanges/refsChanged` 由服务在 finalize 时补上。

---

## Codex review

**评审时间：** 2026-11-08。**方式：** 第一次用 `bridge_consult`（consultId `c8a26131-8fe3-41e9-8cdf-b15780c0ec2e`）拿到了完整意见；用户指出「所有与 Codex 的讨论必须出现在 Codex 聊天列表」后，同一份请求已用 `bridge_ask` 发到 Codex 原会话（questionId `2bce2db3-32bf-447f-9ae8-19feb52e09db`，排队中，回复后补录）。

**结论：** 方向可行，但原计划不宜直接执行；以下 P1/P2 已修进计划。

| # | Codex 意见 | 处理 |
|---|---|---|
| 1 | 补丁验收没覆盖「主导方有未提交改动」 | 报告新增 `deliverable.path`：只有 scope 内、非共享、非符号链接/子模块的改动才写 `.deliverable.patch`；Task 10 新增「脏工作区 + `git apply --3way`，原有改动保留」的贯穿测试；Task 9 Skill 写死贴补丁协议 |
| 2 | 停止/收工/释放租约缺少并发协议 | `finalize` 只允许一个 promise；固定顺序「取消 setup → 拒绝在跑轮次 → 关子进程并等 `close` → SIGKILL 兜底 → 提交 → 报告 → 释放租约」；Task 5 新增 starting 期关闭、子进程退出两个测试 |
| 3 | 异步接口不完整：turn 会撞 30 秒 HTTP 超时 | `turn` 只入队并立即返回 `accepted`；结果走 `result.lastTurn`；`/worker/start` 返回 202；`worktreePath` 明确为预定路径；Task 5/8 各加「turn 立即返回」测试 |
| 4 | scope + 指纹不是硬边界 | 交付层收紧：越界/共享/链接/子模块一律 `deliverable.path=null`；新增 `leadScope` 租约；指纹截断进 `reviewReasons`；`refsChanged` 只忽略 live worker 分支，不再忽略整个 `sibyl/*` |
| 5 | 快照有完整性风险（ignored tracked、staged deletion、符号链接、子模块、`.sibyl` 污染） | 快照清单改为 `tracked - trackedIgnored + untracked`；用 HEAD 清单删除缺失文件；lstat 分支处理文件/链接/目录；子模块建树前拒绝；`ensureSibylExcluded` 写 `.git/info/exclude`；Task 3 加 4 个测试 |
| 6 | 报告不足以代表「可验收」 | 报告补 `snapshotCommit/headCommit`、`verificationSource:'worker-self-report'`、`reviewReasons`、`unsafeChanges`、`deliverable`；git 解析用 `-z`；rename 两端检查；64MB 超限记为不可交付 |
| 7 | 测试样例自相矛盾 | dispatch/parallel 容量测试拆开；`registerNative.post` 接受 202；Task 4 的 policy 导入改到 `worker-policy.mjs`；修正假 worker 的 mode 注入 |
| 8 | 设计覆盖遗漏与偏离 | 补 `leadScope`、孤儿判定（`orphan` + grace）、贴补丁串行协议（Skill）、持久化不裁 live 记录、refs 忽略范围收窄。**范围偏离已定：设计 §6 同步为 Phase B 默认 N=3，可配置回 1。** |

**未采纳/待确认：**

- 「执行期阻止工作方越界写入」需要工具写权限或 OS 沙箱；本计划选择「交付层拒绝越界补丁 + 报告标记」，不做文件系统劫持。
- 共享类型目录仍靠项目级 `.sibyl/shared-files.json` 补充，不做通用自动发现。
- N=3 已定（设计已同步）；要改回 1 只需把 `WORKER_LIMITS.parallel.maxLivePerSession` 设为 1。

### 第二轮评审（可见会话）

**时间：** 2026-11-08。**方式：** `bridge_spawn` 自动新建 Codex app-server 会话（threadId `01a1bab4-19e8-76a2-bda3-9f8d3edcf98e`，originator `sibyl_spawn_codex_chat`，会出现在 Codex 聊天列表），`bridge_spawn_turn` 跑完整评审。首次用 120000 的 spawn 超时会在 2 分钟被杀，改为 spawn 时就传 600000。

**结论：** 方向成立，现稿仍有 P1，不建议直接开工。已按下列方式修订：

| 意见 | 处理 |
|---|---|
| 1. 脏工作区交付：`git apply --3way` 隐含 index 检查；测试只弄脏无关文件 | 交付协议改为先 `git apply` 再 `--3way`，禁用 `--index`；Task 10 改为「工作方修改的文件本身在派活前就是 dirty」；主导方 scope 内有 staged 改动时 `start` 直接拒绝（Task 6 新增 `stagedPaths` 求交与测试） |
| 2. 包装进程退出不等于工作方停止；关闭排在长轮次后面 | Task 5 要求改两个 launcher：收到 close/SIGTERM 立即终止下游；daemon 用 `taskkill /T /F`（Windows）/ 进程组（POSIX）；新增「孙进程持续写文件」与「子进程退出」两个测试；退出无法确认时不提交、不释放租约 |
| 3. 快照与取消竞态；指纹在复制后采集 | Task 5 保存 `setupPromise`，finalize 先等它结束；Task 3 在复制前后比对 HEAD 与 status，变化则重试一次后拒绝 |
| 4. 租约身份/释放漏洞；leadScope 不能含共享文件 | 租约条目补 `leaseId/repositoryKey/ownerSessionId/ownerRole/generation`；按 leaseId 精确释放；lead 租约按 (repo,session,scope) 复用；只对 worker scope 做共享文件校验，leadScope 允许 package.json |
| 5. Git 纪律与交付阻断未闭环 | WORKER_POLICY 明确禁止 git 写命令；服务补完 leadChanges/refsChanged 后重算 reviewReasons/deliverable 并原子重写 JSON；daemon 提交前断言当前分支与 snapshot 祖先（Task 5） |
| 6. 测试与契约矛盾 | dispatch/parallel 容量测试拆开并修正计数；Task 1 的 parallel 项目上限测试改为 4 条 live；`turn` 测试先等 `running`；Task 8 的 tier 错误文案与 202 处理修正 |
| 7. 异步/恢复语义 | `turn` 只入队；`result.lastTurn` 结束即返回，不等满 25 秒；launcher 启动时固定 600000；control 关闭期拒绝新 start |
| 8. Windows/git 细节 | exclude 用 `git rev-parse --git-path info/exclude`；清理校验真实路径/reparse/worktree 归属；去掉 `node_modules` junction（零依赖）；子模块建树前拒绝；长路径/CRLF 作为已知限制写入 Skill |
| 9. 报告能证明改动，不能证明验收 | 报告补 `acceptanceCriteria`、`risks`、验证元数据（cwd/Node 版本/exitCode/logPath/testedTree）、`acceptance:'pending'`；新增 `bridge_worker_accept` 记录主导方验收；`reported:false`/验证缺失/阻塞进入 reviewReasons |
| 设计覆盖 | consult 档改为 `bridge_worker_start(tier:"consult")` 的可见只读会话；补 staged-in-scope 拒绝、Claude 全链路用例、`scope:['web']` 含 `web/package.json` 的拒绝测试；N=3 已定并与设计同步 |

**已定/不再阻塞开工：**

1. N=3 已定：Phase B 任务单明确要求多个工作方，设计 §6 已同步为「默认 N=3，可配置回 1」。
2. 继续用 worktree（符合设计）；独立 clone 只作为未来隔离共享 `.git` 的升级项，不作为开工前置。
3. Phase B 只承诺**单主导方串行集成**：贴补丁靠 Skill 的「一次只贴一个」+ 租约；不做跨会话 daemon 级集成锁。若以后承诺多主导方并发集成，再补硬互斥。
4. `node_modules` junction 已删除（零依赖）；有依赖的项目如何共用依赖，留到 Phase D 安装流程。

### 第三/四轮复核（同一可见会话）

第二轮之后又做了两次 delta 复核，全部在同一 Codex 会话（threadId `01a1bab4-19e8-76a2-bda3-9f8d3edcf98e`）里完成：

- 第三轮指出 6 个必须改：快照内容指纹、exit-unconfirmed 与重启租约冲突、result 两层等待、两处测试矛盾、「已修复」未落到步骤、N 默认未定。均已修入 Task 1/3/4/5/6/8 与设计 §6。
- 第四轮指出 4 个必须改：finalize 取消顺序、exit-unconfirmed 之后仍继续提交、Task 6 残留旧 `leadFingerprint` 采集、Skill 残留 `--3way`。均已修入 Task 5/6/9。
- 最终 Codex 回复：**「可开工」**（2026-11-08）。

**模型策略增量（同一可见会话）：** 新增 `model:'auto'` + `kind/risk` 与 `chooseCodexModel`。Codex 指出 4 点：Task 7 未转发参数、要按 tool 分流、显式覆盖与不支持模型要失败、未知值契约不统一。已修入 Task 1/5/7/8/9，并补「launcher 收到 `--model/--effort`」「Claude auto 不传模型」「显式 effort 覆盖」「不支持的 model 失败」四个测试；Codex 最终回复**「可开工」**。
