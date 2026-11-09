---
review: approved
change:
  scope: [wechat-notify, daemon-events, notify-config]
  concurrency: false
  irreversible: false
  tasks: 5
  files: 4
---

# 微信自动通知 — 实施计划

> **For agentic workers:** 按本计划逐步骤执行，用 `- [ ]` 跟踪。计划通过评审前不要写实现代码。

**Goal:** daemon 在「需要人知道 / 需要人拍板」的事件发生时自动发一条微信，不再依赖人手动跑 `scripts/notify-wechat.mjs`。

**Why:** 计划评审等待确认、评审死锁、工作方交工/失败/超时/孤儿、待处理队列新增事项，现在都只出现在本地网页里；人离开电脑就必须回来刷新页面。通知是单向告知，只负责把人叫回来。

**Architecture:** 新增零依赖模块 `notify-service.mjs`：用纯函数对比前后两次 `state()` 快照得到事件，再用固定三段模板格式化，经注入的发送函数异步发出。`control.mjs` 的 `changed()` 本来就在每次状态变化时计算完整快照，只需把同一个快照交给通知服务；发送串行、失败不抛、未配置静默。去重键与「评审内部 worker」归属持久化到 daemon 数据目录的小 JSON 文件，重启后仍能抑制同一事件。`workers.mjs` / `plan-review.mjs` 内部逻辑不改；只给 `scripts/notify-wechat.mjs` 增加中止信号支持，用于发送超时与关闭时回收 SSH 子进程。

**Tech Stack:** Node.js >= 26，零第三方依赖。

## 范围

**做：**

- 新模块 `notify-service.mjs`：
  - `notificationEvents(previous, current)`：纯函数，输入两份 `state()` 快照，输出事件数组。事件 key 唯一。
  - `formatNotification(event)`：纯函数，输出 `{title, body}`；body 固定包含「完成了什么 / 还差什么 / 预计多久」三段，并带项目名、任务/worker 标识、实际模型。
  - `createNotifyService({enabled, sender, config, configPath, statePath, dedupeMs, sendTimeoutMs, now, retryDelayMs, maxAttempts, maxQueue, onError})`：
    - `seed(snapshot)`：只记录基线，不发消息；`observe(snapshot)`：对比基线并异步排队发送。
    - 发送串行（并发 1）；每次发送有总超时 `sendTimeoutMs`（默认 20 秒，覆盖连接建立后的远端挂起）。超时或被 `close()` 取消时通过 `AbortSignal` 终止在途 sender，然后继续处理下一条事件。
    - 重试语义：默认 `maxAttempts=2`，但**只对 sender 显式标记 `retryable:true` 的错误重试**（确定未发出，例如连接建立失败）。未标记的错误（远端可能已执行）不重试，保证 at-most-once；错误一律吞掉并计入 `status().failed`，绝不影响主流程。
    - 同一事件 key 在 `dedupeMs`（默认 6 小时）内只发一次；去重表持久化到 `statePath`，重启后继续生效。队列上限 `maxQueue`（默认 20），满时丢弃新事件并计入 `dropped`。
    - **落盘顺序**：后台串行队列对每个事件先原子写入占用记录（临时文件 + `rename`，`0600`），写入成功后才调用 sender；主流程不等待。这样 daemon 在发送后、标记前崩溃也不会重发，语义明确为 at-most-once（宁可丢，不重复）。
    - **状态文件故障策略**：启动时文件不存在 → 视为空状态正常开始；已有文件损坏、不可读或写入失败 → 进入 `state:'broken'`，停止投递（不调用 sender），只做脱敏诊断，不影响 worker / 评审。状态恢复可读可写前不发送新事件。
    - 配置读取、解析、字段校验全部在服务内部兜底：文件不存在、非法 JSON、`null`、字段缺失或类型错误、读取失败 → 静默禁用，不调用 sender、不抛错；配置里 `enabled:false` → 禁用。
    - 统一脱敏边界：用配置里的 host/user/key/hermes/target 值替换最终 title/body、`status().lastError` 和 `onError` 参数中的对应文本；发送器原始 stderr 不直接外泄。
    - `flush()` 等待队列排空（关闭时也能有界返回）；`status()` 返回 `{enabled, state, sent, failed, dropped, lastError}`；`close()` 中止在途发送、清空队列与定时器。
  - 默认 sender 复用 `scripts/notify-wechat.mjs` 的 `notify({title, body, config, signal})`；默认配置路径 = `$SIBYL_NOTIFY_CONFIG`，否则仓库根 `.notify.json`（相对于本模块，不受 daemon 工作目录影响）。
- `control.mjs` 接入：
  - `createControl` 增加 `notify={}` 选项，默认**关闭**（测试与其他调用方不会误发真实微信）；真实入口 `createControl({dir,onShutdown,notify:{enabled:true}})` 打开。
  - `changed()` 只计算一次 `state(true)`，同时用于 SSE 与 `notify.observe()`。
  - 启动阶段 `planReviews.resume()` 期间不观察（避免把「重启导致 interrupted」当新事件）；`resume()` 之后 `notify.seed(state(true))` 再开始观察。`statePath` 默认 `join(dir,'notify-state.json')`，只存去重键、时间戳和内部评审 worker id，不存正文或配置。
  - `scripts/notify-wechat.mjs` 的 `notify()` 接受 `signal` 并透传给 `defaultRun`；中止时 `child.kill()` 并拒绝，避免 SSH 永久挂起。
  - `close()` 调用 `notify.close()`；返回值增加 `notifications`（服务对象，便于测试与诊断），不写入 `/api/status`，避免 UI 变化。
- 事件覆盖（至少）：
  | 来源 | 触发 | 内容 |
  |---|---|---|
  | 计划评审 | `awaiting-visibility` | 等待人确认评审会话可见 |
  | 计划评审 | `changes-required` | 第 N 轮有 blocker/major 或问题待回应 |
  | 计划评审 | `deadlock` | 达到轮数上限，需人裁决 |
  | 计划评审 | `failed` / `interrupted` | 评审失败/中断，需恢复 |
  | 计划评审 | `approved` | 计划通过，可以开工 |
  | 工作方 | `completed` | 已交工，附摘要与验收提示 |
  | 工作方 | `failed` / `stopped` / `orphan` / `interrupted` | 失败、超时、孤儿、中断 |
  | 待处理队列 | 新 `attention` item | 配对请求、只读核对停止、会话失败 |
  - 计划评审内部使用的 consult worker（`planReviews[].workerId` 指向的 worker）不单独发工作方通知，避免每轮评审多一条噪音。
- 测试：
  - `notify-service.test.mjs`：
    - 事件只发一次；连续快照（watchdog timeout → onSettled 更新 `updatedAt`）不重发。
    - 持久化去重：同一 `statePath` 新建服务，`seed(interrupted)` 后 `observe(changes-required)` 不重发。
    - 落盘顺序与故障：sender 被调用时状态文件已写入该 key；写入失败（父路径不可写）时不调用 sender、主流程不受影响、`status().state==='broken'`；已有状态文件损坏时不投递；「先落盘、未发送就重启」后恢复同一事件不重发。
    - 内部评审 worker：W1 在基线中为 orphan，恢复产生 W2，随后 W1→interrupted 被过滤；集合超过上限时仍被当前引用或仍可变化的 W1 不被淘汰；普通 consult worker 仍通知。
    - 失败语义：同步抛错、异步拒绝、标记 `retryable` 的错误重试一次、未标记错误只尝试一次；sender 挂起时超时后下一条继续，`close()` 有界返回。
    - 配置兜底：文件不存在、非法 JSON、`null`、字段缺失、读取失败 → sender 不被调用、不抛错、`status().enabled===false`。
    - 脱敏：把虚构 host/user/key/hermes/target 注入摘要、失败原因与 sender 异常，断言 title/body、`status().lastError`、`onError` 参数都不含这些值。
    - 三段格式与模型字段。
  - `notify-integration.test.mjs`：用 `workerFixture` + 受控 sender 走真实链路（native `/worker/start` → worker 完成 → `changed()` → 通知）；sender 挂起时 worker 仍能交工、`/worker/result` 仍可返回；随后再触发真实状态变化（如 accept），断言只发一条且包含三段。另用 `plan-review-test-support.mjs` 的 fake reviewer：sender 挂起时评审仍推进到 `changes-required`/`approved`，结果接口可返回。
- 文档：在 `使用说明.md` 增加「微信自动通知」一节（开启方式、事件清单、去重与静默行为）。

**不做：**

- 不做微信回复、远程裁决角力、死锁远程处理（后续功能）。
- 不改 `Desktop.swift`、`build-app.sh`、`bridge.mjs`、`pairing.mjs`、`channel.mjs`、`update.mjs` 及其测试。
- 不把 `.notify.json` 提交进仓库，不在日志/UI 里打印 host/token/target。
- 不改 `workers.mjs`、`plan-review.mjs`、`attention.mjs` 的内部逻辑；只在 `control.mjs` 观察它们的公开状态。
- 不保证失败通知必达：默认 at-most-once，只有确定未发出的错误才重试；失败只计数并脱敏记录。
- 不新增 HTTP 端点或设置字段；开关与去重窗口走 `.notify.json`，去重状态存 daemon 数据目录。

## 事件判定细节

- 基线：`seed` 时已有的 worker / 评审 / attention 一律不通知；只对比之后的状态变化。
- worker 事件 key：`worker:<id>:<status>`；评审事件 key：`plan-review:<reviewId>:<status>:<round>`。
- attention 事件使用**稳定身份**，忽略 `attention.mjs` key 里的时间戳：配对 `attention:pair:<pairId>`，只读核对 `attention:consult:<consultId>`，会话 `attention:conversation:<conversationId>`。同一记录的元数据更新（`updatedAt` 变化、watchdog timeout 后再 onSettled）不构成新事件；同一记录在去重窗口内最多提醒一次，窗口过后再次失败才会重新提醒。
- 重启：去重表与内部 worker 归属持久化。`seed` 只建立基线；`interrupted → recover → changes-required` 回到同一轮次时，key 已在持久化表中，不再发送。
- 评审内部 worker：维护持久化集合 `internalWorkers`，在每次 `seed`/`observe` 时并入所有 `planReviews[].workerId`。worker 事件只要 id 在集合中就不发，覆盖「W1 成为 orphan → 恢复启动 W2 覆盖 workerId → 关闭 W1 变 interrupted」的完整生命周期；普通 consult worker 仍正常通知。集合上限 1000，淘汰时跳过仍被当前 `planReviews[].workerId` 引用或仍处于 `starting`/`running`/`orphan` 的 id（宁可暂时超限也不丢归属），只清理可确认不再变化的历史 id。
- 终态集合：`completed`、`failed`、`stopped`、`orphan`、`interrupted`；非终态变化不发工作方通知。
- 失败细分：`failed` 且错误含 `timed out` / `timeout` / `超时` → 标题写「超时」；`stopped` → 「已停止」；`orphan` → 「孤儿」；`interrupted` → 「中断」。
- 模型：worker 事件取该 worker 快照里的 `model` + `effort`；计划评审事件按 `workerId` 在 workers 快照里回查模型，查不到写「codex 默认」；attention 事件写「不适用」。

## 消息模板

```
项目：Sibyl
任务：工作方 1a2b3c4d · codex/dispatch
模型：gpt-6-astra / high

完成了什么：……
还差什么：……
预计多久：……
```

- 标题（`--subject`）：`项目名 · 事件`，例如 `Sibyl · 工作方完成`。
- 每段裁剪：完成/还差 ≤ 300 字，预计 ≤ 100 字；不含换行注入，不含配置内容。
- 工作方完成：优先用 report 的 `summary`；`needsReview` 为真时把 `reviewReasons` 放进「还差什么」，否则写「无，报告可验收」。失败/孤儿等写错误原因与下一步。
- 计划评审：`changes-required` 统计 blocker/major 数量与问题数；`deadlock` 写「需裁决：继续一轮或取消」；`approved` 写「可以开工」。

## Global Constraints

- Node.js >= 26；零第三方 npm 依赖。
- 只在 `feat/windows-support` 上改；不碰 `develop`；不引入 `src/`。
- 每个任务独立提交；不 push；共享当前 checkout，不建分支。
- 未配置时完全静默：`createControl` 的默认选项不能让现有测试发真实微信。
- 通知失败必须 fail-open：worker / 评审主流程不等通知结果；投递语义为 at-most-once（仅确定未发出的错误重试）。
- 任何日志、状态或消息都不出现 `.notify.json` 的 host/user/key/hermes/target 原值。

## 验收

- `notify-service.test.mjs` 与 `notify-integration.test.mjs` 全过；全量测试 0 fail。
- 集成测试证明：worker 完成在真实链路里触发一条 fake sender 消息；重复状态刷新不重发；未配置时 sender 不被调用。
- 真实 daemon 入口开启通知；`.notify.json` 缺失时启动不报错。
- 收尾用 `scripts/notify-wechat.mjs` 手动发一条阶段总结微信。

## Review Focus

- 事件会不会重复轰炸：基线 seed、持久化 key 去重、重启后 `interrupted → recover` 不重发、attention 时间戳更新不重发。
- 去重状态是否先落盘后发送，状态文件损坏/写入失败时是否停止投递且不影响主流程。
- 通知失败是否真的不影响 worker / 评审（受控挂起 sender 下主流程仍能完成）。
- 重试是否只发生在确定未发送的情况，投递语义是否明确为 at-most-once。
- 未配置或配置损坏（非法 JSON、null、字段缺失、读取失败）时是否静默，且测试不会误发真实消息。
- 发送超时与 `close()` 是否能取消在途发送并有界结束。
- 计划评审内部 consult worker 是否覆盖完整生命周期（含被替换的历史 worker），避免每轮评审多一条。
- 消息、status 与 onError 是否可能泄漏 `.notify.json` 的 host/user/key/hermes/target。

<!-- SIBYL_REVIEW_BEGIN -->
## Codex review

- 状态：approved
- 结论：完整复审通过。当前计划已明确先原子持久化再发送、状态文件故障时停止投递并保持主流程可用；内部 worker 淘汰保护及挂起 sender 下的评审推进测试也已补齐。未发现 blocker 或 major，可按计划实施。
- 评审模型：codex
- 轮次：3
- 采纳：R9
- 残留风险：
<!-- SIBYL_REVIEW_END -->
