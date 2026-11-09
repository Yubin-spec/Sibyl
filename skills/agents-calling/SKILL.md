---
name: agents-calling
description: Use when the user says "你和 Codex/Claude 协作", asks another local AI tool to review or change this repository, or wants two tools to work on different parts.
---

# Agents Calling 协作档位

收到「你和 X 协作」时，先选档位，不要问人：

| 档位 | 什么时候 | 用什么 | 是否合并 |
|---|---|---|---|
| 问一下 | 只需要对方看、评、核对，不改文件 | `bridge_worker_start({tier:"consult",prompt})`：自动新建可见的只读 Codex 会话；要续原会话用 `bridge_ask`；仅人明确同意时用 legacy 后台核对 `bridge_consult` | 不合并 |
| 派个活 | 一块改动，一个工作方动手 | `bridge_worker_start`（`tier:"dispatch"`） | 主导方验收后贴补丁 |
| 分头干 | 两块以上互不相交的改动 | 多次 `bridge_worker_start`（`tier:"parallel"`）+ 不相交 `scope` | 按顺序贴补丁 |

## 第 0 步：讨论必须从任务一开始可见

所有讨论（评审、核对、问答）必须从任务一开始就可见；可见面是**本地 Web 面板**和**当前对话**，不依赖 Codex 桌面 App 窗口。

两种呈现面分工：

- **面板**（观测页，数据来自 `/api/status` + SSE）：worker / 评审的运行状态、线程、轮次、问题数量。
- **当前对话**：讨论内容本身。每次 `bridge_worker_turn` / `bridge_plan_review_continue` 之前，贴出本轮要发送的任务或评审问题；收到回答、回应 issue/question、发起下一轮时，把内容同步回对话。只看到卡片不等于讨论可见。

打开面板：

```bash
start-observer.cmd
```

或指定当前 bridge 的数据目录：

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File start-browser.ps1 -Page observer -DataDir "<当前 bridge 使用的数据目录>"
```

`/api/status` 只作辅助检查；打开失败或连接不到当前实例时，停止派活并报告，不要只用 API 结果代替人眼可见。

已确认的限制：`codex://threads/<id>?hostId=local` 深链只对 Codex App 本地 host **启动时已加载**的线程有效；App 启动后新建的桥接线程通常要重启 Codex 才能被认识，且 App 没有可用的 Reload 或 Ctrl+R。因此不要把深链当作可见性保障，也不要在产品流程里自动化 Codex App 窗口。

## 一键入口与上下文 hook

- `node scripts/sibyl.mjs status`：打印工作方、计划评审、待办、待答问题摘要；加 `--json` 输出机读字段。
- `node scripts/sibyl.mjs open`：打印并打开当前观测页；`--no-open` 只打印 URL。
- `node scripts/sibyl.mjs hooks off|on|status`：关闭 / 开启 / 查看上下文 hook。离线可用，写在 `<数据目录>/hook-context.json`。
- SessionStart hook 注入项目与未处理事项；UserPromptSubmit hook 注入待答问题与评审提醒。两者都是只读：不标记已读、不阻塞提交、超时或 daemon 不可用时静默放行。Stop / PreToolUse 仍按各自 hook 条目生效。
- Codex 没有 hooks；Codex 侧的任务开始 / 交工前检查点见仓库根 `AGENTS.md`。

派活顺序固定：

1. `bridge_worker_start({tool:"codex", tier:"consult"|"dispatch"|"parallel", scope?})` 建会话/工作方，**不要带 `prompt`**；
2. 轮询 `bridge_worker_result({workerId, waitMs})`，直到返回非空 `threadId`（通常 <1 秒）；
3. 确认浏览器面板已实际显示该 worker / 线程且连接正常，并在对话里贴出即将发送的任务，再调用 `bridge_worker_turn({workerId, prompt})`；**不要先等任务完成**；
4. 执行期间让面板保持可见；收到 `result.lastTurn` / 报告后，把回答和下一步同步回对话，再用 `bridge_worker_accept` / `bridge_worker_close` 收尾。

`bridge_worker_start` 带 `prompt` 时，首轮结束会自动 finalize，后续 `turn` 会被拒绝；所以默认不带 prompt。`open-codex-thread.ps1` / `focus-codex-thread.ps1` 保留为诊断和人工排查工具，不是派活流程的一部分。

长评审的 `timeoutMs` 用 600000。`bridge_ask` 只用于续接已有原会话（不唤醒，需对方 `bridge_receive`）；`bridge_consult` 是 legacy 后台核对，Codex 路径使用 `codex exec` Worker，不进列表，仅人明确同意时用，事后必须同步到可见会话。

上面的调用只示意档位；实际调用 `bridge_worker_start` 时还须传 `tool:"codex"`；默认不带 `prompt`，先拿 `threadId`，再 `bridge_worker_turn`。旧版独立启动工具已在本版本移除。

## 第 2 步：计划评审回路

结构计划用 `bridge_plan_review({planPath})` 启动评审；它创建一个只读 Codex worker，先停在 `awaiting-visibility`。在对话里贴出计划路径与本轮评审重点，并在浏览器面板确认线程/评审已实际显示、连接正常后，调用 `bridge_plan_review_continue({reviewId,confirmVisibility:true})` 才发第一轮；`bridge_plan_review_result` 取 verdict 后，把 verdict、issue/question 和回应同步回对话。

- `changes-required`：用 `bridge_plan_review_respond` 逐条回应。issue 用 `{type:'issue',issueId,decision:'accept'|'reject',evidence?,planChange?}`；question 用 `{type:'question',questionId:'Q1',answer}`。必须覆盖当前轮全部 blocker/major 和 questions。
- `deadlock`：`bridge_plan_review_decide({choice:'1'})` 只用一次，启动最后一轮；`choice:'0'` 取消。核心版不通过工具产生 waived。
- 重启后 `interrupted`：`bridge_plan_review_recover`；同项目新会话可传 `takeover:true`。
- Stop hook 会提醒未批准的结构计划；PreToolUse 对 `Write/Edit/MultiEdit` 返回 ask，声明 `irreversible` 时 deny。它不覆盖 Bash/git/worker 写入，也不保证绝对阻断。
- 非结构计划（`review: not-required` 且无 scope/concurrency/irreversible/规模）不会创建评审。

## 第 1 步：大计划先评审

写实施计划之后、动代码之前，如果属于**大计划**，先用上面的可见方式让 Codex 评审计划，拿到回答并采纳后再开工：

- 必评项（不看任务数）：新增/删除/改公共接口（工具、HTTP 端点、持久化字段、鉴权、配置格式、模块导出）；改变并发所有权（锁、租约、进程生命周期、异步/超时/取消/重启）；自动 git 写、数据迁移/删除、部署等不可逆操作；偏离已批准设计。
- 规模兜底：≥5 个可独立交付任务（测试步骤不算任务），或 ≥5 个产品代码文件，或新增模块/目录。
- 小计划可跳过：1–2 个任务、≤3 个产品文件、无必评项、可逆、≤30 分钟。
- 边界不清按大计划处理；无法新建可见 Codex 会话或续接已有原会话时停下来告诉人，不要静默跳过，也不要自行改用 legacy 后台核对。

**模型选择：** 默认 `model:"auto"`，不要手动指定。用 `kind` 和 `risk` 告诉 daemon 任务形状：

- `kind:"mechanical"`（改名、格式、文档小修）→ 便宜快的 `gpt-6-luna` + low；
- `kind:"review"` + `risk:"normal"`（普通评审）→ `gpt-6.1-terra` + medium；
- `kind:"review"` + `risk:"high"`（并发/租约/持久化/安全/不可逆）→ `gpt-6.1-sol` + high；
- `kind:"implement"` → `gpt-6.1-sol` + medium，`risk:"high"` 时 high；
- `kind:"frontier"`（确实很难、前几次都失败）→ `gpt-6-astra` + high。

只有人明确要求换模型时才传 `model`；`bridge_worker_result`/`bridge_worker_list` 会回显实际使用的 `model` 和 `effort`。

**项目覆盖：** 项目的 `.sibyl/models.json` 可以覆盖上表任意一档，只写需要改的 `model` / `effort`，其余沿用默认。优先级为「显式 `model` > 项目配置 > 默认表」，命中项目配置时 `modelReason` 带 `project:` 前缀。配置非法会让 worker 启动直接失败并给出文件路径与字段，不要靠改默认表绕过。计划评审 worker 不走项目路由表；要换评审模型，只能用计划评审配置的 `reviewerModel` / `reviewerFinalModel`。

**规则：**

- `scope` 写项目相对路径，只列这次真的要改的目录/文件；共享文件（package.json、锁文件、tsconfig、.github/.claude 等）不能进 scope，工作方要改只能写进 `changeRequests`。主导方自己要改的路径用 `leadScope` 登记，工作方就不能占用。
- 派活后主导方不得改该 `scope` 内的文件；需要动时先 `bridge_worker_result` 等它交工，或用 `bridge_lease_check` 确认。
- `bridge_worker_start` 立刻返回 `workerId`；用 `bridge_worker_result` 轮询，不要重复派同一件事。`bridge_worker_turn` 只入队，轮次结果看 `result.lastTurn`。
- 验收看报告里的 `files`、`stats`、`scope.outOfScope`、`scope.sharedChanged`、`unsafeChanges`、`verification`、`verificationSource`、`acceptanceCriteria`、`risks`、`blockers`、`leadChanges`、`refsChanged`。只有 `deliverable.path` 非空时才贴 `<workerId>.deliverable.patch`；为 null 时先让工作方修正或人工处理，不要贴全量 patch。验收完成后调用 `bridge_worker_accept` 记录 accepted/rejected。
- 贴补丁协议：一次只贴一个；贴前 `git status` 记下主导方已有的 staged/unstaged 改动，并重新 `bridge_lease_check`；**只用 `git apply <deliverable.patch>`，失败就停下来报告，不自动解、不 `reset`、不用 `--3way`/`--index`**。主导方在 scope 内有 staged 改动时不要贴，先提交或取消暂存。贴完用 `bridge_worker_accept` 记录验收结果。
- Codex 在 Windows 沙箱内跑不了测试，`verification` 是工作方自报，测试由主导方在沙箱外执行。
- 非 git 项目不能派活，只能「问一下」。当前 worker 入口要求已提交过的 git 仓库根目录；非 git 目录的只读讨论走已有原会话，不会自动降级为可写工作方。
