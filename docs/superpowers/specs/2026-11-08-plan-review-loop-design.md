# 计划评审回路设计（Plan Review Loop）

日期：2026-11-08
状态：待评审
范围：第一阶段（Codex 主导；本地模型作为后续阶段）

> 核心版范围以 `docs/superpowers/plans/2026-11-08-plan-review-loop-core.md` 的 Rev 5 为准：微信通道、绝对阻断、UserPromptSubmit、强制 Focus 覆盖、USD 计量、独立 `review` tier 属于后续阶段；核心版只承诺“Stop 提醒 + PreToolUse ask/deny，不覆盖 Bash/git/worker 写入”。
> 验收只验证有界回路与结构化 verdict，不以 `approve` 为唯一目标；`changes-required` 也是验收通过。详见核心计划的“验收边界”。

## 1. 意图

人看不懂 AI 产出的完整计划，也没有能力逐条审核。需要一个独立 AI 在**计划成形时**和**执行中发生结构变更时**替人做评审，在执行细节上互相挑错，降低返工概率。

触发点不是“打开某个项目”，而是一个交付物：计划文件。评审不是一次性的，而是一条回路：

计划 → 评审 → 修改 → 执行 → 遇到问题调整计划 → 再评审 → 继续。

人只在两个 AI 互不让步时介入，不做计划审核。

## 2. 目标 / 非目标 / 反目标

### 目标

- **G1 结构变更触发**：只在范围、接口、并发、不可逆操作这类“结构变了”的时候触发，纯实现细节不打扰。
- **G2 Codex 主导**：评审方是 Codex，在可见会话里进行，符合现有“讨论必须可见”的硬规则。
- **G3 可收敛**：结构化 verdict、逐条回应、最大轮数，不变成无限自由对话。
- **G4 死锁交人**：两个 AI 互不让步时发微信，双方理由各 2–3 行，人回编号决定。
- **G5 记录可查**：评审结论、采纳情况、残留风险回写计划文件的 `## Codex review` 一节，并入库。
- **G6 本地模型后续接入**：作为第二意见或 Codex 不可用时的兜底，第一版不实现。

### 非目标

- 不做全自动、无边界的多 Agent 自由对话。
- 不让人逐条批准计划；只有高风险不可逆操作需要人批。
- 不做多用户/团队协作。
- 第一版只做 Claude 执行 → Codex 评审，不做 Codex 执行 → Claude 评审。
- 第一版不接本地模型。
- 不做新的 IDE 或可视化编辑器。

### 反目标（做到了也算失败）

- 评审变成“只夸不挑”的形式主义。
- 同一争议无限循环。
- 死锁时自动替人选一边。
- 评审期间允许执行不可逆操作。
- 评审方直接改计划或代码。
- Codex 不在线时静默跳过评审。

## 3. 约束

- Node.js >= 26，零第三方 npm 依赖。
- 只在 `feat/windows-support` 的扁平布局上改；不碰 `develop`，不引入 `src/`。
- 与 Codex 的讨论必须从任务一开始就可见；新建会话后先用 `scripts/focus-codex-thread.ps1` 打开。
- 当前可见派活工具是 `bridge_spawn*`；Phase B 计划更名为 `bridge_worker_*`，实现时按当时的实际工具名走。
- 微信发送沿用 `scripts/notify-wechat.mjs` → SSH → `hermes send`。
- 微信接收已验证：本机可通过已有 SSH 出站连接执行 `hermes sessions export --only user-prompts --format jsonl --source weixin -`，每行含 `message_id`、`created_at`、`text`。
- 计划文件是 Markdown；现有约定在 `docs/superpowers/plans/`，但设计不写死目录。

## 4. 触发条件

沿用 `CLAUDE.md` 的“大计划”口径，编码为计划文件开头的声明：

```yaml
---
review: required        # required | not-required | approved | provisional | waived
change:
  scope: [api, db]      # api | db | config | auth | module-export
  concurrency: false    # locks | leases | process-lifecycle | async | timeout | cancellation | restart
  irreversible: false   # git-write | data-migration | delete | deploy
  tasks: 6
  files: 7
  reason: "新增 MCP 工具与 decisions 表"
---
```

任一为真即 `review: required`：

- 新增/删除/重命名公共接口：MCP 工具、HTTP 端点、持久化表或字段、鉴权/权限契约、配置格式、模块导出；
- 改变并发所有权：锁、租约、进程生命周期、异步任务、超时、取消、重启恢复；
- 自动执行 git 写操作、数据迁移/删除、部署或其他不可逆操作；
- 计划 ≥ 5 个可独立交付的任务，或预计改 ≥ 5 个产品代码文件；
- 新增模块或目录，或偏离已批准设计中的明确约束；
- 预计 > 2 小时或需要跨会话继续。

纯实现细节（只改函数体、加测试、修文案、局部重命名）不触发。

**声明由执行方填写，桥接层校验字段存在性，不校验真实性。** 真实性由评审方和 Stop hook 兜底：计划文件在声明为 `required` 但未评审时，Stop hook 提醒执行方先评审再结束。

`waived` 只能由人设置，必须同时写 `waived_by`、`waived_at`、`reason`；执行方不能自行豁免。Codex 不在线时，执行方必须停下来告诉人，由人决定是等待、改期还是 `waived`。

### 4.1 强制层（已定）

- **结构变更**：计划声明 + Stop hook 提醒；不做工具级硬拦截，避免误伤正常编辑。Stop hook 发现 `review: required` 但没有数据库里的已批准记录时，阻止本轮结束并提醒先评审。
- **不可逆操作**：PreToolUse / daemon 硬门禁。评审通过前拒绝执行；daemon 侧对 `bridge_*` 发起的 git 写操作做二次校验。
- **高风险不可逆**：删除、数据迁移、部署、force push 即使 Codex 已批准，也要人批；普通 git 写（提交、建分支）Codex 批准即可。

## 5. 角色

- **执行方（v1 仅 Claude）**：写计划、填声明、发起评审、逐条回应、按结论修改计划；结构变更未通过前不动代码。
- **评审方（Codex）**：全新可见会话，只读；任务是“找出这份计划会失败的理由”，不是确认它可行。
- **第二意见（本地模型，后续）**：OpenAI 兼容接口；只对争议项或非阻塞项给意见；Codex 离线时作兜底，结论标 `provisional`。
- **人**：不是评审者；死锁时做二选一；高风险不可逆操作必须人批。

## 6. 回路

1. 执行方新建或修改计划文件，填写 `review` 声明。
2. 若 `review: required`，调用 `bridge_plan_review`（新工具，名称待定），传：计划路径、声明、项目根、变更摘要、相关文件/当前 diff。
3. 桥接层在评审开始时**冻结计划文本**并计算 `plan_hash`，创建可见 Codex 评审会话（`tier: review`，只读），立即返回 `reviewId`；用 focus 脚本打开会话。评审方读冻结快照，不读实时文件。
4. 评审方返回结构化 verdict：

```json
{
  "verdict": "approve | changes-required | discuss",
  "summary": "一句话结论",
  "issues": [
    {
      "id": "R1",
      "severity": "blocker | major | minor",
      "location": "§4.2 或 文件:行",
      "problem": "具体问题",
      "why": "为什么会在实现中出事",
      "suggestion": "可执行的修改建议"
    }
  ],
  "questions": ["需要执行方回答的问题"]
}
```

5. 执行方通过 `bridge_plan_review_respond`（形状待定）逐条回应：`accept` / `reject` + 证据 + 计划改动；`blocker`/`major` 必须全部回应，`minor` 可记录。
6. 下一轮在同一可见 Codex 线程里只评审未解决的 `blocker`/`major` 和被改动的段落；最多 3 轮（按 review 计，不按单次调用计）。
7. 通过后，把 verdict、issues、逐条回应、残留风险、评审模型/强度/耗时写入计划文件 `## Codex review`，声明改为 `review: approved`。**权威记录是数据库的 `plan_reviews` + `plan_hash` 快照**；文件里的声明只是人可读镜像，Stop hook 必须与数据库交叉校验，不能只信文件。
8. 死锁（3 轮后仍有未解决 blocker，或双方对同一 blocker 结论相反）→ 创建 decision → 发微信 → 等人。
9. 人回复后，按选择继续；决定写回计划和数据库。
9a. 若计划包含高风险不可逆操作（删除、数据迁移、部署、force push），即使 Codex 已批准，也创建 `approval` decision 发微信；人批准前硬门禁不放行。
10. 超时（默认 30 分钟）未回复 → **不替任何一方选边**：受影响的实现原地暂停（标记 `decision: timed-out`），不执行不可逆操作；发一条提醒。不受影响的工作可以继续；人回来后恢复。

**执行中的结构变更**：执行方遇到新问题需要改计划时，先更新计划文件并重新声明；若仍为 `required`，暂停受影响的实现，走第 2 步；通过后再继续。

## 7. 评审协议

- 评审方只读，不能改计划或代码；不能自行执行命令修改工作区。
- 每条问题必须引用计划段落或文件位置，禁止“建议再考虑一下”这类空话。
- `blocker` = 不解决就不能写代码；`major` = 写代码前应解决；`minor` = 记录即可。
- `approve` 的前提是没有未解决的 `blocker`/`major`。
- 每轮预算：最多 10 分钟；最多 3 轮；每轮 token/USD 上限可配。
- 评审方输入必须包含：计划全文、声明、项目根、计划点名的相关文件、当前 diff、项目 `CLAUDE.md`/`AGENTS.md` 约束、上一轮结论与回应。
- 评审模型：结构评审用当前可用的最高档 + 高推理强度；优先跨厂商（Claude 执行 → Codex 评审）。不改全局 Codex 配置，只对本次评审会话指定 model/effort。
- 可见性：从评审开始就使用可见 Codex 会话，不用后台 `codex exec`。

## 8. 微信决策通道

### 发送

有两种 decision：

- `deadlock`：双方互不让步，人选 A/B。
- `approval`：高风险不可逆操作，人选“批准/拒绝”；即使 Codex 已批准，也必须过人这一关。

死锁正文：

```
[SYBIL D-7f3a] 计划评审卡住
争议：decisions 表是否需要 expires_at
A（Codex）：<2-3 行理由>
B（执行方）：<2-3 行理由>
建议：A
回复：SYBIL D-7f3a 1 或 2
```

高风险不可逆正文：

```
[SYBIL A-7f3a] 不可逆操作待批准
操作：删除 decisions 表并迁移数据
理由：<2-3 行>
风险：<2-3 行>
回复：SYBIL A-7f3a 1 批准 / 2 拒绝
```

通过现有 `scripts/notify-wechat.mjs` 发送。

### 接收

本机轮询云服务器：

```
hermes sessions export --only user-prompts --format jsonl --source weixin --chat-id "<bound chat_id>" -
```

- `--only user-prompts` 的输出不含 `chat_id`，所以必须在服务端用 `--chat-id` 预过滤；已验证错误 chat-id 返回空。
- 记住上次处理的 `message_id`，只处理更新的行；
- 匹配 `SYBIL <id> <choice>`；
- 只接受绑定微信 `chat_id` 的回复；其他来源忽略；
- 轮询间隔 5–10 秒；30 分钟超时；过半时间发一次提醒；
- decision 一次性，回答后失效。

### 与小云的隔离

Hermes 会把回复当成对小云说的话并跑一轮 agent。需要给 Hermes 加一条规则或 skill：`SYBIL` 开头的消息只回复“已记录”，不执行其他动作。这一步是云端配置，作为接入前置条件。

## 9. 数据与持久化

SQLite 新增：

- `plan_reviews(id, project_id, plan_path, plan_hash, plan_snapshot, status, declaration_json, reviewer_tool, reviewer_model, reviewer_effort, round, max_rounds, created_at, updated_at, approved_at, waived_by, waived_at, waive_reason)`
- `review_rounds(id, review_id, round, verdict, summary, issues_json, response_json, started_at, ended_at, stop_reason)`
- `decisions(id, review_id, kind, code, question, option_a, option_b, reason_a, reason_b, recommendation, status, created_at, expires_at, answered_at, choice, source_message_id)`，`kind` 为 `deadlock | approval`
- `settings` 增加 `wechat.poll_state`（最后处理的 `message_id`）。

计划文件的 `## Codex review` 是人可读记录；数据库是运行台/查询来源。`plan_hash` 用于判断评审后计划是否又改了；若改了且仍为结构变更，必须重新评审。

## 10. 与现有 Phase B 的关系

- 评审是只读的，不需要 worktree 或路径租约。
- 新增独立 `review` tier：有自己的 `maxLivePerSession`/`maxLivePerProject` 和轮数/时长/USD 预算，不占 consult 的 12 次/10 分钟，也不参与 consult 的精确去重；避免被日常核对挤掉，也避免评审被误判为重复核对。
- 评审期间如果工作方正在跑，评审方不改工作树；执行方在结构变更通过前不得合并或执行不可逆操作。
- `bridge_plan_review` 立即返回 `reviewId`；`bridge_plan_review_result` 取结论。执行方在等待期间只能做不受影响的工作。
- 评审及其 decision 轮询由 **daemon** 持有，不绑在执行方 MCP 进程或聊天上；执行方会话结束、空闲或 daemon 重启后，评审和待决 decision 从 SQLite 恢复。
- 有待决 decision 的评审 worker 不参与 orphan 清理；只有人回答、人显式取消，或超时后确认受影响工作继续暂停，才释放。

## 11. 本地模型（后续阶段，第一版不实现）

- **角色**：对争议项或非阻塞项给第二意见；Codex 不可用时的离线兜底。
- **接口**：OpenAI 兼容 `/v1/chat/completions`（Ollama / LM Studio / llama.cpp server 都可），配置 `localReviewer.baseUrl`、`model`、可选 `apiKey`。
- **输入**：计划相关段落 + Codex verdict + 争议项，不喂整个仓库。
- **输出**：同一套 verdict schema，附加 `reviewer: "local"`、`provisional: true`。
- **规则**：第一版不允许本地模型单独批准；Codex 离线时它只能给 `provisional`，计划标记 `review: provisional`，并通知人；Codex 恢复后重新评审。
- **实现约束**：用 Node 内置 `fetch`，不新增依赖。
- **接口先留**：`reviewer` 抽象出 `review(plan, context) -> verdict`，Codex 与本地模型各实现一个。

## 12. 未决问题（交给 builder）

- 工具名：新增 `bridge_plan_review` / `bridge_plan_review_result` / `bridge_plan_review_respond`，还是复用 `bridge_worker_*` + 约定 prompt。
- 计划文件发现规则：固定 `docs/superpowers/plans/*.md`，还是任意 `*.plan.md` / 声明头。
- `plan_hash` 的规范化方式（去空白、忽略时间戳、是否包含 frontmatter）。
- Stop hook 与 PreToolUse 硬门禁的具体实现层（待你拍板后定）。
- Hermes 的 `SYBIL` 规则用 skill 还是 hook 实现。
- review 预算的具体数字（轮数、时长、USD、并发）。
- 运行台展示位置：复用“运行台”还是新增“评审”区块。

## 12.1 已定（2026-11-08）

- **v1 范围**：只支持“Claude 执行 → Codex 评审”；“Codex 执行 → Claude 评审”留到后续。
- **强制程度**：混合。结构变更用声明 + Stop hook 提醒；不可逆操作用 PreToolUse/daemon 硬门禁。
- **不可逆审批**：高风险项（删除、数据迁移、部署、force push）即使 Codex 批准也要人批；普通 git 写（提交、建分支）Codex 批准即可。

## 13. 验收标准

- 结构变更的计划会触发可见 Codex 评审，且在评审通过前不写代码。
- 非结构变更不触发。
- 评审返回结构化 verdict；执行方逐条回应；最多 3 轮。
- 通过后计划文件出现 `## Codex review`，声明为 `review: approved`。
- 死锁会发微信，正文含双方理由各 2–3 行；回复 `SYBIL <id> <choice>` 能恢复；超时走安全默认。
- Codex 不在线时不会静默跳过；会告诉人（本地模型接入后走 provisional）。
- 评审方全程只读，不能改计划或代码。
- v1 只接受 Claude 执行方的评审请求；Codex 执行的计划不进入本回路。
- 结构变更未评审时 Stop hook 会提醒；不可逆操作在评审/人批通过前被硬门禁拒绝。
- 高风险不可逆操作即使 Codex 批准，也会发微信等人批；普通 git 写不需要人批。
- 自动测试覆盖：触发判定、声明校验、verdict 解析、逐条回应、轮数上限、decision 轮询/匹配/超时、硬门禁拒绝/放行；真实 Codex 会话做一次人工验收。
