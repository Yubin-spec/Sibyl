/**
 * 桌面 UI 控制器。
 *
 * 职责：渲染本机状态、管理项目/会话/核对/配对表单、消费 SSE 增量事件。
 * 所有真实 AI 调用都在后台控制面完成；前端只发 API 请求和展示结果。
 * 这里保留状态签名去重，避免 SSE 每次全量状态都导致 DOM 重绘。
 */
"use strict";

/**
 * 按 id 取 DOM 节点。
 *
 * 页面里所有绑定都基于固定 id；抽成 $ 是为了让渲染函数保持短，并且避免重复写
 * document.getElementById。
 */
const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="bridge-session"]').content;
const names = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  deepseek: "DeepSeek Harness",
};
const labels = {
  running: "正在处理",
  processing: "正在处理",
  queued: "排队等待工具",
  delivered: "已送达桥接，等待工具处理",
  completed: "回复已返回",
  failed: "执行失败",
  cancelled: "已暂停",
  stopped: "已暂停",
  stalled: "无进展已停止",
  timeout: "超时已停止",
  interrupted: "后台重启已中断",
  idle: "等待人工指令",
  "waiting-inbox": "等待目标原生会话提取",
  archived: "已归档",
  online: "在线",
  offline: "离线",
  unknown: "状态未知",
  pending: "等待确认",
};
let state = {
  projects: [],
  sessions: [],
  conversations: [],
  connections: [],
  operations: [],
  bindings: [],
  consultations: [],
  attention: [],
  consultLimits: {},
  agents: {},
  standaloneAgents: {},
  desktopApps: {},
};
let selected = "",
  page = "conversations",
  offset = 0,
  total = 0,
  messageRequest = 0,
  initial = true,
  pairedIds = new Set(),
  wantedPair = false;
let catalog = null,
  catalogKey = "",
  catalogLoading = false,
  preferencesSent = "",
  reconnectDelay = 800;
const signatures = new Map(),
  outputs = new Map(),
  messageIds = new Set();

/**
 * 创建 DOM 节点。
 *
 * 统一走 textContent，不拼 innerHTML，避免模型输出或项目名被当成 HTML 执行。
 * text 可选，cls 用于复用现有 CSS 样式。
 */
function node(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = String(text);
  if (cls) e.className = cls;
  return e;
}

/**
 * 显示顶部提示条。
 *
 * 提示只占领 notice 区域，不打断当前表单；用户点关闭即可隐藏。
 */
function notice(message) {
  $("notice").hidden = false;
  $("notice").querySelector("span").textContent = message;
}
$("dismissNotice").onclick = () => {
  $("notice").hidden = true;
};

/**
 * 调用本机控制面的 JSON API。
 *
 * - GET：data 为 undefined；
 * - POST：data 为对象，自动 JSON 序列化；
 * - 所有请求都带 x-bridge-ui CSRF 头；
 * - 响应必须是 JSON，非 2xx 时把后台 error 原样抛给调用方。
 * signal 用于取消正在进行的请求。
 */
async function api(path, data, signal) {
  const r = await fetch("/api/" + path, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      "x-bridge-ui": token,
      ...(data === undefined ? {} : { "content-type": "application/json" }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal,
  });
  let v;
  try {
    v = await r.json();
  } catch {
    throw Error("后台响应格式无效（" + r.status + "）");
  }
  if (!r.ok) throw Error(v.error || "请求失败（" + r.status + "）");
  return v;
}

/**
 * 执行一个按钮动作并统一处理反馈。
 *
 * 作用：
 * 1. 防止同一个按钮被重复点击；
 * 2. 执行期间禁用按钮；
 * 3. 成功时显示提示；
 * 4. 失败时把错误消息显示在 notice，而不是抛到控制台；
 * 5. 无论成功失败都刷新当前会话操作区。
 */
async function action(button, fn, success) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    const result = await fn();
    if (result?.state) applyState(result.state);
    if (success) notice(success);
    return result;
  } catch (e) {
    notice(e.message);
    return undefined;
  } finally {
    if (button) button.disabled = false;
    updateConversation();
  }
}

/**
 * 按状态签名决定是否重绘。
 *
 * SSE 会频繁推送全量状态；如果每次直接重绘，DOM 会闪烁且输入框可能失焦。
 * 这里把 value 序列化成签名，只有内容变化时才执行 draw。
 */
function changed(key, value, draw) {
  const s = JSON.stringify(value);
  if (signatures.get(key) === s) return;
  signatures.set(key, s);
  draw();
}

/**
 * 更新一个 select 的选项。
 *
 * entries 是 [value, text] 列表；为空时显示 empty 占位项。
 * 更新后尽量保留原来的选中值，避免自动刷新把用户选择重置。
 */
function options(id, entries, empty = "暂无可选项") {
  const e = $(id),
    old = e.value;
  changed("options:" + id, entries, () => {
    e.replaceChildren(
      ...(entries.length ? entries : [["", empty]]).map(
        ([value, text]) => new Option(text, value),
      ),
    );
    if (entries.some(([v]) => v === old)) e.value = old;
  });
}

/**
 * 创建一个绑定动作的按钮。
 *
 * 按钮统一走 action()，因此自动具备防重复点击和错误提示。
 */
function button(text, fn, cls) {
  const b = node("button", text, cls);
  b.type = "button";
  b.onclick = () => action(b, fn);
  return b;
}

/**
 * 创建一个卡片容器。
 *
 * 卡片是项目、连接、核对记录等列表项的通用外观。
 */
function card(title, detail) {
  const e = node("section", undefined, "card");
  e.append(node("h3", title), node("p", detail));
  return e;
}

/**
 * 把项目 ID 转成用户可读名称。
 *
 * 找不到时返回“未绑定项目”，避免界面出现空白或裸 UUID。
 */
function projectName(id) {
  return state.projects.find((p) => p.id === id)?.name || "未绑定项目";
}

/**
 * 取会话的本机工具。
 *
 * 新数据直接带 localAgent；旧数据只能通过 localSessionId 查 sessions。
 */
function localAgent(c) {
  return (
    c?.localAgent ||
    state.sessions.find((s) => s.id === c?.localSessionId)?.tool
  );
}

/**
 * 把工具 ID 转成展示名称。
 *
 * 未知 ID 原样显示，便于排查新接入的工具。
 */
function agentName(id) {
  return names[id] || id || "未选择工具";
}

/**
 * 把后台状态码转成中文。
 *
 * 未知状态原样返回，避免吞掉后台新增的状态。
 */
function statusText(s) {
  return labels[s] || s || "等待人工指令";
}
const stopLabels = {
  done: "已完成",
  timeout: "超时停止",
  idle: "空闲停止",
  budget: "预算用尽",
  duplicate: "重复停止",
  loop_suspected: "疑似死循环",
  human_stop: "人工停止",
  permission: "权限拒绝",
  error: "执行出错",
};

/**
 * 生成 channel 模式的用量摘要。
 *
 * 只有 channel 模式才显示消息数、双方轮次和停止原因；
 * 这些数字帮助用户判断是否快到预算上限。
 */
function channelSummary(c) {
  if (c?.mode !== "channel") return "";
  const u = c.usage || {},
    t = u.turns || {},
    l = c.limits || {};
  return (
    " · 消息 " +
    (u.messages || 0) +
    "/" +
    (l.maxMessages || 20) +
    " · 本机 " +
    (t.local || 0) +
    "/" +
    (l.maxTurnsPerAgent || 8) +
    " · 对方 " +
    (t.remote || 0) +
    "/" +
    (l.maxTurnsPerAgent || 8) +
    (c.stopReason ? " · " + (stopLabels[c.stopReason] || c.stopReason) : "")
  );
}

/**
 * 把窗口偏好同步给 macOS 外壳。
 *
 * 只有 closeToTray 变化时才 postMessage，避免每次状态刷新都打扰原生层。
 */
function nativePreferences() {
  const p = {
    action: "preferences",
    closeToTray: !!state.settings?.closeToTray,
  };
  if (JSON.stringify(p) !== preferencesSent) {
    window.webkit?.messageHandlers?.bridge?.postMessage(p);
    preferencesSent = JSON.stringify(p);
  }
}

/**
 * 切换左侧页面。
 *
 * 页面由 page-<name> 的 DOM 节点决定；不存在的页面回退到 conversations。
 * save=true 时把当前页面写进设置，下次打开恢复到同一页。
 */
function showPage(next, save = true) {
  if (!document.getElementById("page-" + next)) next = "conversations";
  page = next;
  document
    .querySelectorAll(".page")
    .forEach((e) => (e.hidden = e.id !== "page-" + next));
  document.querySelectorAll("[data-page]").forEach((e) => {
    e.classList.toggle("active", e.dataset.page === next);
    e.setAttribute("aria-current", e.dataset.page === next ? "page" : "false");
  });
  if (save) api("settings", { page: next }).catch((e) => notice(e.message));
}
document
  .querySelectorAll("[data-page]")
  .forEach((b) => (b.onclick = () => showPage(b.dataset.page)));

/**
 * 刷新快速核对入口。
 *
 * 自动保证“发起 AI”和“目标 AI”不是同一个工具，并根据项目/工具数量给出缺失提示。
 * 条件不满足时直接禁用提交按钮，避免用户点了才报错。
 */
function renderQuickStart() {
  // 快速核对默认选两个不同工具；只有一个工具时不强行改目标。
  const agents = Object.keys(state.agents || {}),
    source = $("quickLocalAgent").value,
    target = $("quickRemoteAgent").value;
  if (agents.length > 1 && (!target || target === source)) {
    const next = agents.find((a) => a !== source);
    if (next) $("quickRemoteAgent").value = next;
  }

  // 缺失原因按优先级显示：没有项目 > 工具不足 > 正在检测。
  const missing = !state.projects.length
    ? "先添加一个项目。"
    : agents.length < 2
      ? state.toolsLoading
        ? "正在检测本机 AI…"
        : "至少需要两个已检测到的本机 AI。"
      : "";
  $("quickHint").textContent =
    missing || "本机核对不需要配对。需要跨电脑时使用左侧“高级”。";
  $("quickSubmit").disabled = !!missing;
}

/**
 * 渲染桥接总览。
 *
 * 总览只回答三个问题：
 * 1. 本机检测到哪些 AI；
 * 2. 哪些项目已经绑定到目标工具；
 * 3. 当前有哪些原会话在线登记。
 */
function renderBridgeOverview() {
  const detected = Object.keys(state.agents || {}).map(agentName),
    bindings = state.bindings || [],
    sessions = state.nativeSessions || [];
  const lines = [
    state.toolsLoading
      ? "正在检测本机 AI…"
      : detected.length
        ? "已检测本机 AI：" + detected.join("、") + "。"
        : "未检测到可用的本机 AI。",
    bindings.length
      ? "已保存跨工具项目定位：" +
        bindings
          .map(
            (b) =>
              projectName(b.sourceProjectId) +
              " → " +
              agentName(b.targetTool) +
              " / " +
              projectName(b.targetProjectId),
          )
          .join("；")
      : "还没有跨工具项目定位；配置 MCP 时选择“目标工具 + 目标项目”，Agent 才知道该找哪个仓库。",
    sessions.length
      ? "当前在线登记的原会话：" +
        sessions
          .map((s) => agentName(s.tool) + " · " + (s.title || "未命名"))
          .join("；")
      : "还没有原会话登记；在工具会话中调用 bridge_open_session 后，才能定向收发。",
  ];
  changed(
    "bridgeOverview",
    { detected, bindings, sessions, toolsLoading: state.toolsLoading },
    () => {
      $("bridgeStatus").replaceChildren(
        ...lines.map((text) => node("div", text, "bridge-status-line")),
      );
    },
  );
}

/**
 * 把后台状态合并进 UI 并触发各区域重绘。
 *
 * 这是前端唯一的状态入口：
 * - 先合并并修正数组字段，防止旧后台返回缺字段；
 * - 发现新配对连接时自动切换目标并刷新目录；
 * - 同步所有 select 的选项；
 * - 首次加载时恢复页面、项目和设置表单；
 * - 最后按区域调用 render*，每个区域自己用签名去重。
 */
function applyState(next) {
  if (!next || typeof next !== "object") return;
  state = { ...state, ...next };
  for (const key of [
    "projects",
    "sessions",
    "conversations",
    "connections",
    "operations",
    "bindings",
    "consultations",
    "attention",
  ])
    if (!Array.isArray(state[key])) state[key] = [];

  // 第一次看到新连接时自动选中它，并提示配对成功。
  const added = state.connections.filter((c) => !pairedIds.has(c.id));
  if (!initial && added.length) {
    const c = added.at(-1);
    options("connection", [
      ["local", "本机 · 不需要配对"],
      ...state.connections.map((c) => [c.id, c.name || c.url]),
    ]);
    $("connection").value = c.id;
    catalogKey = "";
    loadCatalog();
    if (wantedPair) {
      notice("配对已确认：" + (c.name || c.url));
      wantedPair = false;
    }
  }
  pairedIds = new Set(state.connections.map((c) => c.id));
  $("deviceName").textContent = [
    state.device?.owner,
    state.device?.name || state.name || "本机电脑",
  ]
    .filter(Boolean)
    .join(" / ");

  // 所有需要项目下拉框的地方共用同一份项目选项。
  const projectEntries = state.projects.map((p) => [p.id, p.name]);
  options("projectFilter", [["", "全部项目"], ...projectEntries]);
  for (const id of [
    "quickProject",
    "newProject",
    "nativeProject",
    "diagnosticProject",
  ])
    options(id, projectEntries, "请先添加项目");
  for (const id of ["hostProject", "pairProject"])
    options(id, [["", "不指定项目"], ...projectEntries]);
  options("connection", [
    ["local", "本机 · 不需要配对"],
    ...state.connections.map((c) => [c.id, c.name || c.url]),
  ]);
  for (const id of [
    "localAgent",
    "quickLocalAgent",
    "quickRemoteAgent",
  ])
    options(
      id,
      Object.keys(state.agents || {}).map((a) => [a, agentName(a)]),
    );
  options("nativeTargetTool", [
    ["", "不配置"],
    ...Object.keys(names).map((a) => [a, agentName(a)]),
  ]);
  options("nativeTargetProject", [["", "不配置"], ...projectEntries]);

  // 首次加载只恢复一次表单和页面，后续状态刷新不能覆盖用户正在输入的内容。
  if (initial) {
    showPage(state.settings?.page || "conversations", false);
    if (state.settings?.selectedProjectId) {
      $("projectFilter").value = state.settings.selectedProjectId;
      $("quickProject").value = state.settings.selectedProjectId;
    }
    $("settingsName").value = state.device?.name || state.name || "";
    $("settingsOwner").value = state.device?.owner || "";
    $("pairName").value = state.device?.name || state.name || "";
    $("closeToTray").checked = !!state.settings?.closeToTray;
    $("autoStartHost").checked = !!state.settings?.autoStartHost;
    $("networkPort").value = state.settings?.networkPort || 47831;
    initial = false;
  }
  nativePreferences();
  renderQuickStart();
  renderTopics();
  renderActivity();
  renderComputers();
  renderTools();
  renderBindings();
  renderProjects();
  renderNative();
  renderTarget();
  updateConversation();
}

/**
 * 渲染左侧会话列表。
 *
 * 按项目、搜索词、归档状态和本机/跨电脑范围过滤；
 * 选中的会话加 selected 样式，点击后加载消息。
 */
function renderTopics() {
  const q = $("search").value.toLowerCase(),
    p = $("projectFilter").value,
    scope = $("scopeFilter").value;
  const list = state.conversations.filter(
    (c) =>
      (!p || c.projectId === p) &&
      (!q || (c.title || "").toLowerCase().includes(q)) &&
      ($("showArchived").checked || !(c.archived || c.status === "archived")) &&
      (!scope ||
        (scope === "local"
          ? c.connectionId === "local"
          : c.connectionId !== "local")),
  );

  // 列表内容或选中项变化时才重绘，避免每次 SSE 都重建所有按钮。
  changed("topics", [list, selected], () => {
    $("topicList").replaceChildren();
    for (const c of list) {
      const b = node(
        "button",
        undefined,
        "topic" + (selected === c.id ? " selected" : ""),
      );
      b.append(
        node("strong", c.title || "未命名核对"),
        node(
          "small",
          projectName(c.projectId) +
            " · " +
            (incoming(c) ? "对方发起 · " : "") +
            (c.connectionId === "local" ? "本机" : "跨电脑"),
        ),
        node(
          "small",
          agentName(localAgent(c)) +
            " ↔ " +
            agentName(c.remoteAgent) +
            " · " +
            statusText(c.status),
        ),
      );
      b.onclick = () => selectConversation(c.id);
      $("topicList").append(b);
    }
    if (!list.length)
      $("topicList").append(
        node("p", "还没有核对记录。右侧开始第一次跨工具核对。"),
      );
  });
}
for (const id of ["search", "projectFilter", "scopeFilter", "showArchived"])
  $(id).addEventListener(id === "search" ? "input" : "change", () => {
    renderTopics();
    if (id === "projectFilter")
      api("settings", { selectedProjectId: $(id).value }).catch((e) =>
        notice(e.message),
      );
  });

/**
 * 把毫秒格式化成“秒/分秒”。
 *
 * 用于核对记录里的已运行时间和最近进展时间。
 */
function elapsed(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 60000) return Math.round(n / 1000) + " 秒";
  return (
    Math.floor(n / 60000) +
    " 分 " +
    (Math.round((n % 60000) / 1000) || 0) +
    " 秒"
  );
}

/**
 * 把核对路由模式转成中文。
 *
 * binding=项目绑定，explicit=显式指定，其它=当前项目。
 */
function routeMode(record) {
  return record.route?.mode === "binding"
    ? "项目绑定"
    : record.route?.mode === "explicit"
      ? "显式指定"
      : "当前项目";
}

/**
 * 创建一个指标卡片。
 *
 * 用于运行台顶部的 Worker 数量、完成数、待处理数等。
 */
function metric(label, value, note) {
  const e = node("section", undefined, "metric");
  e.append(
    node("small", label),
    node("strong", String(value)),
    node("span", note || ""),
  );
  return e;
}

/**
 * 渲染“待你处理”焦点卡。
 *
 * 一次只显示最靠前的一项，避免用户面对一屏待办。
 * 根据 kind 提供不同动作：同意/拒绝配对、查看核对、打开会话或稍后处理。
 */
function renderAttention() {
  const list = state.attention || [],
    badge = $("attentionBadge");

  // 角标显示待处理总数，超过 99 用 99+，并同步 aria-label。
  if (badge) {
    badge.hidden = !list.length;
    badge.textContent = list.length > 99 ? "99+" : String(list.length);
    badge.setAttribute("aria-label", list.length + " 项待处理");
  }
  changed("attention", list, () => {
    const box = $("attention");
    if (!box) return;
    box.replaceChildren();
    if (!list.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;

    // 一次只展示最靠前的一项；完成或稍后处理后自然轮到下一项。
    const item = list[0],
      e = node("section", undefined, "focus-card");
    e.append(
      node("div", "待你处理", "focus-eyebrow"),
      node("h2", item.title || "需要你处理"),
      node("p", item.detail || ""),
    );
    const actions = node("div", undefined, "focus-actions");
    if (item.kind === "pair") {
      actions.append(
        button(
          "同意配对",
          () => api("host/approve", { id: item.pairId, accept: true }),
          "primary",
        ),
        button("拒绝", () =>
          api("host/approve", { id: item.pairId, accept: false }),
        ),
      );
    } else if (item.kind === "consult") {
      actions.append(
        button("查看记录", () => {
          document
            .getElementById("consult-" + item.consultId)
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
        }),
      );
    } else if (item.kind === "conversation") {
      actions.append(
        button("打开会话", () => {
          showPage("conversations");
          selectConversation(item.conversationId);
        }),
      );
    }
    if (item.dismissible)
      actions.append(
        button("稍后处理", () => api("attention/dismiss", { id: item.key })),
      );
    e.append(actions);
    if (list.length > 1)
      e.append(
        node(
          "small",
          "还有 " + (list.length - 1) + " 项；完成当前一项后显示下一项。",
          "focus-more",
        ),
      );
    box.append(e);
  });
}

/**
 * 渲染运行台。
 *
 * 包含四块：
 * 1. 顶部指标；
 * 2. 路由规则和已保存绑定；
 * 3. 防循环/并发/超时限制；
 * 4. 当前核对记录列表和停止按钮。
 */
function renderActivity() {
  renderAttention();

  // 运行台只基于当前状态快照计算，不额外请求后台。
  const list = state.consultations || [],
    running = list.filter((r) => r.status === "running"),
    done = list.filter((r) => r.status === "completed"),
    waiting = (state.attention || []).length;
  changed(
    "activityMetrics",
    [list.length, running.length, done.length, waiting],
    () => {
      $("activityMetrics").replaceChildren(
        metric(
          "运行中的只读 Worker",
          running.length,
          "同一目标最多 " +
            (state.consultLimits?.maxParallelPerTarget || 2) +
            " 个",
        ),
        metric("已完成核对", done.length, "结果可回到来源会话"),
        metric(
          "待你处理",
          waiting,
          waiting ? "一次只显示一项，完成后显示下一项" : "当前无需人工介入",
        ),
        metric("保留线程", list.length, "最近 100 条，重启后可查"),
      );
    },
  );

  // 把后台实际生效的限制展示出来，避免用户以为规则是写死的。
  const limits = state.consultLimits || {};
  changed("activityRoute", [state.bindings, state.projects], () => {
    $("activityRoute").replaceChildren(
      node("div", "Agent 只提交工具和问题；目标项目由保存的绑定决定。", "rule"),
      node(
        "div",
        "同一来源会话继续使用同一 Worker 线程，第几轮会自动记录。",
        "rule",
      ),
      node(
        "div",
        "精确重复的核对会复用原 consultId，不再启动第二个 Worker。",
        "rule",
      ),
    );
    for (const binding of state.bindings || [])
      $("activityRoute").append(
        node(
          "div",
          projectName(binding.sourceProjectId) +
            " → " +
            agentName(binding.targetTool) +
            " / " +
            projectName(binding.targetProjectId),
          "rule",
        ),
      );
    if (!(state.bindings || []).length)
      $("activityRoute").append(
        node("div", "尚未保存绑定；核对会回退到来源会话当前项目。", "rule"),
      );
  });
  changed("activityGuards", limits, () => {
    $("activityGuards").replaceChildren(
      node(
        "div",
        "每 " +
          Math.round((limits.windowMs || 600000) / 60000) +
          " 分钟最多 " +
          (limits.maxPerWindow || 12) +
          " 次核对 / 来源会话",
        "rule",
      ),
      node(
        "div",
        "同一目标最多 " +
          (limits.maxParallelPerTarget || 2) +
          " 个只读 Worker 并行",
        "rule",
      ),
      node(
        "div",
        "单次最长 " +
          Math.round((limits.maxDurationMs || 180000) / 60000) +
          " 分钟；" +
          Math.round((limits.noProgressMs || 120000) / 60000) +
          " 分钟无输出自动停止",
        "rule",
      ),
      node(
        "div",
        "停止按钮只终止本次只读 Worker，不写入来源或目标原会话",
        "rule",
      ),
    );
  });
  changed("consultations", list, () => {
    $("consultations").replaceChildren();
    for (const record of list) {
      const route = record.route || {},
        title =
          (route.sourceProjectName || projectName(record.sourceProjectId)) +
          " → " +
          (route.targetProjectName || projectName(record.targetProjectId)) +
          " · " +
          agentName(route.targetTool || record.targetTool),
        bytes = record.outputBytes || 0,
        size = bytes < 1024 ? bytes + " B" : Math.round(bytes / 1024) + " KB";
      const e = card(
        title,
        "第 " +
          (record.round || 1) +
          " 轮 · " +
          routeMode(record) +
          " · " +
          statusText(record.status),
      );
      e.id = "consult-" + record.id;
      e.append(
        node("span", statusText(record.status), "badge"),
        node(
          "span",
          "线程 " + String(record.threadId || "").slice(-8),
          "badge",
        ),
        node("span", record.progressEvents + " 次进展信号", "badge"),
      );
      e.append(node("div", record.question || "", "consult-question"));
      e.append(
        node(
          "p",
          "已运行 " +
            elapsed(record.elapsedMs) +
            " · 最近进展 " +
            elapsed(record.idleMs) +
            " 前 · 输出 " +
            size,
          "consult-meta",
        ),
      );
      if (record.status === "running")
        e.append(
          button(
            "停止只读核对",
            () => api("consult/stop", { id: record.id }),
            "danger",
          ),
        );
      if (record.result) {
        const d = node("details");
        d.append(
          node("summary", "查看返回结果"),
          node("pre", record.result, "consult-result"),
        );
        e.append(d);
      }
      if (record.error)
        e.append(node("p", "停止原因：" + record.error, "danger"));
      $("consultations").append(e);
    }
    if (!list.length)
      $("consultations").append(
        card(
          "尚无核对线程",
          "当原会话中的 Agent 调用 bridge_consult 时，路由、Worker 和止损状态会显示在这里。",
        ),
      );
  });
}
$("refreshActivity").onclick = () =>
  action(
    $("refreshActivity"),
    async () => {
      const value = await api("status");
      applyState(value);
      return value;
    },
    "运行台已刷新。",
  );

/**
 * 判断会话是否由对方发起。
 *
 * 兼容新旧字段：direction=incoming 或 incoming=true。
 */
function incoming(c) {
  return c?.direction === "incoming" || c?.incoming === true;
}

/**
 * 取当前选中的会话。
 *
 * selected 为空时返回 undefined，调用方需要自行处理空状态。
 */
function current() {
  return state.conversations.find((c) => c.id === selected);
}

/**
 * 取当前会话最近一次后台操作。
 *
 * operations 按开始时间追加，所以取最后一个即可。
 */
function currentOperation() {
  return state.operations.filter((o) => o.conversationId === selected).at(-1);
}

/**
 * 刷新右侧会话区。
 *
 * 根据当前会话和运行中操作决定：
 * - 显示快速入口还是消息区；
 * - 按钮是“发送并运行”“插入消息”还是禁用；
 * - 暂停/归档按钮是否可用；
 * - 操作输出是否同步到页面。
 */
function updateConversation() {
  // busy 同时兼容 operation 状态和旧会话状态，避免按钮在过渡期误判。
  const c = current(),
    op = currentOperation(),
    busy =
      op?.status === "running" ||
      op?.status === "processing" ||
      c?.status === "running";
  $("quickStart").hidden = !!c;
  $("transcript").hidden = !c;
  $("runDetails").hidden = !c;
  $("runForm").hidden = !c;
  if (!c) $("historyControls").hidden = true;
  $("conversationTitle").textContent = c?.title || "Agent 主动桥接";
  const connection = state.connections.find((x) => x.id === c?.connectionId);
  $("conversationMeta").textContent = c
    ? projectName(c.projectId) +
      " · " +
      agentName(localAgent(c)) +
      "（本机） ↔ " +
      agentName(c.remoteAgent) +
      "（" +
      (c.connectionId === "local" ? "本机" : connection?.name || "远端电脑") +
      "）" +
      (c.remoteProjectId
        ? " · 目标项目 " + (c.remoteProjectName || c.remoteProjectId)
        : "")
    : "让 Codex、Claude Code、Cursor 在任务中自己找对方确认。";
  $("conversationStatus").textContent =
    (c
      ? statusText(op?.status || c.status) + (op?.label ? " · " + op.label : "")
      : "MCP 桥接 · Agent 无需通过此窗口对话") + channelSummary(c);

  // channel 运行中再次提交时，不新建任务，而是把文本插入现有频道。
  const injecting = !!c && c.mode === "channel" && busy;
  $("runConversation").textContent = injecting
    ? "插入消息"
    : c?.mode === "channel"
      ? "启动频道"
      : "发送并运行";
  $("runConversation").disabled =
    !c || (busy && !injecting) || !!c.archived || c.status === "archived";
  $("pauseConversation").hidden = !c;
  $("pauseConversation").disabled = !busy;
  $("archiveConversation").hidden = !c;
  $("archiveConversation").disabled =
    busy || !!c?.archived || c?.status === "archived";
  if (op) {
    if (!outputs.has(op.id)) outputs.set(op.id, op.output || "");
    else if (op.output && op.output.length > outputs.get(op.id).length)
      outputs.set(op.id, op.output);
    const out = outputs.get(op.id);
    if ($("operationOutput").textContent !== out)
      $("operationOutput").textContent = out;
  } else $("operationOutput").textContent = "尚无运行记录";
}

/**
 * 选中会话并加载第一页消息。
 *
 * 重置分页 offset，刷新左侧选中态和右侧头信息，然后请求消息历史。
 */
async function selectConversation(id) {
  selected = id;
  offset = 0;
  renderTopics();
  updateConversation();
  await loadMessages();
}

/**
 * 生成消息去重键。
 *
 * 优先用后台 id；没有 id 的旧消息用时间、角色、方向和内容拼一个稳定键。
 */
function messageKey(m) {
  return (
    m.id ||
    JSON.stringify([m.timestamp || m.at, m.role, m.side, m.text || m.content])
  );
}

/**
 * 把一条消息渲染成 DOM。
 *
 * 负责推断来源显示：
 * - 人工指令；
 * - 本机工具；
 * - 对方工具/设备；
 * - 消息投递状态。
 */
function messageNode(m) {
  const e = node(
    "article",
    undefined,
    "message" +
      (m.side === "human" || m.role === "human" || m.role === "user"
        ? " human"
        : ""),
  );
  e.dataset.messageKey = messageKey(m);
  const c = current(),
    remote = m.side === "remote" || m.source?.side === "remote";

  // 来源优先使用消息自带字段，缺失时再按方向推断为对方或本机。
  const source =
    typeof m.source === "string"
      ? m.source
      : [
          m.source?.owner,
          m.source?.deviceName ||
            m.deviceName ||
            (remote
              ? state.connections.find((x) => x.id === c?.connectionId)?.name
              : state.device?.name || state.name),
          agentName(
            m.agent ||
              m.source?.agent ||
              (remote ? c?.remoteAgent : localAgent(c)),
          ),
          m.side === "human" || m.role === "human" || m.role === "user"
            ? "人工指令"
            : remote
              ? "对方"
              : "本机",
        ]
          .filter(Boolean)
          .join(" / ");
  e.append(
    node("div", source, "source"),
    node("div", m.text ?? m.content ?? m.body ?? "", "body"),
  );
  if (m.status || m.deliveryStatus)
    e.append(node("div", statusText(m.deliveryStatus || m.status), "delivery"));
  return e;
}

/**
 * 加载当前会话的一页历史消息。
 *
 * 使用 messageRequest 递增序号丢弃过期响应：
 * 用户快速切换会话时，先发出的请求即使后返回，也不会覆盖新会话。
 */
async function loadMessages() {
  if (!selected) return;

  // 每次加载递增请求号；返回时号不一致就丢弃，解决快速切换会话的竞态。
  const request = ++messageRequest,
    id = selected;
  $("conversationStatus").textContent = "正在读取历史…";
  try {
    const v = await api(
      "conversations/messages?id=" +
        encodeURIComponent(id) +
        "&after=" +
        offset +
        "&limit=100",
    );
    if (request !== messageRequest || selected !== id) return;
    total = v.total || 0;
    messageIds.clear();
    $("transcript").replaceChildren();
    for (const m of v.messages || []) {
      messageIds.add(messageKey(m));
      $("transcript").append(messageNode(m));
    }
    if (!(v.messages || []).length)
      $("transcript").append(
        node("div", "暂无消息。输入目标，开始专用协作。", "empty"),
      );
    $("historyControls").hidden = false;
    $("historyRange").textContent = total
      ? `${offset + 1}–${Math.min(offset + (v.messages || []).length, total)} / ${total}`
      : "暂无历史";
    $("older").disabled = offset === 0;
    $("newer").disabled = offset + 100 >= total;
    $("transcript").scrollTop = $("transcript").scrollHeight;
    updateConversation();
  } catch (e) {
    if (request === messageRequest) notice("读取历史失败：" + e.message);
  }
}
$("older").onclick = () => {
  offset = Math.max(0, offset - 100);
  loadMessages();
};
$("newer").onclick = () => {
  offset += 100;
  loadMessages();
};

/**
 * 处理 SSE 推送的新消息。
 *
 * 只处理当前打开的会话；按 messageKey 去重；
 * 如果用户正在看历史（不在最新一页），只更新总数，不强行滚动。
 */
function appendMessage(event) {
  // 只把当前打开会话的消息插进 DOM，其它会话只更新后台状态。
  if (event.conversationId !== selected) return;
  const m = event.message,
    key = messageKey(m);
  if (messageIds.has(key)) return;
  const t = $("transcript"),
    atLatest = offset + messageIds.size >= total;
  total++;

  // 用户正在翻历史时不强行追加，只提示可以点“较新”回到最新。
  if (!atLatest) {
    $("newer").disabled = false;
    return;
  }
  const bottom = t.scrollHeight - t.scrollTop - t.clientHeight < 70;
  t.querySelector(".empty")?.remove();
  messageIds.add(key);
  t.append(messageNode(m));

  // DOM 最多保留 100 条，超出后从最旧一条开始移除并前移 offset。
  if (t.children.length > 100) {
    messageIds.delete(t.firstElementChild.dataset.messageKey);
    t.firstElementChild.remove();
    offset++;
  }
  if (bottom) t.scrollTop = t.scrollHeight;
  $("historyRange").textContent =
    `${offset + 1}–${offset + t.children.length} / ${total}`;
  $("older").disabled = offset === 0;
}
$("runForm").onsubmit = (e) => {
  e.preventDefault();
  const id = selected,
    goal = $("goal").value.trim(),
    c = current();
  if (!id || !goal) return;
  const injecting =
    c?.mode === "channel" &&
    (currentOperation()?.status === "running" || c.status === "running");
  action($("runConversation"), () =>
    api(
      injecting ? "conversations/message" : "conversations/run",
      injecting ? { id, text: goal } : { id, goal },
    ),
  ).then((v) => {
    if (v && selected === id) $("goal").value = "";
  });
};
$("pauseConversation").onclick = () =>
  action(
    $("pauseConversation"),
    () => api("conversations/stop", { id: selected }),
    "暂停请求已发送；执行状态由后台确认。",
  );
$("archiveConversation").onclick = () =>
  action($("archiveConversation"), () =>
    api("conversations/archive", { id: selected }),
  );

/**
 * 渲染电脑与配对页面。
 *
 * 包含三部分：
 * - 本机接收服务状态、配对码和局域网地址；
 * - 入站配对请求；
 * - 已配对连接和反向 peer 列表。
 */
function renderComputers() {
  // host 为空表示本机还没启动接收服务；已启动时显示配对码和地址。
  const host = state.host;
  $("hosting").hidden = !host;
  $("hostStart").hidden = !!host;
  if (host) {
    $("pairCode").textContent = host.code || "等待生成";
    changed("addresses", [state.addresses, host.port], () => {
      $("addresses").replaceChildren(
        ...(state.addresses || []).map((a) =>
          node(
            "div",
            (a.recommended
              ? "推荐 · "
              : a.kind === "virtual"
                ? "虚拟网络 · "
                : "网络 · ") +
              (String(a.address || a).startsWith("http")
                ? a.address || a
                : "http://" + (a.address || a) + ":" + host.port),
            "address",
          ),
        ),
      );
    });
  }
  changed("requests", host?.requests, () => {
    $("requests").replaceChildren();
    for (const r of host?.requests || []) {
      const e = card(
        (r.name || "未知电脑") + " 请求配对",
        (r.ip || "") + " · 请核对来源",
      );
      e.append(
        button(
          "同意",
          () => api("host/approve", { id: r.id, accept: true }),
          "primary",
        ),
        button("拒绝", () => api("host/approve", { id: r.id, accept: false })),
      );
      $("requests").append(e);
    }
  });
  changed("connections", state.connections, () => {
    $("connections").replaceChildren();
    for (const c of state.connections) {
      const e = card(c.name || "配对电脑", c.url || "");
      e.append(
        node("span", statusText(c.status), "badge"),
        node(
          "span",
          c.bidirectional ? "双向连接已确认" : "反向可达性未确认",
          "badge",
        ),
        node(
          "p",
          "可用工具：" +
            (Object.keys(c.agents || {})
              .map(agentName)
              .join("、") || "尚未确认") +
            (c.legacy ? " · 旧版接收端" : ""),
        ),
        button("查看对方原会话", async () => {
          const v = await api("native/sessions?id=" + encodeURIComponent(c.id));
          let list = e.querySelector(".remote-native");
          if (!list) {
            list = node("div", undefined, "remote-native");
            e.append(list);
          }
          list.replaceChildren(
            ...(v.sessions || []).map((s) =>
              node(
                "p",
                (s.title || "未命名原会话") +
                  " · " +
                  agentName(s.tool) +
                  " · MCP 工具登记（主动调用收信）",
              ),
            ),
          );
          if (!(v.sessions || []).length)
            list.append(node("p", "对方当前没有在线登记的原会话。"));
        }),
        button("刷新连接", () => api("refresh", { id: c.id })),
        button("撤销配对", () => api("host/revoke", { id: c.id }), "danger"),
      );
      $("connections").append(e);
    }
    if (!state.connections.length)
      $("connections").append(node("p", "尚未建立出站连接；可继续添加多台。"));
  });
  changed("peers", host?.peers, () => {
    $("peers").replaceChildren();
    for (const p of host?.peers || []) {
      const e = card(p.name || "入站电脑", "已授权入站 · " + p.id);
      e.append(
        node("span", "反向状态以连接记录为准", "badge"),
        button("撤销授权", () => api("host/revoke", { id: p.id }), "danger"),
      );
      $("peers").append(e);
    }
    if (!(host?.peers || []).length)
      $("peers").append(node("p", "暂无入站授权；可同时授权多台电脑。"));
  });
}
$("pairForm").onsubmit = (e) => {
  e.preventDefault();
  wantedPair = true;
  action(
    e.submitter,
    () =>
      api("pair", {
        url: $("remoteUrl").value.trim(),
        code: $("pairCodeInput").value.trim(),
        name: $("pairName").value.trim(),
        projectId: $("pairProject").value || undefined,
      }),
    "配对申请已提交，等待对方确认。",
  ).then((v) => {
    if (!v) wantedPair = false;
  });
};
$("hostStart").onclick = () =>
  action($("hostStart"), () =>
    api("host/start", {
      projectId: $("hostProject").value || undefined,
      port: Number(state.settings?.networkPort) || undefined,
    }),
  );
$("rotate").onclick = () => action($("rotate"), () => api("host/rotate", {}));

/**
 * 找某个工具最近一次本机诊断操作。
 *
 * 诊断操作的 conversationId 和 connection 都为空；
 * 同时兼容 agent、tool 和 label 三种历史字段。
 */
function diagnosticFor(agent) {
  return state.operations
    .filter(
      (o) =>
        !o.conversationId &&
        !o.connection &&
        (o.agent === agent ||
          o.tool === agent ||
          o.label?.toLowerCase().includes(agent)),
    )
    .at(-1);
}

/**
 * 取诊断操作的输出缓存。
 *
 * 输出按 operation id 存在 outputs Map 中；
 * 如果还没有缓存，就从后台返回的 op.output 初始化。
 */
function diagnosticOutput(op) {
  if (op.output !== undefined && !outputs.has(op.id))
    outputs.set(op.id, op.output.slice(-200000));
  return outputs.get(op.id) || op.output || "";
}

/**
 * 渲染本机 AI 工具页。
 *
 * 这是“CLI 还是桌面 App”最容易误判的地方：
 * - standaloneAgents 表示存在独立 CLI；
 * - desktopApps 表示只安装了桌面 App；
 * - agents 表示当前实际可调用的运行时（可能来自桌面 App 内置）。
 * 三者分开显示，用户才能知道该配置哪种 MCP。
 */
function renderTools() {
  $("toolsLoading").hidden = !state.toolsLoading;
  changed(
    "tools",
    [
      state.agents,
      state.standaloneAgents,
      state.desktopApps,
      state.toolsLoading,
      state.sessions,
      state.operations.filter((o) => !o.conversationId),
      $("diagnosticProject").value,
    ],
    () => {
      $("tools").replaceChildren();
      const ids = new Set([
        ...Object.keys(names),
        ...Object.keys(state.agents || {}),
      ]);
      for (const id of ids) {
        // 三种状态必须分开：独立 CLI、桌面 App 内置 runtime、仅安装未就绪。
        const value = state.agents?.[id],
          standalone = state.standaloneAgents?.[id],
          app = state.desktopApps?.[id],
          version = typeof value === "object" ? value?.version : value,
          title = standalone
            ? `检测到独立 CLI ${version}`
            : version
              ? `桌面 App 运行时可用 · ${version}`
              : app
                ? "桌面端已安装 · 运行时会话未就绪"
                : "未安装或未检测到",
          e = card(agentName(id), title);
        e.dataset.agent = id;
        e.append(
          node(
            "span",
            standalone
              ? "独立 CLI · 原生聊天未自动接入"
              : value && app
                ? "桌面 App 内部运行时 · 无需单独安装 CLI"
                : app
                  ? "桌面端已安装 · 可配置 MCP"
                  : "未安装或未检测到",
            "badge",
          ),
        );
        const sessions = state.sessions.filter((s) => s.tool === id);
        e.append(
          node(
            "p",
            "已登记 " +
              sessions.length +
              " 段会话。原生收件箱能力以连接器实际登记为准。",
          ),
        );
        if (!standalone && value && app)
          e.append(
            node("p", "本机诊断和托管咨询会复用桌面 App 准备的内部运行时。"),
          );
        const diagnostic = diagnosticFor(id);
        if (diagnostic) {
          e.append(
            node(
              "p",
              statusText(diagnostic.status) +
                " · " +
                (diagnostic.label || "本机诊断"),
            ),
          );
          const output = node(
            "pre",
            diagnosticOutput(diagnostic),
            "diagnostic-output",
          );
          output.id = "diagnostic-output-" + diagnostic.id;
          e.append(output);
          if (diagnostic.error)
            e.append(node("p", "错误：" + diagnostic.error, "danger"));
        }
        const b = button("运行本机诊断（会调用模型）", () =>
          api("tools/diagnose", {
            agent: id,
            projectId: $("diagnosticProject").value,
          }),
        );
        b.disabled =
          !value ||
          !$("diagnosticProject").value ||
          diagnostic?.status === "running";
        if (!value)
          b.title = app
            ? "桌面端已安装，但未找到可调用的 CLI；请使用原会话 MCP，或安装 CLI。"
            : "未检测到可调用的 CLI";
        e.append(b);
        $("tools").append(e);
      }
    },
  );
}
$("diagnosticProject").onchange = renderTools;

/**
 * 渲染跨工具项目绑定。
 *
 * 每条绑定表示“来源项目里的某个工具，应该去目标项目找另一个工具核对”。
 */
function renderBindings() {
  changed("bindings", [state.bindings, state.projects], () => {
    $("bindings").replaceChildren();
    for (const binding of state.bindings) {
      const e = card(
        projectName(binding.sourceProjectId) +
          " → " +
          agentName(binding.targetTool),
        projectName(binding.targetProjectId),
      );
      e.append(
        button(
          "删除绑定",
          () =>
            api("bindings/delete", {
              sourceProjectId: binding.sourceProjectId,
              targetTool: binding.targetTool,
            }),
          "danger",
        ),
      );
      $("bindings").append(e);
    }
    if (!state.bindings.length)
      $("bindings").append(
        node(
          "p",
          "尚未绑定。配置 MCP 时可一并选择目标工具和目标项目；不填则回退当前项目。",
        ),
      );
  });
}

/**
 * 渲染原生收件箱与 MCP 状态。
 *
 * 包括：
 * - 在线登记的原会话；
 * - 收件/回复问题队列；
 * - 配置按钮文案（桌面 App 还是独立 CLI）。
 */
function renderNative() {
  $("connectClaude").textContent =
    state.desktopApps?.claude && !state.standaloneAgents?.claude
      ? "配置 Claude Desktop MCP"
      : "配置 Claude Code MCP";
  $("connectCursor").textContent =
    state.desktopApps?.cursor && !state.standaloneAgents?.cursor
      ? "配置 Cursor Desktop MCP"
      : "配置 Cursor MCP";

  // 新版本用 nativeSessions，旧数据回退到 nativeInbox.sessions。
  const sessions = state.nativeSessions || state.nativeInbox?.sessions || [];
  renderBridgeOverview();
  changed("nativeSessions", sessions, () => {
    $("nativeSessions").replaceChildren();
    for (const s of sessions) {
      const e = card(
        s.title || "原会话收件工具",
        agentName(s.tool) + " · " + projectName(s.projectId),
      );
      e.append(
        node(
          "span",
          s.status === "available"
            ? "MCP 工具已登记 · 可调用收信"
            : "收信工具离线",
          "badge",
        ),
        node(
          "p",
          "接入方式：" +
            (s.binding === "mcp-tool" ? "原工具主动调用收信 / 回复" : "待确认"),
        ),
      );
      if (s.nativeSessionId)
        e.append(
          node(
            "p",
            "工具自报会话标识：" + s.nativeSessionId + "（未独立核验）",
          ),
        );
      $("nativeSessions").append(e);
    }
    if (!sessions.length)
      $("nativeSessions").append(
        node(
          "p",
          "尚无在线原会话登记。配置 MCP 后，需要在原工具中调用登记工具。",
        ),
      );
  });
  const questions = (state.nativeInbox?.questions || []).slice(-100).reverse();
  changed("nativeQuestions", questions, () => {
    $("nativeQuestions").replaceChildren();
    const statuses = {
      queued: "待目标工具收取",
      delivered: "目标工具已收取 · 等待回复",
      answered: "目标工具已提交回复",
      interrupted: "后台重启 · 投递已中断",
      cancelled: "已取消",
      "recipient-offline": "目标收信工具离线",
    };
    for (const q of questions) {
      const target = sessions.find((s) => s.id === q.targetSessionId),
        source =
          typeof q.source === "string"
            ? q.source
            : [
                q.source?.deviceName || q.source?.device,
                q.source?.title,
                q.source?.tool,
              ]
                .filter(Boolean)
                .join(" / ");
      const e = card(
        target?.title || "原会话问答",
        source ? "来源：" + source : "来源信息以工具登记为准",
      );
      e.append(
        node("span", statuses[q.status] || statusText(q.status), "badge"),
        node("div", q.text || "", "native-question"),
      );
      if (q.answer)
        e.append(
          node("h3", "工具提交的回复"),
          node("div", q.answer, "native-question"),
        );
      if (q.createdAt) e.append(node("small", q.createdAt));
      $("nativeQuestions").append(e);
    }
    if (!questions.length)
      $("nativeQuestions").append(node("p", "暂无原会话收件或回复记录。"));
  });
}

/**
 * 配置某个工具的原生 MCP。
 *
 * 先校验项目、目标工具和目标项目是否成对；
 * 再调用控制面写配置，最后把配置路径和后续操作提示显示给用户。
 */
async function connectNative(agent, button) {
  // 配置 MCP 前必须先选本机项目，否则无法生成项目级绑定。
  const projectId = $("nativeProject").value;
  if (!projectId) {
    notice("先添加并选择本机项目，再配置 MCP。");
    return;
  }
  const targetTool = $("nativeTargetTool").value,
    targetProjectId = $("nativeTargetProject").value;
  if (!!targetTool !== !!targetProjectId) {
    notice("目标工具和目标项目需要一起选择。");
    return;
  }
  const result = await action(button, () =>
    api("tools/connect", {
      agent,
      projectId,
      targetTool: targetTool || undefined,
      targetProjectId: targetProjectId || undefined,
    }),
  );
  if (result) {
    $("nativeInstructions").hidden = false;
    $("nativeInstructions").textContent = [
      agentName(agent) + " · MCP 配置已写入",
      result.configPath ? "配置文件：" + result.configPath : "",
      Array.isArray(result.instructions)
        ? result.instructions.join("\n")
        : result.instructions || "请回到原工具启用 MCP，再调用登记工具。",
      targetTool
        ? "已保存跨工具项目定位：" +
          agentName(targetTool) +
          " → " +
          projectName(targetProjectId)
        : "未保存跨工具项目定位，核对将回退当前项目。",
      "配置完成后仍需原工具调用收信与回复；尚未验证主动推送唤醒。",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
}
$("connectClaude").onclick = () => connectNative("claude", $("connectClaude"));
$("connectCursor").onclick = () => connectNative("cursor", $("connectCursor"));
$("connectCodex").onclick = () => connectNative("codex", $("connectCodex"));
$("connectDeepSeek").onclick = () =>
  connectNative("deepseek", $("connectDeepSeek"));

/**
 * 渲染项目列表。
 *
 * 每个项目显示会话数、联络数，并提供编辑/删除。
 * 删除前二次确认，已有会话是否允许删除仍由后台校验。
 */
function renderProjects() {
  changed(
    "projects",
    [
      state.projects,
      state.sessions,
      state.conversations.map((c) => [c.id, c.projectId, c.status]),
    ],
    () => {
      $("projects").replaceChildren();
      for (const p of state.projects) {
        const e = card(p.name, p.path);
        e.append(
          node(
            "p",
            state.sessions.filter((s) => s.projectId === p.id).length +
              " 段工具会话 · " +
              state.conversations.filter(
                (c) => c.projectId === p.id && !c.archived,
              ).length +
              " 条联络",
          ),
          button("编辑", () => {
            $("projectId").value = p.id;
            $("projectName").value = p.name;
            $("projectPath").value = p.path;
            $("projectFormTitle").textContent = "编辑项目";
            $("projectName").focus();
          }),
          button(
            "删除",
            () => {
              if (
                confirm(
                  "删除项目“" + p.name + "”？已有会话的处理以后台校验为准。",
                )
              )
                return api("projects/delete", { id: p.id });
            },
            "danger",
          ),
        );
        $("projects").append(e);
      }
    },
  );
}
$("projectForm").onsubmit = (e) => {
  e.preventDefault();
  action(
    e.submitter,
    () =>
      api("projects/save", {
        id: $("projectId").value || undefined,
        name: $("projectName").value.trim(),
        path: $("projectPath").value.trim(),
      }),
    "项目已保存。",
  ).then((v) => {
    if (v) resetProject();
  });
};

/**
 * 清空项目编辑表单。
 *
 * 恢复成“添加项目”状态，避免编辑完一个项目后误改另一个。
 */
function resetProject() {
  $("projectForm").reset();
  $("projectId").value = "";
  $("projectFormTitle").textContent = "添加项目";
}
$("cancelProjectEdit").onclick = resetProject;
window.bridgeFolderTarget = "projectPath";
window.bridgeSetProject = (path) => {
  const target = $(window.bridgeFolderTarget || "projectPath");
  if (target) target.value = path;
};
$("chooseFolder").onclick = () => {
  window.bridgeFolderTarget = "projectPath";
  if (window.webkit?.messageHandlers?.bridge)
    window.webkit.messageHandlers.bridge.postMessage("chooseFolder");
  else notice("浏览器无法打开原生目录选择器，请填写本机绝对路径。");
};
$("deviceForm").onsubmit = (e) => {
  e.preventDefault();
  action(
    e.submitter,
    () =>
      api("device", {
        name: $("settingsName").value.trim(),
        owner: $("settingsOwner").value.trim(),
      }),
    "本机身份已保存。",
  );
};
$("settingsForm").onsubmit = (e) => {
  e.preventDefault();
  action(
    e.submitter,
    async () => {
      const data = {
        closeToTray: $("closeToTray").checked,
        autoStartHost: $("autoStartHost").checked,
        networkPort: Number($("networkPort").value),
      };
      const v = await api("settings", data);
      window.webkit?.messageHandlers?.bridge?.postMessage({
        action: "preferences",
        closeToTray: data.closeToTray,
      });
      return v;
    },
    "运行偏好已保存。",
  );
};

/**
 * 刷新新建会话的目标工具和目标项目。
 *
 * 本机模式使用本机检测到的工具和本机项目；
 * 远端模式使用 peer /health 返回的工具和 /catalog 返回的项目；
 * 旧版接收端没有目录能力时，回退到对方配置的项目。
 */
function renderTarget() {
  // local 表示本机工具互连；其它 id 表示已配对电脑。
  const id = $("connection").value,
    local = id === "local",
    c = state.connections.find((c) => c.id === id);
  options(
    "remoteAgent",
    Object.keys(local ? state.agents || {} : c?.agents || {}).map((a) => [
      a,
      agentName(a),
    ]),
    "尚未确认目标工具",
  );
  const hasRemote = state.connections.length > 0;
  $("connectionHint").textContent = hasRemote
    ? "目标电脑和配对权限在“电脑”页管理。"
    : "还没有配对电脑。先完成配对，才能把核对发到另一台电脑。";
  $("openPairing").textContent = hasRemote ? "管理配对设置" : "打开配对设置";
  if (local) {
    options(
      "remoteProject",
      state.projects.map((p) => [p.id, p.name]),
      "请先添加项目",
    );
    $("catalogHint").textContent = "本机工具之间联络，无需配对自己的电脑。";
    $("remoteProject").required = true;
  } else if (catalogKey === id && catalog) {
    options(
      "remoteProject",
      catalog.projects.map((p) => [p.id, p.name]),
      "对方没有分享项目",
    );
    $("catalogHint").textContent = "只显示对方允许发现的项目。";
    $("remoteProject").required = true;
  } else {
    options("remoteProject", [["", "使用旧版接收端配置的项目"]]);
    $("remoteProject").required = false;
    $("catalogHint").textContent = catalogLoading
      ? "正在读取对方允许发现的项目…"
      : "远端项目目录尚未取得；旧版接收端将使用其配置目录。";
  }
}

/**
 * 读取远端 peer 允许发现的项目。
 *
 * 用 catalogKey/当前 select 值做竞态保护：
 * 用户切换连接后，旧请求返回也不能覆盖新连接的目录。
 */
async function loadCatalog() {
  const id = $("connection").value;
  catalog = null;
  catalogKey = id;
  if (id === "local") {
    catalogLoading = false;
    renderTarget();
    return;
  }

  // 先标记 loading 并重绘，让用户知道远端目录正在读取。
  catalogLoading = true;
  renderTarget();
  try {
    const v = await api("peer/catalog?id=" + encodeURIComponent(id));
    if ($("connection").value !== id) return;
    catalog = { ...v, projects: v.projects || [] };
  } catch (e) {
    if ($("connection").value === id) {
      catalog = null;
      $("catalogHint").textContent = "无法读取远端目录：" + e.message;
    }
  } finally {
    if ($("connection").value === id) {
      catalogLoading = false;
      renderTarget();
    }
  }
}

/**
 * 控制轮次输入框的显示。
 *
 * 只有 meeting 模式才需要固定轮次；channel 模式由消息驱动，不显示轮次。
 */
const syncMode = () => {
  $("roundsField").hidden = $("mode").value !== "meeting";
};
$("mode").onchange = syncMode;
syncMode();

/**
 * 重置快速核对表单。
 *
 * 清空当前会话选择、问题和分页，并展开手动核对区域。
 */
function resetQuickStart() {
  selected = "";
  offset = 0;
  renderTopics();
  updateConversation();
  $("manualConsult").open = true;
  $("quickQuestion").value = "";
  if ($("projectFilter").value)
    $("quickProject").value = $("projectFilter").value;
  renderQuickStart();
  $("quickProject").focus();
}
$("quickNew").onclick = resetQuickStart;
$("quickLocalAgent").onchange = renderQuickStart;
$("openNativeSetup").onclick = () => showPage("tools");
$("showManualConsult").onclick = () => {
  $("manualConsult").open = true;
  $("quickQuestion").focus();
};
$("quickForm").onsubmit = (e) => {
  e.preventDefault();

  // 快速核对固定走本机 meeting 模式，轮次固定 1，跨电脑走高级入口。
  const projectId = $("quickProject").value,
    source = $("quickLocalAgent").value,
    target = $("quickRemoteAgent").value,
    question = $("quickQuestion").value.trim();
  if (!projectId) {
    showPage("projects");
    notice("先添加一个项目，再开始核对。");
    return;
  }
  if (!source || !target) {
    notice("需要至少两个已检测到的本机 AI 工具。");
    return;
  }
  if (source === target) {
    notice("发起 AI 和目标 AI 需要选择不同工具。");
    return;
  }
  if (!question) {
    notice("请写下要核对的问题。");
    return;
  }
  const title = question.replace(/\s+/g, " ").slice(0, 40);
  action(
    $("quickSubmit"),
    async () => {
      const created = await api("conversations/create", {
        title,
        projectId,
        localAgent: source,
        connectionId: "local",
        remoteAgent: target,
        remoteProjectId: projectId,
        mode: "meeting",
        rounds: 1,
      });
      const c = created.conversation || created;
      if (!c.id) throw Error("后台没有返回核对记录");
      if (!state.conversations.some((x) => x.id === c.id))
        state.conversations.push(c);
      await selectConversation(c.id);
      $("quickQuestion").value = "";
      return api("conversations/run", { id: c.id, goal: question });
    },
    "核对已开始。",
  );
};
$("connection").onchange = loadCatalog;
$("openPairing").onclick = () => {
  $("createDialog").close();
  showPage("computers");
};
$("newConversation").onclick = () => {
  if (!state.projects.length) {
    showPage("projects");
    notice("先添加本机项目，再新建会话。");
    return;
  }
  $("newProject").value = $("projectFilter").value || state.projects[0].id;
  $("createDialog").showModal();
  loadCatalog();
};
$("closeDialog").onclick = () => $("createDialog").close();
$("createForm").onsubmit = (e) => {
  e.preventDefault();
  if (catalogLoading) return;
  action(e.submitter, () =>
    api("conversations/create", {
      title: $("newTitle").value.trim(),
      projectId: $("newProject").value,
      localAgent: $("localAgent").value,
      connectionId: $("connection").value,
      remoteAgent: $("remoteAgent").value,
      remoteProjectId: $("remoteProject").value || undefined,
      mode: $("mode").value,
      rounds: Number($("rounds").value),
    }),
  ).then((v) => {
    if (!v) return;
    const c = v.conversation || v;
    if (c.id) {
      if (!state.conversations.some((x) => x.id === c.id))
        state.conversations.push(c);
      selectConversation(c.id);
    }
    $("createDialog").close();
    $("newTitle").value = "";
  });
};

/**
 * 处理一条 SSE 事件。
 *
 * 事件类型：
 * - state：全量 compact 状态；
 * - message：当前会话的新消息；
 * - output：某个 operation 的新输出。
 * 输出区只在用户本来就在底部时才自动滚动。
 */
function handleEvent(event) {
  if (event.type === "state") applyState(event.state);
  else if (event.type === "message" && event.message) appendMessage(event);
  else if (event.type === "output") {
    const old = outputs.get(event.operationId) || "";
    outputs.set(event.operationId, (old + event.text).slice(-200000));
    const diagnostic = $("diagnostic-output-" + event.operationId);
    if (diagnostic) {
      const bottom =
        diagnostic.scrollHeight -
          diagnostic.scrollTop -
          diagnostic.clientHeight <
        40;
      diagnostic.append(document.createTextNode(event.text));
      if (diagnostic.textContent.length > 200000)
        diagnostic.textContent = outputs.get(event.operationId);
      if (bottom) diagnostic.scrollTop = diagnostic.scrollHeight;
    }
    if (currentOperation()?.id === event.operationId) {
      const p = $("operationOutput"),
        bottom = p.scrollHeight - p.scrollTop - p.clientHeight < 40;
      p.append(document.createTextNode(event.text));
      if (p.textContent.length > 200000)
        p.textContent = outputs.get(event.operationId);
      if (bottom) p.scrollTop = p.scrollHeight;
    }
  }
  while (outputs.size > 30) outputs.delete(outputs.keys().next().value);
}

/**
 * 持续解析 SSE 流。
 *
 * 按空行切分事件块，只取 data: 行；
 * 网络断开时抛错，由 startEvents 负责重连。
 */
async function consumeEvents(response) {
  if (!response.ok || !response.body)
    throw Error("事件连接失败（" + response.status + "）");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";

  // 持续读取流；只有 done 或异常才退出。
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw Error("事件连接已断开");
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const i = boundary.index,
        block = buffer.slice(0, i);
      buffer = buffer.slice(i + boundary[0].length);
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          handleEvent(JSON.parse(data));
        } catch (e) {
          notice("事件处理失败：" + e.message);
        }
      }
    }
  }
}

/**
 * 建立并维持 SSE 连接。
 *
 * 连接成功后重置重连退避；
 * 失败后先拉一次完整 status 和当前会话消息，再指数退避重连，最大 15 秒。
 */
async function startEvents() {
  try {
    const r = await fetch("/api/events", { headers: { "x-bridge-ui": token } });
    if (!r.ok) throw Error("事件连接失败（" + r.status + "）");
    $("streamStatus").textContent = "后台已连接 · 实时更新";
    reconnectDelay = 800;
    await consumeEvents(r);
  } catch (e) {
    $("streamStatus").textContent = "后台连接中断 · 正在重连";
    setTimeout(async () => {
      try {
        applyState(await api("status"));
        if (selected) await loadMessages();
      } catch (error) {
        notice("后台不可达：" + error.message);
      }
      startEvents();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  }
}
api("status")
  .then(applyState)
  .catch((e) => notice("无法读取后台状态：" + e.message));
startEvents();

/**
 * 渲染版本更新信息。
 *
 * 显示当前版本、最新版本和是否有可下载的 DMG；
 * 没有安装包时隐藏下载按钮，避免点了才报错。
 */
function renderUpdate(info) {
  if (!info) return;
  $("currentVersion").textContent =
    info.current || $("currentVersion").textContent;

  // 只有存在可信 DMG 时才显示下载按钮。
  if (info.available) {
    $("updateStatus").textContent =
      "发现新版本 " +
      info.latest +
      (info.installer ? "，可直接下载安装包。" : "，但发布中暂无 DMG 安装包。");
    $("downloadUpdate").hidden = !info.installer;
  } else {
    $("updateStatus").textContent = info.latest
      ? "已是最新版本 " + info.latest + "。"
      : "暂未发布安装包。";
    $("downloadUpdate").hidden = true;
  }
}
$("checkUpdate").onclick = () =>
  action($("checkUpdate"), async () => {
    const info = await api("update");
    renderUpdate(info);
    return info;
  });
$("downloadUpdate").onclick = () =>
  action(
    $("downloadUpdate"),
    () => api("update/download", {}),
    "安装包已下载并打开，拖入“应用程序”即可完成升级。",
  );
api("version")
  .then((value) => {
    $("currentVersion").textContent = value.version || "—";
  })
  .catch(() => {});
