---
review: approved
change:
  scope: [skills]
  files: 1
---

# Codex 可见性 — 结论与流程

**Goal:** 把「Codex 讨论从任务开始就可见」落到可执行、不依赖 Codex 桌面 App 的流程：CLI worker + 本地 Web 面板。

**Why:** 深链 `codex://threads/<id>?hostId=local` 只在 Codex App 本地 host 启动时已加载该线程的情况下有效；App 启动后新建的桥接线程会落到 ChatGPT 首页，必须重启 Codex 才可能认识，而 App 没有可用的 Reload 或 Ctrl+R。用户已在 2026-11-09 明确要求不再折腾 App 窗口，可见面改为本地 Web 面板。

**已核实的行为（只读）：**

- `scripts/open-codex-thread.ps1` 只做 `Start-Process codex://threads/<id>?hostId=local`，不读写 App 状态，也不会重载已有 App 实例。
- 实测结论（2026-11-08 交接文档 §4.1、2026-11-09 用户反馈）一致：App 启动前创建/已加载的线程可由深链打开；启动后新建的桥接线程通常落到首页，重启 App 后才可能可见。`OPENED` 只代表协议被唤起，不代表线程可见。
- worker 的线程、轮次、评审状态在 `/api/status` 与 SSE 中都有，Web 面板不依赖 App。

**Architecture:** 只改协作说明，不改代码与端点。`open-codex-thread.ps1` / `focus-codex-thread.ps1` 保留在仓库中作为诊断工具，但从派活流程里移除。

## 范围

**做：**

- 更新 `skills/agents-calling/SKILL.md` 第 0 步与第 2 步：可见面改为本地 Web 面板；深链降级为诊断工具；记录 App 已加载线程的限制。
- 明确两种呈现面的职责：
  - **面板**：worker / 评审的运行状态、线程、轮次、问题数量。
  - **当前对话**：每次 `bridge_worker_turn` / `bridge_plan_review_continue` 之前，贴出本轮要发送的任务或评审问题；收到回答、回应 issue/question、发起下一轮时，把内容同步回对话。状态可见不能代替讨论可见。
- 补上打开面板的可执行步骤：`start-observer.cmd`，或 `powershell -NoProfile -ExecutionPolicy Bypass -File start-browser.ps1 -Page observer -DataDir "<当前 bridge 使用的数据目录>"`；确认浏览器中能看到当前 worker/review 且连接正常后，才发 turn / `confirmVisibility:true`。`/api/status` 只作辅助检查；打开失败就停止派活并报告。
- 保持原有硬约束：讨论从任务开始就可见、先拿 `threadId` 再发 `turn`、不先等任务完成。

**不做：**

- 不改 `control.mjs`、worker/评审代码、`/api/status`。
- 不删除深链脚本，也不新增 App 自动化。
- 不改 `CLAUDE.md`：该文件当前有用户未提交的改动，且用户的 2026-11-09 指示已取代其中的深链步骤；本次只改产品内的 Skill 文档。
- 不把可见性做成产品承诺之外的代码路径（Web 面板已有）。

## Review Focus

- 不能把可见性重新绑回 Codex App 或深链。
- 不能丢掉「讨论从任务一开始可见」：用 Web 面板 + 对话呈现。
- 只动文档，不影响既有 worker / 计划评审流程与测试。
- 明确 CLAUDE.md 不在本次改动范围，避免评审把仓库约定当成产品文档。

## Task 1: 更新 Skill 文档

**Files:**
- Modify: `skills/agents-calling/SKILL.md`

- [x] **Step 1: 写变更** — 第 0 步改为「CLI worker + 本地 Web 面板」，记录深链限制；补上面板启动命令、面板/对话职责划分与失败即停；第 2 步的可见性确认改为「面板已实际显示线程/评审且连接正常」。
- [x] **Step 2: 核对** — 文档不再要求任何深链步骤；诊断脚本仅作为排查工具出现一次；对话同步动作写进流程。
- [ ] **Step 3: 测试** — 文档改动不影响代码；跑全量测试确认 0 fail。
- [ ] **Step 4: 提交** — 与 worker gate 分开提交（文档提交）。

## 验收标准

- `skills/agents-calling/SKILL.md` 不含「必须用深链打开」的流程要求。
- 文档明确：面板负责运行状态；当前对话负责贴出并同步任务/评审讨论内容。
- 文档给出可执行的打开面板命令，并要求发 turn / `confirmVisibility:true` 前确认浏览器已实际显示对应 worker/review；打开失败停止派活。
- 全量测试 0 fail。
- 代码与端点零改动。

<!-- SIBYL_REVIEW_BEGIN -->
## Codex review

- 状态：approved
- 结论：完整复核当前计划后，上一轮两项主要问题均已落实：明确面板展示状态、当前对话同步讨论内容，并补齐面板启动、当前实例确认及失败停止步骤。单文件文档范围清晰，与现有实现一致，未发现新的阻断项；全量测试仍需按计划完成。
- 评审模型：codex
- 轮次：2
- 采纳：R1, R2
- 残留风险：
<!-- SIBYL_REVIEW_END -->
