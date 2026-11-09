# Agents Calling 仓库约定

## 和 Codex 的讨论必须可见（硬规则）

所有与 Codex 的讨论、评审和派活，必须**从任务一开始**就展示在人眼前；不能等任务完成后再刷新会话。

标准顺序（每次派活都照做）：

1. 新建 Codex 会话/工作方（**不要带 `prompt`**）：
   - 只读讨论：`bridge_worker_start({tool:"codex", tier:"consult"})`；
   - 写任务：`bridge_worker_start({tool:"codex", tier:"dispatch"|"parallel", scope})`。
2. 轮询 `bridge_worker_result({workerId, waitMs})`，直到返回非空 `threadId`（通常 <1 秒）。
3. 用深链打开会话（不依赖窗口位置）：
   `powershell -NoProfile -ExecutionPolicy Bypass -File "D:\LXY_workspace\AI Bridge\Sibyl\scripts\open-codex-thread.ps1" -ThreadId "<threadId>"`
   脚本默认带 `?hostId=local`；不带这个参数时 Codex 会去查云端 host，落到 ChatGPT 首页。工作方跑在本地 host，所以必须带 `local`。
   注意：深链只对 Codex App 本地 host **已加载**的线程有效。App 启动后新建的桥接线程通常要重启 Codex 才能被认识；App 没有可用的 Reload 菜单或 Ctrl+R。如果打开后仍落在 ChatGPT 首页，不要反复重试——重启 Codex 后再打开，或改用 Phase C 观测页/CLI。不要把“深链返回 OPENED”当成“线程一定可见”。
4. 确认窗口已切到前台后，再发任务：`bridge_worker_turn({workerId, prompt})`。**不要先等任务完成**。
5. 执行期间保持 Codex 窗口可见；结束后再用 `bridge_worker_result` / `bridge_worker_accept` / `bridge_worker_close` 收报告。

注意：`bridge_worker_start` 带 `prompt` 时，首轮结束会自动 finalize，后续 `turn` 会被拒绝；所以默认不带 prompt。只有拿不到 `threadId`（旧记录或异常）时，才用 `focus-codex-thread.ps1 -Match "<标题片段>"` 兜底；标题是首轮 prompt 的截断，片段必须真的出现在侧栏标题里。`focus-codex-thread.ps1` 默认不再移动/缩放窗口；需要置顶才传 `-Topmost`。

`bridge_ask` 只对**已经存在的 Codex 原会话**投递问题，它不唤醒会话，需要对方 `bridge_receive`；仅在要求续原会话时使用。`bridge_consult` 是 legacy 后台 `codex exec` 核对，不进列表；新讨论默认不用。

## 大计划先评审（硬规则）

写实施计划之后、动代码之前，如果属于「大计划」，必须先让 Codex 评审计划（按上面的可见性规则走 `bridge_worker_start({tier:"consult"})`，并在评审开始前用 focus 脚本打开会话）。拿到回答后，把结论和采纳情况写回计划的 `## Codex review` 一节。

以下任一条件成立就是**大计划**，必须评审：

- 计划 ≥ 5 个可独立交付的任务（测试步骤不算任务），或预计改 ≥ 5 个产品代码文件；
- 新增/删除/重命名公共接口：MCP 工具、HTTP 端点、持久化表或字段、鉴权/权限契约、配置格式、模块导出；
- 改变并发所有权：锁、租约、进程生命周期、异步任务、超时、取消、重启恢复；
- 自动执行 git 写操作、数据迁移/删除、部署或其他不可逆操作；
- 新增模块或目录，或偏离已批准设计中的明确约束；
- 预计 > 2 小时，或需要跨会话继续。

接口、持久化、权限、并发、不可逆操作这几类是**必评项**，不受任务数豁免。数量阈值只作兜底。

**小计划**（可跳过评审）必须同时满足：1–2 个任务、≤ 3 个产品文件、无上述必评项、可逆、预计 ≤ 30 分钟。边界不清时按大计划处理——评审的成本是一分钟，返工的成本是半天。

评审不可用（Codex 原会话不在线）时，停下来告诉人，不要静默跳过。

## 角色分工（硬规则）

- **Claude**：写计划 → 与 Codex 协商完善 → 作为总工程师分配任务 → 验收结果。
- **Codex**：评审计划 → 执行任务。
- 顺序：Claude 计划 → Codex 评审 → 协商完善 → Claude 分配 → Codex 执行 → Claude 验收。
- 不要把两者对调成「Claude 执行、Codex 评审」。

## 计划评审工具（核心版）

- 结构计划：`bridge_plan_review({planPath})` → `awaiting-visibility` → 确认可见后 `bridge_plan_review_continue({reviewId,confirmVisibility:true})` → `bridge_plan_review_result`。
- 回应：`bridge_plan_review_respond`；issue 用 `{type:'issue',issueId,decision,evidence?,planChange?}`，question 用 `{type:'question',questionId:'Q1',answer}`；必须覆盖当前轮全部 blocker/major 和 questions。
- 死锁：`bridge_plan_review_decide({choice:'1'})` 只用一次；`0` 取消；核心版不通过工具产生 waived。
- 重启：`bridge_plan_review_recover`；同项目新会话可 `takeover:true`。
- 边界：Stop 提醒 + PreToolUse ask/deny，不覆盖 Bash/git/worker 写入；不保证绝对阻断；daemon gate、微信、USD、强制 Focus 留后续。

## 其它

- Node >= 26，零第三方 npm 依赖。
- 只在 `feat/windows-support` 的扁平布局上改；不碰 `develop`，不引入 `src/`。
- 测试用 Node 26：`"/d/LXY_workspace/AI Bridge/.tools/node26/node-v26.13.0-win-x64/node.exe" --test --test-concurrency=1 --test-timeout=30000 *.test.mjs`。
