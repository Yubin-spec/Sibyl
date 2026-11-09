---
review: approved
change:
  scope: [model-policy, plan-review, tests, docs]
  tasks: 4
  files: 4
  irreversible: false
  concurrency: false
---

# 评审模型统一到 Astra + ultra

## 目标

把「调用 Codex 做评审」的默认模型统一提到最高档 `gpt-6-astra` + `ultra`，覆盖两条评审链路：

1. 计划评审（`bridge_plan_review`）。
2. 普通 consult / review 类 worker（`bridge_worker_start` 的 `kind:"review"`，含 `risk:"normal"` 与 `risk:"high"`）。

非评审档位保持不变：`mechanical`、`implement`、`frontier` 都不动。

## 已核实的事实

- `scripts/spawn-codex-chat.mjs` 接受 `--effort ultra`，并把它写入 Codex 配置 `model_reasoning_effort` 和 `turn/start.effort`；没有枚举拦截。
- `~/.codex/models_cache.json` 中 `gpt-6-astra` 的 `supported_reasoning_levels` 明确包含 `ultra`（描述为 “Maximum reasoning with automatic task delegation”）。
- 同一缓存显示 `gpt-6-luna` / `gpt-5.6-luna` 只支持到 `max`，不支持 `ultra`；模型与 effort 的单字段覆盖可能组合出无效配置。
- 当前计划评审的 `reviewerModel` 是 `'auto'`，传入 worker 后走默认路由表 `review + high`，实际是 `gpt-6.1-sol` / `high`；只有最后一轮用 `reviewerFinalModel: 'gpt-6-astra'`。
- 计划评审 worker 仍显式传 `useProjectPolicy: false`，不受 `.sibyl/models.json` 影响。

## 改动

### 1. `model-policy.mjs`

`DEFAULT_CODEX_POLICY.review`：

- `normal`: `gpt-6-astra` / `ultra`（原 `gpt-6.1-terra` / `medium`）
- `high`: `gpt-6-astra` / `ultra`（原 `gpt-6.1-sol` / `high`）

`implement`、`mechanical`、`frontier` 保持不变。项目 `.sibyl/models.json` 仍可覆盖 review 叶子，优先级与报错语义不变。

新增已知模型的 effort 能力校验：Luna 系列（`gpt-6-luna`、`gpt-5.6-luna`）不支持 `ultra`。项目只写 `model:'gpt-6-luna'` 时会继承新的 `ultra`，必须在加载时直接报错，提示同时指定兼容的 `effort`（例如 `high`），不静默降级。校验只针对已知模型；未知模型仍交给 Codex 运行时拒绝。

### 2. `plan-review-policy.mjs`

`DEFAULT_PLAN_REVIEW`：

- `reviewerModel`: `'gpt-6-astra'`（原 `'auto'`）
- `reviewerEffort`: `'ultra'`（原 `'high'`）
- `reviewerFinalModel` 已是 `'gpt-6-astra'`，不变。

计划评审仍显式使用该模型与 effort，不读项目路由表。

`normalizeReviewConfig` 对 `reviewerModel` 与 `reviewerFinalModel` 分别做同一套 effort 能力校验（跳过 `auto`）：已知模型不支持 `ultra` 时直接报错，要求同时设置兼容的 `reviewerEffort`。

### 3. 测试

- `model-policy.test.mjs`：
  - review 两个叶子与默认表回放的期望改成 `gpt-6-astra` / `ultra`；新增一条「默认 review 选择 Astra + ultra」的显式测试。
  - 更新 tier 推导期望：`consult` 默认改为 Astra。
  - 更新项目覆盖测试中 review 叶子的期望。
  - effort-only 覆盖用例改用与新默认不同的 `effort:'high'`（原 `'ultra'` 会与默认相同，`project:` 前缀断言会失效）；补一条「覆盖值等于默认值时不带 `project:` 前缀」。
  - 新增能力校验用例：只写 `model:'gpt-6-luna'` 报错；`model:'gpt-6-luna'` + `effort:'high'` 通过。
- `worker-service.test.mjs`：`start records the auto-selected model and effort`、`explicit effort wins...`、两个 `useProjectPolicy false` 用例的 review 期望改成 Astra / ultra；显式模型用例保持显式值不变。
- `plan-review.test.mjs`：默认评审 worker 的 `input.model` 从 `'auto'` 改为 `'gpt-6-astra'`，`input.effort` 从 `'high'` 改为 `'ultra'`；最后一轮模型断言保持 `gpt-6-astra`。现有 `reviewerModel: 'gpt-6-luna'` 用例必须同时传 `reviewerEffort: 'high'`，否则会被新校验拒绝。
- `plan-review-policy.test.mjs`：新增默认配置断言（Astra + ultra），以及不兼容的 reviewer 模型/effort 组合报错、兼容组合通过。

### 4. 文档

- `使用说明.md`：默认模型表更新为 `review (normal/high) → gpt-6-astra / ultra`，补成本说明与降档写法：降档必须同时写 `model` 和兼容的 `effort`（例如 `gpt-6-luna` + `high`），只写模型会因继承 `ultra` 而报错。
- `skills/agents-calling/SKILL.md`：同样更新模型选择清单，并说明评审档默认最贵、只在评审使用；降档时模型与 effort 成对指定。
- `README.md` 不写具体模型，不需要改。
- 历史计划文档（`docs/superpowers/plans/2026-11-08-*`、`2026-11-09-*`）是当时记录，不回写。

## 成本与风险

- Astra + ultra 明显更贵、更慢，且 `ultra` 会启用自动任务分派；只用于评审，不扩大到 implement / mechanical。
- 计划评审与普通 review worker 都会变慢；现有超时（`turnMs` 10 分钟、worker `--timeout-ms` 600000）保持不变，先观察是否触顶。
- 项目仍可用 `.sibyl/models.json` 把 review 降档，但必须同时指定兼容的 `effort`；旧配置只写 `model:'gpt-6-luna'` 会在加载时报错，而不是带着无效的 `ultra` 启动。这是有意的升级要求，文档给出成对示例。

## 验收

- 默认 `chooseCodexModel({kind:'review'})` 与 `risk:'high'` 都返回 `gpt-6-astra` / `ultra`。
- 默认 `normalizeReviewConfig()` 返回 `reviewerModel: 'gpt-6-astra'`、`reviewerEffort: 'ultra'`。
- 已知不支持 `ultra` 的模型与 `ultra` 的单字段覆盖会在配置加载时报错；显式成对指定兼容 `effort` 可通过。
- 一次真实 worker 启动参数包含 `--model gpt-6-astra --effort ultra`（用测试或真实运行记录证明）。
- 全量测试 0 fail。
- `使用说明.md` 与 `SKILL.md` 的模型表与代码一致。

## 不做

- 不改 implement / mechanical / frontier 的默认。
- 不改 spawner、超时、并发所有权、持久化结构或 MCP 工具签名。
- 不回写历史计划文档中的旧模型表。

## Review Focus

- F1: review 两个风险档都提到 Astra + ultra 后，是否会影响非 review 任务或显式模型路径。
- F2: 计划评审 `reviewerModel` 从 `'auto'` 改为显式 `'gpt-6-astra'` 是否破坏既有保护或配置覆盖语义。
- F3: 测试断言是否有遗漏（尤其 worker-service / plan-review 之外）。
- F4: 文档是否还有活跃页面写死旧模型。

<!-- SIBYL_REVIEW_BEGIN -->
## Codex review

- 状态：approved
- 结论：完整复审通过。R1 已补齐默认继承、tier 推导、effort-only 和 project: 原因字段的测试安排；R2 已明确项目 review、reviewerModel、reviewerFinalModel 三条路径的兼容策略：拒绝已知不支持的组合，并提供成对配置的迁移说明。F1/F2 未发现非评审默认值、显式模型路径或项目策略隔离被破坏；F3/F4 的测试与活跃文档范围充分。实施时须保留显式 effort 覆盖，并落实验收中的 Astra / ultra 启动参数断言。此结论批准计划，不代表实现及全量测试已通过。
- 评审模型：codex
- 轮次：2
- 采纳：R1, R2
- 残留风险：
<!-- SIBYL_REVIEW_END -->
