# Agents Calling 仓库约定

## 和 Codex 的讨论必须可见（硬规则）

所有与 Codex 的讨论、评审和派活，必须**从任务一开始**就展示在人眼前；不能等任务完成后再刷新会话。

标准顺序（每次派活都照做）：

1. 新建 Codex 会话/工作方：
   - 只读讨论：`bridge_worker_start({tool:"codex", tier:"consult", prompt})`；
   - 写任务：`bridge_worker_start({tool:"codex", tier:"dispatch"|"parallel", scope, prompt})`。
2. **紧接着**运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/focus-codex-thread.ps1 -Match "<任务标题里独有的片段>" -TimeoutSec 25`，把 Codex 窗口切到前台、打开该会话并保持可见。脚本会轮询侧栏直到会话出现。
3. 确认会话已打开后，再发/继续任务 turn（`bridge_worker_turn` 或 `bridge_spawn_turn`）。**不要先等 `bridge_worker_result` 或任务完成**。
4. 执行期间保持 Codex 窗口可见；结束后再用 `bridge_worker_result` / `bridge_worker_accept` / `bridge_worker_close` 收报告。

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

## 其它

- Node >= 26，零第三方 npm 依赖。
- 只在 `feat/windows-support` 的扁平布局上改；不碰 `develop`，不引入 `src/`。
- 测试用 Node 26：`"/d/LXY_workspace/AI Bridge/.tools/node26/node-v26.13.0-win-x64/node.exe" --test --test-concurrency=1 --test-timeout=30000 *.test.mjs`。
