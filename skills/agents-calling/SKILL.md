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

## 第 0 步：和 Codex 的讨论必须可见

所有讨论（评审、核对、问答）必须自动出现在 Codex 桌面聊天列表里，不需要人做中间操作。默认用 `bridge_worker_start({tier:"consult", tool:"codex", prompt})` 新建一个可见的只读 Codex 会话；它走 app-server，会进列表。长评审的 `timeoutMs` 用 600000。`bridge_ask` 只用于续接已有原会话（不唤醒，需对方 `bridge_receive`）；`bridge_consult` 是 legacy 后台核对，Codex 路径使用 `codex exec` Worker，不进列表，仅人明确同意时用，事后必须同步到可见会话。

上面的调用只示意档位；实际调用 `bridge_worker_start` 时还须传 `tool:"codex"` 和 `prompt`。旧版独立启动工具已在本版本移除。

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

**规则：**

- `scope` 写项目相对路径，只列这次真的要改的目录/文件；共享文件（package.json、锁文件、tsconfig、.github/.claude 等）不能进 scope，工作方要改只能写进 `changeRequests`。主导方自己要改的路径用 `leadScope` 登记，工作方就不能占用。
- 派活后主导方不得改该 `scope` 内的文件；需要动时先 `bridge_worker_result` 等它交工，或用 `bridge_lease_check` 确认。
- `bridge_worker_start` 立刻返回 `workerId`；用 `bridge_worker_result` 轮询，不要重复派同一件事。`bridge_worker_turn` 只入队，轮次结果看 `result.lastTurn`。
- 验收看报告里的 `files`、`stats`、`scope.outOfScope`、`scope.sharedChanged`、`unsafeChanges`、`verification`、`verificationSource`、`acceptanceCriteria`、`risks`、`blockers`、`leadChanges`、`refsChanged`。只有 `deliverable.path` 非空时才贴 `<workerId>.deliverable.patch`；为 null 时先让工作方修正或人工处理，不要贴全量 patch。验收完成后调用 `bridge_worker_accept` 记录 accepted/rejected。
- 贴补丁协议：一次只贴一个；贴前 `git status` 记下主导方已有的 staged/unstaged 改动，并重新 `bridge_lease_check`；**只用 `git apply <deliverable.patch>`，失败就停下来报告，不自动解、不 `reset`、不用 `--3way`/`--index`**。主导方在 scope 内有 staged 改动时不要贴，先提交或取消暂存。贴完用 `bridge_worker_accept` 记录验收结果。
- Codex 在 Windows 沙箱内跑不了测试，`verification` 是工作方自报，测试由主导方在沙箱外执行。
- 非 git 项目不能派活，只能「问一下」。当前 worker 入口要求已提交过的 git 仓库根目录；非 git 目录的只读讨论走已有原会话，不会自动降级为可写工作方。
