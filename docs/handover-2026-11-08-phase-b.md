# Phase B 交接文档

日期：2026-11-08  
仓库：`D:\LXY_workspace\AI Bridge\Sibyl`  
分支：`feat/windows-support`（不要碰 `develop`）

## 1. 当前状态

- Phase B 全部完成，代码已提交，工作区干净（本文档除外）。
- 提交范围：`9c5dddd..94456cd`（Phase B 起点之后的 17 个提交）。
- 全量测试：**229 tests，225 pass / 4 skip / 0 fail**。
- 未 push；未合并 `develop`。
- Phase C（只读观测页）已作为第七个页面完成；Phase D（打包）尚未开始。

关键提交：

| 提交 | 内容 |
|---|---|
| `2e17f51` | Task 1：档位预算 + Codex 模型自动选择 |
| `18b0e47` | Task 2：路径 scope、共享文件、租约冲突 |
| `b9f5d10` | Task 3：worktree 与派活前快照 |
| `ea8bc47` | Task 4：结构化交工报告 |
| `8ea821d` | Task 5：daemon 工作方生命周期 |
| `a0bf4d2` | Task 6：租约、档位上限、主导方改动、孤儿 |
| `d3b7208` | Task 7：持久化、native 端点、control 接线 |
| `3ebe6f1` | Task 8：MCP 工具改名与转发 |
| `d231386` / `6630e30` | Task 9：Skill 与文档 |
| `e2b1663` | Task 10：三档端到端测试 |
| `f037c85` | 最终 Codex 评审的 11 个 Important 修复 |
| `c138b6e` / `94456cd` | Codex 会话「开始前聚焦」脚本与绝对路径文档 |

## 2. 已完成的能力

- **三档**：`consult`（只读可见会话）/ `dispatch`（单工作方）/ `parallel`（多工作方，默认每会话 3、每项目 4）。
- **路径租约**：`scope` 声明；live 工作方路径不得重叠；`leadScope` 登记主导方保留路径；worker 与 lead 租约都按 `leaseId` 精确释放，lead 租约按引用计数保留。
- **共享文件归主导方**：内置 `package.json`/锁文件/`tsconfig`/`.github`/`.claude` 等；项目级 `.sibyl/shared-files.json` 可 `add`/`remove`；worker 改到共享文件会进入 `changeRequests`/报告告警。
- **派活前快照**：`<project>/.sibyl/worktrees/<workerId>`，分支 `sibyl/worker/<workerId>`；复制未提交/未跟踪文件、跳过 ignored；复制前后比较文件集合与内容指纹；daemon 不提交主导方分支。
- **交工报告**：完整 diff 落 `.sibyl/reports/<workerId>.patch`，可交付补丁 `.deliverable.patch`，结构化 JSON `.json`；文件清单与 diff 以 git 为准；越界/共享/符号链接/提交失败会阻断交付；新增 `bridge_worker_accept` 记录主导方验收。
- **按档位预算**：consult 15min/10min/12 每小时；dispatch 30min/15min/6 每小时；parallel 60min/15min/10 每小时；看门狗使用档位预算，不再复用 `bridge_consult` 的 180s/120s。
- **模型自动选择**：`model:"auto"` + `kind`/`risk` → `gpt-6-luna`（机械）/ `gpt-6.1-terra`（普通评审）/ `gpt-6.1-sol`（实现、高风险评审）/ `gpt-6-astra`（frontier）。显式 `model`/`effort` 优先；不支持的模型直接失败，不静默替换。
- **生命周期归 daemon**：`control.mjs` 持有工作方；MCP 退出不影响工作方；daemon 重启把未完成记录标 `orphan` + `exit-unconfirmed` 并保留租约；超时/孤儿走统一收工路径；进程树用 `taskkill /T /F`（Windows）/ 进程组（POSIX）终止。

## 3. 代码结构

| 文件 | 职责 |
|---|---|
| `consult-policy.mjs` | 原 consult 预算 + `DEFAULT_WORKER_LIMITS` / `normalizeWorkerLimits` / `workerTurnTimeoutMs` / `checkWorkerCapacity` |
| `model-policy.mjs` | `CODEX_MODELS`、`chooseCodexModel` |
| `path-scope.mjs` | scope 归一化、段边界重叠、共享文件集合、租约冲突、`checkPaths` |
| `worker-worktree.mjs` | 仓库校验、`.git/info/exclude`、快照/工作树、`commitWorktree`、`scopeFingerprint`、`listRefs`/`refChanges` |
| `worker-policy.mjs` | 工作方系统提示、派活 prompt、报告块协议 |
| `worker-report.mjs` | 报告解析、git 文件清单/diff、交付判定、原子写报告 |
| `workers.mjs` | 工作方服务：start/turn/result/close/accept/list/checkLease/closeAll，看门狗、孤儿、租约 |
| `workspace.mjs` | `meta('workers')`、`listWorkers`/`saveWorker`；重启把 live 记录转 orphan |
| `native-inbox.mjs` | `/worker/*`、`/lease/check`，全部在会话租约 `own(body)` 之后 |
| `control.mjs` | 创建 worker 服务、注入 `sessionAlive`、`state.workers`、关闭顺序 |
| `native-mcp.mjs` | 7 个 `bridge_worker_*` / `bridge_lease_check` 工具，仅转发 |
| `scripts/spawn-codex-chat.mjs` | Codex app-server 启动器：`--model`、立即 close、SIGTERM |
| `scripts/spawn-claude-chat.mjs` | Claude 启动器：`--model`、close/SIGTERM 立即 kill |
| `skills/agents-calling/SKILL.md` | 档位判断、可见性顺序、模型选择、验收/贴补丁规则 |

MCP 工具（旧 `bridge_spawn*` 已删除）：

- `bridge_worker_start({tool,tier,scope?,leadScope?,prompt?,model?,kind?,risk?,effort?,timeoutMs?})`
- `bridge_worker_turn` / `bridge_worker_result` / `bridge_worker_close` / `bridge_worker_accept` / `bridge_worker_list`
- `bridge_lease_check({paths})`
- `bridge_consult*` 保留为 legacy 后台只读核对；`bridge_ask` 只用于续已有原会话。

本地 HTTP（native inbox）：`POST /worker/start`（202）、`/worker/turn`、`/worker/result`、`/worker/close`、`/worker/accept`、`/worker/list`、`/lease/check`。`/api/status` 的 `workers` 已供 Phase C 使用。

## 4. 必须遵守的流程

### 4.1 Codex 会话必须从任务开始就可见

顺序固定，不能等任务完成再刷新：

1. `bridge_worker_start({tool:"codex", tier:"consult"|"dispatch"|"parallel", scope?})`，**不要带 `prompt`**；
2. 轮询 `bridge_worker_result({workerId, waitMs})`，直到返回非空 `threadId`；
3. 用深链打开（绝对路径，不依赖 cwd，也不依赖窗口位置）：

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\LXY_workspace\AI Bridge\Sibyl\scripts\open-codex-thread.ps1" -ThreadId "<threadId>"
```

4. 确认窗口已切到前台后，再发任务 `bridge_worker_turn({workerId, prompt})`；
5. 执行期间保持窗口可见，结束后再 `bridge_worker_result` / `bridge_worker_accept` / `bridge_worker_close`。

深链格式是 `codex://threads/<threadId>?hostId=local`（AppxManifest 注册的 `codex` 协议，前端路由 `codex://threads/`）。`hostId=local` 不能省：不带时 Codex 默认去查云端 host，会落到 ChatGPT 首页；工作方跑在本地 host，所以必须带 `local`。它按线程 ID 打开，不读 UIAutomation 元素、不移动窗口，所以换显示器/换位置都不受影响。

**已实测的限制**：深链只对 Codex App 本地 host **已加载**的线程有效。App 启动前创建的桥接线程（如 `01a1bb92`）重启后可以用深链打开；App 启动后新建的线程即使带 `hostId=local` 也会落到 ChatGPT 首页，直到重启 Codex。App 没有可用的 Reload 菜单，Ctrl+R 也不重载。不要把“OPENED”当成“一定可见”；真正稳定的可见面应是 Phase C 观测页或 CLI。

`bridge_worker_start` 带 `prompt` 时，首轮结束会自动 finalize，后续 `turn` 会被拒绝；所以默认不带 prompt。只有拿不到 `threadId`（旧记录或异常）时，才用 `focus-codex-thread.ps1 -Match "<标题片段>"` 兜底。标题是首轮 prompt 的截断，片段必须真的出现在侧栏标题里；旧版会把窗口移到主屏全屏，新版默认不动窗口，需要置顶才传 `-Topmost`。

### 4.2 大计划先评审

接口/持久化/权限变化、并发所有权（锁/租约/进程生命周期/异步/超时/取消/重启）、自动 git 写或不可逆操作、偏离已批准设计——任一命中就必须先评审；规模兜底 ≥5 个可独立交付任务或 ≥5 个产品代码文件。评审结论写进计划的 `## Codex review`。

### 4.3 每个任务完成发微信，并带模型

```bash
node scripts/notify-wechat.mjs --title "<阶段/任务>" --body "<完成了什么 / 还差什么 / 预计多久；实现模型；Codex 模型>"
```

`.notify.json` 已配好。示例：实现 `Claude Sonnet 5`；Codex 执行/评审 `gpt-6.1-sol`（effort high）。

### 4.4 测试与提交

Node 26（PATH 上的 node 22 会让 `browser.test.mjs` 失败）：

```bash
"/d/LXY_workspace/AI Bridge/.tools/node26/node-v26.13.0-win-x64/node.exe" --test --test-concurrency=1 --test-timeout=30000 *.test.mjs
```

每个任务独立提交；不碰 `develop`；不 push 除非人明确要求。

## 5. 已知坑与限制

- **Codex 在 Windows 沙箱内不能创建子进程**（`spawn EPERM`），因此它不能跑 `node --test`、不能 `git commit`；Codex 只负责改文件，测试/提交/验收由主导方在沙箱外做。
- **MCP 的 cwd 必须是仓库根**。当前这套 MCP 进程是在 `D:\LXY_workspace\AI Bridge`（父目录）启动的，而 git 根是 `Sibyl`；在这种会话里调用 `bridge_worker_start` 会报 “needs the repository root”。**接手时请从 `D:\LXY_workspace\AI Bridge\Sibyl` 启动 Claude Code / MCP**。
- `browser.test.mjs` / `project-binding.test.mjs` 在整机负载高时偶发时序失败；单跑通过，最终全量已绿。遇到先重跑并单独验证，不要改产品逻辑。
- 本机 `tmpdir()`（`C:\Users\helen\AppData\Local\Temp`）位于 `C:\Users\helen` 这个 git 仓库内，所以“非 git 目录”测试会收到 “needs the repository root” 而不是 “needs a git repository”；测试同时接受两种文案。
- `core.autocrlf=true`：`git apply` 会把补丁写成 CRLF；相关测试断言已归一化 CRLF→LF。
- 工作树的 `node_modules` 不共享（本仓库零依赖）；有依赖的项目留到 Phase D 安装流程。
- Phase B 只承诺**单主导方串行集成**；没有 daemon 级跨会话集成锁。贴补丁一次一个，失败即停，不用 `--3way`/`--index`。
- `bridge_consult` 是 legacy 后台 `codex exec`，不进 Codex 列表；新讨论统一用 `bridge_worker_start(tier:"consult")`。

## 6. 下一步建议

### Phase C：只读观测页（已完成）

实现为 `desktop.*` 的第七个只读页面；复用 `/api/status` 和 `/api/events`，没有新增 HTTP 端点。展示工作方、核对线程、计划评审、运行记录和待处理事项；页面内没有写按钮，所有操作仍在对应的 Agent 对话里说。

已有数据：`/api/status` 包含 `workers`、`consultations`、`operations`、`attention`、`conversations`，`/api/events` 是 SSE 状态流。

建议：

- 新增独立只读页面（`observer.html/js/css` 或复用 `desktop.*` 的只读路由），默认 `127.0.0.1`，不提供任何写按钮。
- 展示：线程列表（发起方↔目标、档位、状态、耗时）、单线程轮次与停止原因、工作方（worktree/分支/改动文件/交付状态/模型）、需要人拍板（合并冲突、超时、租约被拒、孤儿）。
- 测试：只读端点、SSE 状态、敏感字段不泄漏、没有写路由。

### Phase D：打包

- Claude Code 插件包（MCP + Skill + 斜杠命令）。
- Codex 侧 `AGENTS.md` 片段 + `codex mcp add`。
- 一次安装；Windows 优先。

### 遗留待决

- 工作树/报告的自动清理策略；orphan 的显式释放 UX（当前 `close` 可从同项目的新会话释放）。
- `bridge_consult` 是否在 Phase C/D 删除。
- 多主导方并发集成是否需要 daemon 级锁。
- `parallel` 上限是否保持 3。
- 是否把 Phase B 合并回 `develop`（设计文档要求先不合并，等风格升级单独做）。

## 7. 接手检查清单

- [ ] 从 `D:\LXY_workspace\AI Bridge\Sibyl` 启动会话，确认 `git branch --show-current` 是 `feat/windows-support`。
- [ ] 跑一次全量 Node 26 测试，确认 0 fail。
- [ ] 读 `docs/superpowers/specs/2026-11-08-agent-collaboration-design.md`（§9 阶段划分）与 `docs/superpowers/plans/2026-11-08-phase-b-tiers-leases-reports.md`（Phase B 计划与 `## Codex review`）。
- [ ] 需要 Codex 协作时，先建会话 → `focus-codex-thread.ps1` → 再发 turn。
- [ ] 每个任务完成发微信，body 带实现模型与 Codex 模型。
