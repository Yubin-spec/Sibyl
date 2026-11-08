# Phase A：对称工作方 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Codex 能派一个会写文件的 Claude 工作方，和现有 Codex 工作方走同一套 RPC 与工具接口。

**Architecture:** 新增 `scripts/spawn-claude-chat.mjs`：每轮启动一次 `claude -p --output-format json`，首轮结果里的 `session_id` 作为下一轮 `--resume` 的凭据，因此一个工作方 = 一串无状态进程 + 一个会话 ID。`native-mcp.mjs` 的 `bridge_spawn*` 增加 `tool` 参数（`codex` | `claude`），按工具选择启动脚本。工作方生命周期仍在 `native-mcp` 进程内；移到 daemon 是 Phase B。

**Tech Stack:** Node.js >= 26、`node:test`、零第三方 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-11-08-agent-collaboration-design.md`

## Global Constraints

- Node >= 26；不新增任何 npm 依赖。
- 只在 `feat/windows-support` 的扁平布局上改；不碰 `develop`，不引入 `src/` 路径。
- 工作方默认无网络、不装依赖；需要确认的操作直接失败，并作为阻塞项写进结果。
- 工具名沿用 `bridge_spawn` / `bridge_spawn_turn` / `bridge_spawn_close`（Phase B 再改名）。
- 测试文件放仓库根目录，命名 `*.test.mjs`，用 `npm test` 运行。
- 路径与平台差异必须同时兼容 Windows 和 POSIX；现有 `resolveExecutable` 已处理 `.cmd`/`.ps1` 与 npm shim。

## Review Focus

- `claude` 可执行文件不存在，或路径含空格：必须给出可读错误，不能挂住。
- 首轮没有返回 `session_id`：下一轮不得盲目 `--resume`，必须重新开一轮且报告原因。
- 同一个 spawn 上并发两轮：必须立刻拒绝，与 Codex 工作方一致。
- 单轮超时：必须杀掉子进程并抛错，不留孤儿进程。
- 未知 `tool` 或非法 `sandbox`：在启动任何进程之前拒绝。

---

### Task 1: 先落地工作区里已有的 spawn 改动

**Files:**
- Test: `spawn-tool.test.mjs`、`runtime.test.mjs`（已有）
- Modify: `control.mjs`、`native-inbox.mjs`、`native-mcp.mjs`、`runtime.mjs`、`scripts/live-session-mcp.mjs`、`scripts/spawn-codex-chat.mjs`、`scripts/verify-real-mcp.mjs`、`start-browser.ps1`
- Create (untracked): `scripts/verify-real-autobind.mjs`、`spawn-tool.test.mjs`

**Interfaces:**
- Consumes: 无。
- Produces: 后续任务依赖的 `listеnLoopback`（`runtime.mjs`）与 `scripts/spawn-codex-chat.mjs` 的 `--rpc` 模式；它们必须先进历史，否则后面的提交会混在一起。

- [ ] **Step 1: 跑全量测试确认基线**

Run: `npm test`
Expected: 全部通过。若有失败，先记录失败用例名并停下来报告，不要继续后面的任务。

- [ ] **Step 2: 确认待提交文件**

Run: `git status --porcelain`
Expected: 只包含 `control.mjs`、`native-inbox.mjs`、`native-mcp.mjs`、`runtime.mjs`、`scripts/live-session-mcp.mjs`、`scripts/spawn-codex-chat.mjs`、`scripts/verify-real-mcp.mjs`、`start-browser.ps1`、`spawn-tool.test.mjs`、`scripts/verify-real-autobind.mjs`。出现任何其他文件就停下来问。

- [ ] **Step 3: 提交**

```bash
git add control.mjs native-inbox.mjs native-mcp.mjs runtime.mjs \
        scripts/live-session-mcp.mjs scripts/spawn-codex-chat.mjs \
        scripts/verify-real-mcp.mjs scripts/verify-real-autobind.mjs \
        start-browser.ps1 spawn-tool.test.mjs
git commit -m "feat(spawn): add RPC host control and fetch-safe loopback ports"
```

---

### Task 2: Claude 参数构造

**Files:**
- Create: `scripts/spawn-claude-chat.mjs`
- Test: `spawn-claude-chat.test.mjs`

**Interfaces:**
- Consumes: `runtime.mjs` 的 `resolveAgentExecutable`、`agentEnv`（下一任务用）。
- Produces:
  - `buildClaudeArgs({sandbox='read-only', effort='high', session=null}) -> string[]` —— 只构造 argv，不含 prompt（prompt 走 stdin）。
  - `WORKER_POLICY` —— 常量字符串。

- [ ] **Step 1: 写失败测试 `spawn-claude-chat.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildClaudeArgs} from './scripts/spawn-claude-chat.mjs';

const head=(maxTurns)=>['-p','--output-format','json','--strict-mcp-config',
  '--mcp-config','{"mcpServers":{}}','--max-turns',String(maxTurns)];

test('read-only worker exposes only read tools',()=>{
  const args=buildClaudeArgs({sandbox:'read-only',effort:'high'});
  assert.deepEqual(args.slice(0,8),head(4));
  assert.ok(args.includes('--tools'));
  assert.equal(args[args.indexOf('--tools')+1],'Read,Grep,Glob');
  assert.ok(!args.includes('--permission-mode'));
  assert.ok(!args.includes('--allowedTools'));
});

test('workspace-write worker may edit and run node tests only',()=>{
  const args=buildClaudeArgs({sandbox:'workspace-write',effort:'high'});
  assert.deepEqual(args.slice(0,8),head(40));
  assert.equal(args[args.indexOf('--permission-mode')+1],'acceptEdits');
  assert.equal(args[args.indexOf('--allowedTools')+1],
    'Read,Grep,Glob,Edit,Write,Bash(node --test *)');
  assert.ok(!args.includes('--tools'));
});

test('effort maps ultra to max and resume appends the session',()=>{
  assert.equal(buildClaudeArgs({effort:'ultra'})[buildClaudeArgs({effort:'ultra'}).indexOf('--effort')+1],'max');
  const args=buildClaudeArgs({session:'sess-1'});
  assert.equal(args.at(-1),'sess-1');
  assert.equal(args.at(-2),'--resume');
});

test('rejects unknown sandbox and effort',()=>{
  assert.throws(()=>buildClaudeArgs({sandbox:'danger-full-access'}),/sandbox must be read-only or workspace-write/);
  assert.throws(()=>buildClaudeArgs({effort:'max'}),/effort must be/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test spawn-claude-chat.test.mjs`
Expected: FAIL，`Cannot find module ./scripts/spawn-claude-chat.mjs`。

- [ ] **Step 3: 实现 `buildClaudeArgs`**

在 `scripts/spawn-claude-chat.mjs` 中导出 `WORKER_POLICY` 与 `buildClaudeArgs`。argv 顺序固定为：`-p`、`--output-format json`、`--strict-mcp-config`、`--mcp-config '{"mcpServers":{}}'`、`--max-turns`（只读 4 / 可写 40）、沙箱两项、`--effort`、可选 `--resume <session>`、`--append-system-prompt <WORKER_POLICY>`；`--append-system-prompt` 放在 `--resume` 之前。effort 映射：`low→low`、`medium→medium`、`high→high`、`ultra→max`。

`WORKER_POLICY` 原文：

```
你是 Agents Calling 启动的工作方，不是与人对话的会话。只完成被派的任务，不扩大范围。
不安装依赖、不联网；需要确认的操作直接放弃，并在结果里说明哪一步被挡住。
结束时用中文写清：改了哪些文件、跑了什么、还剩什么没做。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test spawn-claude-chat.test.mjs`
Expected: PASS，4 个用例全过。

- [ ] **Step 5: 提交**

```bash
git add scripts/spawn-claude-chat.mjs spawn-claude-chat.test.mjs
git commit -m "feat(worker): build Claude worker arguments"
```

---

### Task 3: 执行单轮 Claude 调用

**Files:**
- Modify: `scripts/spawn-claude-chat.mjs`
- Test: `spawn-claude-chat.test.mjs`

**Interfaces:**
- Consumes: `buildClaudeArgs`（Task 2）。
- Produces: `runClaudeTurn({prompt, session=null, sandbox='read-only', effort='high', timeoutMs=180000, cwd=process.cwd(), executable=null, env=process.env, signal}) -> Promise<{text: string, sessionId: string}>`；`executable` 为 `{command, args}` 时直接使用，否则调用 `resolveAgentExecutable('claude',{executables:…})`。

- [ ] **Step 1: 写失败测试**

在 `spawn-claude-chat.test.mjs` 追加：用 `process.execPath` + 一个临时假脚本作为 `executable`，假脚本从 argv 读取 `--resume` 并把结果写到 stdout。

```js
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runClaudeTurn} from './scripts/spawn-claude-chat.mjs';

const fakeBody=`import {readFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG,JSON.stringify(args)+'\\n');
const i=args.indexOf('--resume');
const scope=i>=0?args[i+1]:'first';
process.stdout.write(JSON.stringify({result:'done:'+scope,session_id:'sess-'+scope,is_error:false}));`;

async function fakeClaude(){
  const root=await mkdtemp(join(tmpdir(),'fake-claude-'));
  const script=join(root,'fake.mjs'),log=join(root,'argv.log');
  await writeFile(script,fakeBody);await writeFile(log,'');
  return {root,executable:{command:process.execPath,args:[script]},log,
    env:{...process.env,FAKE_LOG:log}};
}

test('first turn has no resume and returns a session id',async()=>{
  const f=await fakeClaude();
  const r=await runClaudeTurn({prompt:'hi',...f});
  assert.deepEqual(r,{text:'done:first',sessionId:'sess-first'});
});

test('second turn resumes the captured session',async()=>{
  const f=await fakeClaude();
  const r=await runClaudeTurn({prompt:'again',session:'sess-first',...f});
  assert.equal(r.text,'done:sess-first');
  const logged=JSON.parse((await readFile(f.log,'utf8')).trim().split('\n').at(-1));
  assert.equal(logged[logged.indexOf('--resume')+1],'sess-first');
});

test('a result without session_id is an error',async()=>{
  const f=await fakeClaude();
  const script=join(f.root,'bad.mjs');
  await writeFile(script,`process.stdout.write('{"result":"x","is_error":false}')`);
  await assert.rejects(
    runClaudeTurn({prompt:'hi',executable:{command:process.execPath,args:[script]},env:f.env}),
    /invalid result/);
});

test('a missing executable is reported in plain language',async()=>{
  await assert.rejects(
    runClaudeTurn({prompt:'hi',executable:{command:'sibyl-no-such-binary-xyz',args:[]}}),
    /Claude executable not found/);
});

test('a turn that exceeds its timeout is killed and reported',async()=>{
  const f=await fakeClaude();
  const script=join(f.root,'slow.mjs');
  await writeFile(script,`setTimeout(()=>{},10000)`);
  await assert.rejects(
    runClaudeTurn({prompt:'hi',timeoutMs:1000,
      executable:{command:process.execPath,args:[script]},env:f.env}),
    /timed out after 1000 ms/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test spawn-claude-chat.test.mjs`
Expected: FAIL，`runClaudeTurn is not a function`。

- [ ] **Step 3: 实现 `runClaudeTurn`**

要点：`spawn(executable.command,[...executable.args,...buildClaudeArgs(...)])`，`cwd` 由调用方传入项目目录（`runClaudeTurn` 接受 `cwd`），prompt 写入 stdin 后 close；`env` 默认 `agentEnv('claude', baseEnv)`；超时用 `setTimeout` 后 `child.kill('SIGKILL')`；收集 stdout，JSON.parse；错误映射：

- 子进程 `error.code === 'ENOENT'` → `Error('Claude executable not found; set SIBYL_CLAUDE_PATH or install Claude Code')`
- 超时 → `Error('Claude turn timed out after <ms> ms')`
- 非 0 退出 → `Error('Claude exited <code>: <stderr 末 2000 字>')`
- `result.is_error` 或缺少 `session_id` 或 `typeof result.result !== 'string'` → `Error('Claude returned an unsuccessful or invalid result')`

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test spawn-claude-chat.test.mjs`
Expected: PASS，9 个用例全过。

- [ ] **Step 5: 提交**

```bash
git add scripts/spawn-claude-chat.mjs spawn-claude-chat.test.mjs
git commit -m "feat(worker): run one Claude worker turn"
```

---

### Task 4: 多轮 RPC 主机

**Files:**
- Modify: `scripts/spawn-claude-chat.mjs`
- Test: `spawn-claude-chat.test.mjs`

**Interfaces:**
- Consumes: `runClaudeTurn`（Task 3）。
- Produces: 可执行入口 `node scripts/spawn-claude-chat.mjs --project <dir> --claude <path> [--dir <unused>] [--sandbox …] [--effort …] [--timeout-ms …]`（`--dir` 为与 Codex 启动脚本保持参数一致而接受，不使用）。stdout 的 JSON 行协议与 `scripts/spawn-codex-chat.mjs --rpc` 完全一致：
  - 启动：`{"type":"thread","threadId":<uuid>,"sessionId":null,"cwd":<project>,"sandbox":…,"effort":…}`
  - 每轮成功：`{"id":<n>,"type":"turn","text":<string>,"tools":[]}`
  - 每轮失败：`{"id":<n>,"type":"error","error":<string>}`
  - 关闭：`{"id":<n>,"type":"closed"}` 后退出码 0

- [ ] **Step 1: 写失败测试**

追加一个用假 Claude 的端到端用例：起子进程，读第一行拿 `threadId`，发两轮 `{"id":1,"op":"turn","prompt":"a"}` / `{"id":2,"op":"turn","prompt":"b"}`，断言第二轮假脚本记录的 argv 含 `--resume`，最后发 `{"id":3,"op":"close"}` 并断言进程退出码 0。再加一个并发用例：连续发两条 turn，第二条必须收到 `"type":"error"` 且 error 匹配 `/already running/`。

（假脚本直接复用 Task 3 的 `fakeBody`。测试按平台各写一个启动器，都调用同一个 `fake-claude.mjs`：win32 写 `fake-claude.cmd`，内容为 `@node "%~dp0fake-claude.mjs" %*`；其他平台写可执行的 `fake-claude.sh`，内容为 `#!/bin/sh\nexec node "$(dirname "$0")/fake-claude.mjs" "$@"`，并 `chmod 0o755`。两者都通过 `--claude <启动器路径>` 传入，走 `resolveExecutable` 的真实解析路径。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test spawn-claude-chat.test.mjs`
Expected: FAIL，脚本没有输出 `type:"thread"`。

- [ ] **Step 3: 实现入口与 RPC 循环**

用 `node:util` 的 `parseArgs` 解析 `--project`、`--dir`（接受但不使用）、`--rpc`（接受但不使用，本脚本只有 RPC 模式）、`--sandbox`、`--effort`、`--claude`、`--timeout-ms`（默认 180000，范围 1000..600000）、`--help`。启动后先打印 thread 行；每收到 `op:"turn"`：若已有轮次在跑，回复 `type:"error"` 且 `error:"A turn is already running in this worker"`；否则调用 `runClaudeTurn`，成功后把返回的 `sessionId` 存为当前会话，供下一轮 resume。`op:"close"` 打印 closed 并退出 0；stdin 关闭时退出 0。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test spawn-claude-chat.test.mjs`
Expected: PASS，11 个用例全过。

- [ ] **Step 5: 提交**

```bash
git add scripts/spawn-claude-chat.mjs spawn-claude-chat.test.mjs
git commit -m "feat(worker): add Claude worker RPC host"
```

---

### Task 5: native-mcp 按 tool 选择工作方

**Files:**
- Modify: `native-mcp.mjs`（`definitions` 里 `bridge_spawn` 的 schema、`parseArgs` 选项、`spawnSettings`、`startSpawn`、`bridge_spawn` 分支的返回对象）
- Test: `spawn-tool.test.mjs`

**Interfaces:**
- Consumes: `scripts/spawn-claude-chat.mjs` 的 thread/turn/closed 行协议（Task 4）。
- Produces:
  - `bridge_spawn` 新增可选参数 `tool`：`"codex"`（默认）或 `"claude"`。
  - 新增 `--claude-spawn-script <path>` 命令行选项（测试注入用）。
  - `bridge_spawn` 的返回对象新增 `tool` 字段。

- [ ] **Step 1: 写失败测试**

在 `spawn-tool.test.mjs` 追加：

```js
test('bridge_spawn routes to the Claude worker when tool is claude',async()=>{
 const {dir,project,fakePath,inbox,cleanup}=await fixture();
 const c=client(dir,'claude',project,['--claude-spawn-script',fakePath]);
 try{
  const result=await c.tool('bridge_spawn',{tool:'claude',prompt:'hello',sandbox:'workspace-write'});
  assert.equal(result.tool,'claude');
  assert.equal(result.sandbox,'workspace-write');
  assert.match(result.text,/echo:hello/);
 }finally{await c.close();await cleanup();}
});

test('bridge_spawn rejects an unknown tool before starting anything',async()=>{
 const {dir,project,fakePath,inbox,cleanup}=await fixture();
 const c=client(dir,'claude',project,['--claude-spawn-script',fakePath]);
 try{
  await assert.rejects(c.tool('bridge_spawn',{tool:'cursor',prompt:'x'}),/tool must be codex or claude/);
 }finally{await c.close();await cleanup();}
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test spawn-tool.test.mjs`
Expected: FAIL，未知参数 `tool`（schema 的 `additionalProperties:false` 会拒绝）。

- [ ] **Step 3: 实现**

- `definitions` 中 `bridge_spawn` 的 `properties` 追加 `tool:str`，描述改为「工作方工具：codex（默认）或 claude」。
- `parseArgs` 增加 `'claude-spawn-script':{type:'string'}`。
- `spawnSettings(args)`：`const tool=args.tool??'codex'; if(!['codex','claude'].includes(tool))throw Error('tool must be codex or claude');` 并随返回值带出。
- `startSpawn({project,tool,...})`：脚本选择 `tool==='claude' ? (values['claude-spawn-script']?resolve(values['claude-spawn-script']):fileURLToPath(new URL('./scripts/spawn-claude-chat.mjs',import.meta.url))) : spawnScript`。参数沿用同一个 `--rpc --dir --project --sandbox --effort --timeout-ms`；Task 4 的 `parseArgs` 已接受其中的 `--dir` 与 `--rpc`，不需要额外分支。
- 返回对象（三处：首轮完成、keepAlive、idle）都加 `tool`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test spawn-tool.test.mjs`
Expected: PASS，原有用例 + 2 个新用例全过。

- [ ] **Step 5: 提交**

```bash
git add native-mcp.mjs spawn-tool.test.mjs
git commit -m "feat(worker): let bridge_spawn start a Claude worker"
```

---

### Task 6: 文档与全量验证

**Files:**
- Modify: `使用说明.md`（`bridge_spawn` 一节）
- Modify: `README.md`（能力清单里加一句对称工作方）

**Interfaces:**
- Consumes: Task 5 的工具签名。
- Produces: 无代码接口。

- [ ] **Step 1: 更新文档**

在 `使用说明.md` 里把 `bridge_spawn` 的说明补成：`tool` 可选 `codex` / `claude`；`sandbox` 默认 `read-only`，要让它动手必须显式传 `workspace-write`；Claude 工作方没有网络、只能跑 `node --test`，被审批挡住的操作会出现在返回文本里。`README.md` 的能力清单加一句：「Codex 可以派一个可写文件的 Claude 工作方，反之亦然。」

- [ ] **Step 2: 跑全量测试**

Run: `npm test`
Expected: 全部通过。

- [ ] **Step 3: 提交**

```bash
git add 使用说明.md README.md
git commit -m "docs: document the symmetric worker tool parameter"
```
