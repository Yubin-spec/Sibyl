# 观测页流水线时间线与可预期入口 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让本机网页有一个可预期、可直接打开的地址，并把「观测」页升级为按时间排序、实时更新的只读流水线时间线（计划评审 → 工作方 → 待你处理）。

**Architecture:** 新增纯函数模块 `observer-model.mjs`（排序、阶段统计、时间格式），`desktop.js` 改为 ES module 引用它，页面只负责渲染。后端只做两件事：`listenLoopback` 支持首选固定端口（仅端口占用时回退），`attentionItems` 给待处理项补 `at` 时间戳。不新增写路由，不放宽 CSP，不渲染任何 token/CSRF。

**Tech Stack:** Node 26（零第三方依赖）、原生 `node:http`、浏览器原生 DOM/SSE/ESM、`node:test`。

**Spec:** 由上层会话直接给出（功能 2：可视化）；约束以仓库 `CLAUDE.md` 与 `docs/handover-2026-11-08-phase-b.md` §6 为准。

## Global Constraints

- Node 26：`"/d/LXY_workspace/AI Bridge/.tools/node26/node-v26.13.0-win-x64/node.exe"`；测试 `--test --test-concurrency=1 --test-timeout=30000 *.test.mjs`。
- 零第三方 npm 依赖；只在 `feat/windows-support` 扁平布局上改。
- 不碰冻结模块及其测试：`Desktop.swift`、`build-app.sh`、`bridge.mjs`、`pairing.mjs`、`channel.mjs`、`update.mjs`。
- 不改 `docs/superpowers/plans/2026-11-09-worker-gate.md`。
- 观测页只读：`id="page-observer"` 区域内不得出现 `<button|<form|<input|<textarea|<select`。
- 不新增写 HTTP 路由；CSRF（`x-bridge-ui`）与 CSP 保持不变；静态白名单只增 `/observer-model.mjs`。
- 页面不得渲染 `csrf`、连接 token、配对码等敏感值。
- 每个任务独立提交；不 push。

## 文件结构

| 文件 | 责任 | 任务 |
|---|---|---|
| `runtime.mjs` | `DEFAULT_UI_PORT`；`listenLoopback(server, preferredPort)` 端口占用时回退 | 1 |
| `control.mjs` | CLI 用 `SIBYL_UI_PORT`/默认端口启动；静态白名单加 `/observer-model.mjs` | 1、3 |
| `browser.mjs` | `--page`、`--port`；默认仍打开根 URL；JSON 增加 `observer` 字段 | 1 |
| `start-browser.ps1` | 透传 `-Page`、`-Port` | 1 |
| `start-observer.cmd`（新） | 一键打开观测页 | 1 |
| `observer-model.mjs`（新） | 纯函数：时间格式、verdict 归一、时间线构建、流水线统计 | 3 |
| `desktop.js` | ES module；`?page=` 深链；调用模型渲染流水线条与时间线 | 1、3 |
| `desktop.html` | `type="module"`；观测页新增 `#observerPipeline`、`#observerTimeline` | 3 |
| `desktop.css` | 时间线与流水线条样式 | 3 |
| `attention.mjs` | 待处理项补 `at` | 2 |
| `observer-model.test.mjs`（新） | 排序、缺失时间、阶段统计、verdict 兼容 | 2、3 |
| `ui-entry.test.mjs`（新） | 固定端口、回退、真实 HTTP 访问 | 1、4 |
| `observer-page.test.mjs` | 只读边界 + 时间线结构 | 3、4 |
| `attention.test.mjs` | `at` 字段断言 | 2 |

## Review Focus

- 固定端口被占用：自动回退临时端口，启动照常成功；非端口占用错误必须抛出。
- 同一数据目录重复启动：复用已运行实例；`--port` 不改变既有实例端口（文档写明）。
- 脏深链 `?page=nope`、`?page=../../etc`：回退到已保存页面，不写设置、不报错。
- 旧记录/配对请求没有时间：仍出现在时间线，排在末尾，时间显示为空。
- 敏感值：观测区 DOM 文本中不得出现 csrf、token、配对码。

## Codex review

评审线程：`01a1be6a-9ac2-7bc2-bf4b-6e1ed511a373`（gpt-6.1-terra，只读），结论「先改再开工」。采纳情况：

| 评审意见 | 处理 |
|---|---|
| Major 1：无时间戳项被 `filter` 丢弃 | 采纳。`observerTimelineItems` 保留 `at:null` 项，有效时间降序、无效时间排末尾；配对请求无时间字段，按无时间处理 |
| Major 2：待处理漏掉计划评审 `changes-required` | 采纳。`observerPipelineStats` 的「待你处理」= attention + 需回应的评审（`changes-required`/`deadlock`）；评审行显示「待回应」 |
| Major 3：秘密测试只扫源码 | 部分采纳。模型层单测覆盖数据投影；源码扫描范围扩到整个观测渲染块。说明：仓库零依赖、无 DOM，无法做真实 DOM 断言 |
| Major 4：测试只查源码形状 | 采纳。新增 `observer-model.test.mjs`（排序/缺失时间/统计/verdict）与 `ui-entry.test.mjs` 的真实 HTTP 访问（固定端口起 control 后 fetch `/?page=observer`） |
| Major 5：默认打开行为被改变 | 采纳。只有显式 `--page` 才打开深链；普通入口仍打开根 URL；JSON 始终带 `observer` 字段 |
| Minor 1：端口回退吞错过宽 | 采纳。只对 `EADDRINUSE`/`EACCES` 回退，其余抛出；校验端口范围；已监听直接返回 |
| Minor 2：固定端口与 47831 不冲突 | 确认。补测试与文档说明 |
| Minor 3：深链应校验真实页面 | 采纳。用 `.page` 类判断，无效值回退已保存页面 |
| Minor 4：attention 兼容性 | 采纳。补三类事项 `at`、缺失值与 dismissal key 不变断言 |
| Minor 5：时间线字段与锚点 | 采纳。操作锚点指向 `observerOperations` 容器（列表只渲染 20 条）；显示交工摘要与状态；verdict 兼容字符串/对象 |
| Minor 6：锚点无写操作 | 确认。`<a href="#...">` 不绑定事件 |

---

### Task 1: 可预期的观测页入口

**Files:**
- Modify: `runtime.mjs:176-193`
- Modify: `control.mjs:1-10`、`control.mjs:146-155`
- Modify: `browser.mjs:8`、`browser.mjs:31-46`
- Modify: `start-browser.ps1`
- Create: `start-observer.cmd`
- Modify: `desktop.js:37`
- Test: `ui-entry.test.mjs`（新建）

**Interfaces:**
- Produces: `export const DEFAULT_UI_PORT = 47830`
- Produces: `listenLoopback(server, preferredPort = 0) -> Promise<number>`
- Produces: `browser.mjs --page <name>`、`--port <n>`；stdout JSON：`{url, observer, pid, dataDir}`

- [ ] **Step 1: 写失败测试 `ui-entry.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {DEFAULT_UI_PORT, listenLoopback} from './runtime.mjs';

const read = name => readFile(new URL(name, import.meta.url), 'utf8');

test('default UI port is a usable loopback port', () => {
  assert.ok(Number.isInteger(DEFAULT_UI_PORT));
  assert.ok(DEFAULT_UI_PORT >= 1024 && DEFAULT_UI_PORT <= 65535);
});

test('listenLoopback prefers a free requested port', async () => {
  const probe = createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const free = probe.address().port;
  await new Promise(r => probe.close(r));
  const server = createServer((req, res) => res.end('ok'));
  assert.equal(await listenLoopback(server, free), free);
  await new Promise(r => server.close(r));
});

test('listenLoopback falls back only when the port is taken', async () => {
  const blocker = createServer();
  await new Promise(r => blocker.listen(0, '127.0.0.1', r));
  const taken = blocker.address().port;
  const server = createServer((req, res) => res.end('ok'));
  const port = await listenLoopback(server, taken);
  assert.notEqual(port, taken);
  assert.ok(port > 0);
  await new Promise(r => server.close(r));
  await new Promise(r => blocker.close(r));
});

test('an already listening server keeps its port', async () => {
  const server = createServer((req, res) => res.end('ok'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  assert.equal(await listenLoopback(server, DEFAULT_UI_PORT), port);
  await new Promise(r => server.close(r));
});

test('entry points expose a predictable observer address', async () => {
  const [browser, desktop, control] = await Promise.all([read('browser.mjs'), read('desktop.js'), read('control.mjs')]);
  assert.match(browser, /'page'/);
  assert.match(browser, /observer/);
  assert.match(desktop, /URLSearchParams\(location\.search\)/);
  assert.match(control, /DEFAULT_UI_PORT/);
  assert.match(control, /SIBYL_UI_PORT/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `...node.exe --test ui-entry.test.mjs`
Expected: FAIL（`DEFAULT_UI_PORT` 未导出）

- [ ] **Step 3: 实现 `runtime.mjs`**

在 `FETCH_BLOCKED_PORTS` 之后：

```js
export const DEFAULT_UI_PORT = 47830;

export async function listenLoopback(server, preferredPort = 0) {
  if (server.listening) return server.address().port;
  const usable = Number.isInteger(preferredPort) && preferredPort >= 1024 && preferredPort <= 65535 && !FETCH_BLOCKED_PORTS.has(preferredPort);
  if (usable) {
    try {
      await new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError); server.once('listening', onListening);
        server.listen(preferredPort, '127.0.0.1');
      });
      return server.address().port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
      if (server.listening) await new Promise(resolve => server.close(() => resolve()));
    }
  }
  // 原临时端口循环保持不变
}
```

- [ ] **Step 4: 运行端口用例**

Run: `...node.exe --test ui-entry.test.mjs`
Expected: 前四条 PASS，最后一条 FAIL

- [ ] **Step 5: 改 `control.mjs` CLI**

import 追加 `DEFAULT_UI_PORT`；主入口：

```js
const preferred = Number(process.env.SIBYL_UI_PORT || DEFAULT_UI_PORT);
const port = await listenLoopback(control.server, Number.isInteger(preferred) ? preferred : DEFAULT_UI_PORT);
const url = `http://127.0.0.1:${port}`; await writeFile(runtimeFile, JSON.stringify({pid: process.pid, url}), {mode: 0o600});
console.log(`BRIDGE_UI_READY=${url}`);
console.log(`观测页：${url}/?page=observer`);
```

- [ ] **Step 6: 改 `browser.mjs`**

- 参数：`page:{type:'string'}`、`port:{type:'string'}`。
- spawn control 时传 `env:{...process.env, ...(values.port ? {SIBYL_UI_PORT: values.port} : {})}`。
- 打开目标：`const page = /^[a-z-]+$/.test(values.page || '') ? values.page : ''; const target = page ? `${r.url}/?page=${page}` : r.url;` —— 仅 `page` 非空时打开深链。
- 输出：`console.log(JSON.stringify({url: r.url, observer: `${r.url}/?page=observer`, pid: r.pid, dataDir: dir}));`
- 已有实例运行时 `--port` 不生效：在 `--page/--port` 的用法说明里注明。

- [ ] **Step 7: `start-browser.ps1` 与 `start-observer.cmd`**

ps1 增加 `[string]$Page`、`[string]$Port`，分别 `@('--page', $Page)`、`@('--port', $Port)`。
`start-observer.cmd`：

```bat
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-browser.ps1" -Page observer %*
```

- [ ] **Step 8: `desktop.js` 深链（用 `.page` 校验）**

`if(initial){` 第一行：

```js
const requested = new URLSearchParams(location.search).get('page');
const requestedPage = requested && document.getElementById('page-' + requested);
showPage(requestedPage?.classList.contains('page') ? requested : (state.settings?.page || 'conversations'), false);
```

- [ ] **Step 9: 跑测试并提交**

Run: `...node.exe --test ui-entry.test.mjs browser.test.mjs`
Expected: 全 PASS（`browser.test.mjs` 仍能解析 stdout JSON）

```bash
git add runtime.mjs control.mjs browser.mjs start-browser.ps1 start-observer.cmd desktop.js ui-entry.test.mjs
git commit -m "feat(observer): add a predictable local UI address"
```

---

### Task 2: 待处理项带时间戳

**Files:**
- Modify: `attention.mjs:24-60`
- Test: `attention.test.mjs`

**Interfaces:**
- Produces: 每个 item 新增 `at: string|null`；`key` 不变

- [ ] **Step 1: 追加失败断言**

```js
test('attention items carry timestamps without changing their keys', () => {
  const items = attentionItems({
    requests: [{id: 'pair-1', name: 'Studio', ip: '192.168.1.20'}],
    consultations: [{id: 'c-1', status: 'failed', startedAt: '2026-11-09T01:00:00.000Z', updatedAt: '2026-11-09T02:00:00.000Z'}],
    conversations: [{id: 'v-1', status: 'failed', updatedAt: '2026-11-09T03:00:00.000Z'}]
  });
  assert.equal(items[0].at, null);
  assert.equal(items[1].at, '2026-11-09T02:00:00.000Z');
  assert.equal(items[2].at, '2026-11-09T03:00:00.000Z');
  assert.equal(items[1].key, 'consult:c-1:2026-11-09T02:00:00.000Z');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `...node.exe --test attention.test.mjs`
Expected: FAIL（`at` 为 undefined）

- [ ] **Step 3: `attention.mjs` 三处加 `at`**

pair：`at: request.createdAt || request.at || null`；consult：`at: record.updatedAt || record.startedAt || null`；conversation：`at: conversation.updatedAt || conversation.createdAt || null`。

- [ ] **Step 4: 跑测试并提交**

Run: `...node.exe --test attention.test.mjs attention-api.test.mjs`
Expected: 全 PASS

```bash
git add attention.mjs attention.test.mjs
git commit -m "feat(attention): timestamp items for the observer timeline"
```

---

### Task 3: 时间线模型与观测页渲染

**Files:**
- Create: `observer-model.mjs`
- Modify: `desktop.html:2`（module script）、`desktop.html:7`（观测页容器）
- Modify: `desktop.js:1`（import）、`desktop.js:61-70`（hook 渲染）
- Modify: `control.mjs:106`（静态白名单）
- Modify: `desktop.css`
- Test: `observer-model.test.mjs`（新建）、`observer-page.test.mjs`

**Interfaces:**
- Produces（`observer-model.mjs`）:
  - `export function observerTime(at, now = new Date()) -> string`
  - `export function observerVerdict(review) -> string`
  - `export const OBSERVER_ACTIVE_REVIEWS = new Set([...])`
  - `export function observerPipelineStats(state) -> {reviews, needingResponse, workers, attention}`
  - `export function observerTimelineItems(state) -> Array<{at, stage, status, title, detail, anchor, needsResponse}>`
- Consumes: `state.planReviews / workers / consultations / operations / attention`

- [ ] **Step 1: 写失败测试 `observer-model.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {observerTime, observerVerdict, observerPipelineStats, observerTimelineItems} from './observer-model.mjs';

const state = {
  planReviews: [
    {reviewId: 'r1', planPath: 'docs/a.md', status: 'changes-required', round: 2, maxRounds: 3, verdict: {verdict: 'changes-required'}, issues: [{id: 'R1'}], updatedAt: '2026-11-09T03:00:00.000Z'},
    {reviewId: 'r2', planPath: 'docs/b.md', status: 'approved', round: 1, maxRounds: 3, verdict: 'approve', updatedAt: '2026-11-09T01:00:00.000Z'}
  ],
  workers: [{workerId: 'w1', tool: 'codex', tier: 'dispatch', status: 'running', turns: 1, startedAt: '2026-11-09T02:00:00.000Z', updatedAt: '2026-11-09T02:30:00.000Z'}],
  consultations: [],
  operations: [],
  attention: [{key: 'pair:p1', kind: 'pair', title: '配对请求', at: null}]
};

test('timeline keeps untimed items and sorts valid timestamps newest first', () => {
  const items = observerTimelineItems(state);
  assert.deepEqual(items.map(item => item.stage), ['计划评审', '工作方', '计划评审', '待处理']);
  assert.equal(items.at(-1).at, null);
  assert.equal(items[0].needsResponse, true);
});

test('pipeline counts reviews awaiting a response inside the needs-you stage', () => {
  assert.deepEqual(observerPipelineStats(state), {reviews: 2, needingResponse: 1, workers: 1, attention: 2});
});

test('verdict accepts objects and strings', () => {
  assert.equal(observerVerdict(state.planReviews[0]), 'changes-required');
  assert.equal(observerVerdict(state.planReviews[1]), 'approve');
  assert.equal(observerVerdict({}), '');
});

test('observerTime tolerates missing and invalid timestamps', () => {
  assert.equal(observerTime(null), '');
  assert.equal(observerTime('not-a-date'), '');
  assert.match(observerTime('2026-11-09T03:04:05.000Z'), /^\d{2}:\d{2}$|^\d{2}-\d{2} \d{2}:\d{2}$/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `...node.exe --test observer-model.test.mjs`
Expected: ERR_MODULE_NOT_FOUND

- [ ] **Step 3: 实现 `observer-model.mjs`**

规则：
- `observerTime`：`Date.parse` 非有限值返回 `''`；同日 `HH:MM`，跨日 `MM-DD HH:MM`。
- `OBSERVER_ACTIVE_REVIEWS = new Set(['starting','awaiting-visibility','reviewing','changes-required','deadlock','interrupted'])`。
- `needsResponse = ['changes-required','deadlock']`。
- `observerTimelineItems`：每类数据映射为事件；`at` 取 `updatedAt || startedAt || createdAt || null`；按 `Date.parse(at)` 降序，`null` 排末尾，同时间保持插入顺序；最多 60 条。
  - review detail：`第 r/max 轮 · verdict · n 个问题`；anchor `observer-review-<reviewId>`。
  - worker detail：`模型 · effort · 第 n 轮 · 已交工/摘要`；anchor `observer-worker-<workerId>`。
  - consult detail：`第 n 轮 · 问题前 80 字`；anchor `observer-consult-<id>`。
  - operation：anchor `observerOperations`（列表只渲染 20 条，卡片锚点可能不存在）。
  - attention：anchor `observerAttention`。
- `observerPipelineStats`：`{reviews: planReviews.length, needingResponse: 计划评审中 needsResponse 的数量, workers: 非终态 workers 数量, attention: attention.length + needingResponse}`。

- [ ] **Step 4: 运行模型测试**

Run: `...node.exe --test observer-model.test.mjs`
Expected: PASS

- [ ] **Step 5: `control.mjs` 静态白名单加 `/observer-model.mjs`**

`['/','/desktop.js','/desktop.css']` → `['/','/desktop.js','/desktop.css','/observer-model.mjs']`；content-type 分支按 `.mjs` 输出 `text/javascript; charset=utf-8`。

- [ ] **Step 6: `desktop.html` 与 `desktop.js` 接模块**

`<script type="module" src="/desktop.js"></script>`；观测页 `#observerMetrics` 后插入：

```html
<h2 class="group-title">流水线</h2>
<div id="observerPipeline" class="pipeline"></div>
<h2 class="group-title">时间线</h2>
<ol id="observerTimeline" class="timeline"></ol>
```

`desktop.js` 首行加：

```js
import {observerTime, observerVerdict, observerPipelineStats, observerTimelineItems} from '/observer-model.mjs';
```

- [ ] **Step 7: 渲染流水线条与时间线**

在 `renderObserver()` 末尾追加两个 `changed(...)`：

- `observerPipeline`：三段 `计划评审 / 工作方 / 待你处理`，数字取 `observerPipelineStats`；「待你处理」段附 `needingResponse` 的小字说明；每段最近事件时间用对应列表首项。
- `observerTimeline`：空时 `observerEmpty('流水线暂无记录：开始一次计划评审或派活后，事件会实时出现在这里。')`；否则每条 `li.timeline-item`：`span.timeline-time`、`span.observer-pill`（阶段，`needsResponse` 时追加「待回应」）、`div.timeline-body`（`a.timeline-link` 指向 `'#'+anchor` + `small` detail）。`a` 只设 `href` 与 `textContent`。

给详情卡片补 id：review 行 `observer-review-<reviewId>`、consult 卡片 `observer-consult-<id>`。

- [ ] **Step 8: CSS**

```css
.pipeline{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:6px}
.pipeline-stage{display:grid;gap:2px;padding:12px 14px;border-radius:12px;background:var(--fill)}
.pipeline-stage small{color:var(--muted);font-size:11px}
.pipeline-stage strong{font-size:20px;line-height:1.2}
.pipeline-stage span{color:var(--muted);font-size:11px}
.timeline{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.timeline-item{display:grid;grid-template-columns:64px auto 1fr;align-items:start;gap:10px;padding:9px 12px;border-radius:10px}
.timeline-item:hover{background:var(--fill)}
.timeline-time{color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums;padding-top:2px}
.timeline-body{display:grid;gap:1px;min-width:0}
.timeline-link{color:inherit;text-decoration:none;font-size:13px;font-weight:600}
.timeline-link:hover{color:var(--blue)}
.timeline-body small{color:var(--muted);font-size:11px;line-height:1.45}
@media(max-width:850px){.pipeline{grid-template-columns:1fr}.timeline-item{grid-template-columns:48px auto 1fr}}
```

- [ ] **Step 9: 扩展 `observer-page.test.mjs` 并跑测试**

追加：观测区含 `#observerPipeline`、`#observerTimeline`；仍无写控件；`renderObserver` 切片含两处容器名、不含 `api(`/`button(`；html 使用 `type="module"`；css 含 `.timeline-item`、`.pipeline-stage`。

Run: `...node.exe --test observer-model.test.mjs observer-page.test.mjs`
Expected: PASS

```bash
git add observer-model.mjs observer-model.test.mjs desktop.html desktop.js desktop.css control.mjs observer-page.test.mjs
git commit -m "feat(observer): render a live pipeline timeline"
```

---

### Task 4: 真实访问与只读回归

**Files:**
- Test: `ui-entry.test.mjs`、`observer-page.test.mjs`

- [ ] **Step 1: `ui-entry.test.mjs` 增加真实 HTTP 用例**

```js
test('control serves the observer page on the preferred port', async () => {
  const {createControl} = await import('./control.mjs');
  const {mkdtemp, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'sibyl-ui-entry-'));
  const control = await createControl({dir, detect: async () => ({})});
  try {
    const port = await listenLoopback(control.server, DEFAULT_UI_PORT);
    const base = `http://127.0.0.1:${port}`;
    const html = await (await fetch(base + '/?page=observer')).text();
    assert.match(html, /id="page-observer"/);
    assert.match(html, /\/observer-model\.mjs/);
    const denied = await fetch(base + '/api/status');
    assert.equal(denied.status, 403);
  } finally {
    await control.close();
    await rm(dir, {recursive: true, force: true});
  }
});
```

（`?page=observer` 只影响客户端渲染，服务端返回同一个 HTML。）

- [ ] **Step 2: `observer-page.test.mjs` 增加秘密扫描**

```js
test('observer rendering never references session secrets', async () => {
  const js = await read('desktop.js');
  const start = js.indexOf('function observerStatusClass');
  const end = js.indexOf("$('refreshActivity').onclick", start);
  const body = js.slice(start, end);
  assert.doesNotMatch(body, /host\?\.code|pairing|\.token|bridge-session|x-bridge-ui/i);
});
```

- [ ] **Step 3: 跑全量**

Run: `"/d/LXY_workspace/AI Bridge/.tools/node26/node-v26.13.0-win-x64/node.exe" --test --test-concurrency=1 --test-timeout=30000 *.test.mjs`
Expected: `fail 0`

- [ ] **Step 4: 手工验收**

Run: `start-observer.cmd`
Expected: 浏览器打开 `http://127.0.0.1:47830/?page=observer`（或回退端口），直接落在观测页；页面有「流水线」「时间线」；无写按钮。

- [ ] **Step 5: 提交**

```bash
git add ui-entry.test.mjs observer-page.test.mjs
git commit -m "test(observer): verify predictable entry and read-only rendering"
```

---

## 自检

- 覆盖三个方面：可预期入口（Task 1）、时间线（Task 2、3）、只读边界（Task 4）。
- 模型纯函数可在 Node 直接单测；浏览器侧只做 DOM 组装。
- 不新增写路由、不改 CSP、不输出 token。
- 已知限制：零依赖环境下无法做真实 DOM 断言，秘密检查为源码级扫描 + 数据投影单测。
