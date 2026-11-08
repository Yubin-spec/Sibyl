/**
 * 本机控制面（Control Plane）。
 *
 * 这个模块是桌面 UI、桥接协议、原生会话收件箱和本地存储之间的编排层：
 * 1. 启动只监听 127.0.0.1 的 HTTP/SSE 服务；
 * 2. 提供项目、会话、核对、配对、诊断和更新接口；
 * 3. 把需要真实执行模型的任务交给 bridge/runner；
 * 4. 把持久化细节交给 workspace；
 * 5. 把 MCP 配置细节交给 native/*。
 *
 * 安全边界：
 * - 所有 UI 请求都要求 x-bridge-ui CSRF 头，POST 还会校验 Origin；
 * - 本文件不接收远端目录，项目路径只能来自本机已保存项目；
 * - 文件内容、凭证和模型密钥不会写进前端状态。
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { networkInterfaces, hostname } from "node:os";
import {
  createBridge,
  detectAgents,
  detectStandaloneAgents,
  detectDesktopApps,
  makeClient,
  agentRunner,
} from "../bridge/bridge.mjs";
import { openWorkspace } from "./workspace.mjs";
import { openNativeInbox } from "../native/native-inbox.mjs";
import { runChannel } from "../bridge/channel.mjs";
import { latestRelease, updateInfo } from "../platform/update.mjs";
import {
  DEFAULT_CONSULT_LIMITS,
  normalizeConsultLimits,
  consultFingerprint,
  findDuplicate,
  checkBudget,
  checkParallel,
  checkProgress,
} from "../bridge/consult-policy.mjs";
import { attentionItems } from "../bridge/attention.mjs";
const source = fileURLToPath(new URL("../ui/", import.meta.url));

/**
 * 等待指定毫秒。
 *
 * 用于远端 job 轮询、配对轮询和重连退避；单独抽出来是为了让调用点语义清楚，
 * 也避免在业务代码里反复写 new Promise(setTimeout)。
 */
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const version = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
).version;

/**
 * 创建本机控制面。
 *
 * 参数：
 * - dir：控制面数据目录（项目、会话、连接凭证、核对记录都写在这里）；
 * - detect：检测所有可用 AI 运行时，默认包含桌面 App 内置 runtime；
 * - detectStandalone：只检测独立 CLI，用于决定 MCP 配置写到哪；
 * - runner：真正调用 AI 的执行器，测试里可替换成假实现；
 * - healthInterval：刷新 peer 在线状态和 SSE 保活的心跳间隔；
 * - consultLimits：只读核对的预算、并发和超时限制。
 *
 * 返回一个只在 127.0.0.1 监听的 HTTP server，以及 close() 清理入口。
 * 所有外部依赖都从参数注入，生产入口使用默认值，测试可以完全离线运行。
 */
export async function createControl({
  dir,
  detect = detectAgents,
  detectStandalone = detectStandaloneAgents,
  runner = (prompt, session, signal, project, agent, options) =>
    agentRunner(agent, prompt, session, signal, project, options),
  healthInterval = 15000,
  consultLimits = {},
} = {}) {
  // 连接凭证包含配对 token；目录权限收紧到当前用户，避免同机其他账号读取。
  await mkdir(join(dir, "connections"), { recursive: true, mode: 0o700 });
  let notifyNative = () => {},
    consultStart,
    consultResult,
    consultStop;

  // 原生收件箱负责和 MCP 子进程通信；它的回调在下面几个函数里补齐。
  const nativeInbox = await openNativeInbox({
    dir,
    onChange: () => notifyNative(),
    context: (input) => nativeContext(input),
    consult: (input) => consultStart(input),
    consultResult: (input) => consultResult(input),
    consultStop: (input) => consultStop(input),
  });
  let store;
  try {
    store = await openWorkspace(dir);
  } catch (e) {
    await nativeInbox.close();
    throw e;
  }

  /**
   * 生成原生 MCP 会话的上下文。
   *
   * 输入是 native-mcp 传进来的已登记会话；输出告诉模型：
   * 1. 自己是谁、当前项目是什么；
   * 2. 这个项目已经绑定了哪些目标工具和目标项目；
   * 3. 什么时候应该主动调用 bridge_consult，以及只读核对的边界。
   *
   * 这里不返回 token、文件内容或模型密钥，只返回路由所需的项目名称和工具名。
   */
  async function nativeContext({ session }) {
    const snapshot = store.snapshot();
    let source = null;
    try {
      source = session.projectId
        ? snapshot.projects.find(
            (project) => project.id === session.projectId,
          ) || null
        : session.projectPath
          ? snapshot.projects.find(
              (project) => project.path === realpathSync(session.projectPath),
            ) || null
          : null;
    } catch {}
    const targets = source
      ? snapshot.bindings
          .filter((binding) => binding.sourceProjectId === source.id)
          .map((binding) => {
            const target = snapshot.projects.find(
              (project) => project.id === binding.targetProjectId,
            );
            return {
              tool: binding.targetTool,
              projectId: binding.targetProjectId,
              projectName: target?.name || "未登记项目",
            };
          })
      : [];
    return {
      server: "ai-bridge",
      caller: {
        tool: session.tool,
        title: session.title,
        project: source ? { id: source.id, name: source.name } : null,
      },
      targets,
      guidance: {
        trigger:
          "If the current task touches a module owned by another listed target tool and verification is needed, call bridge_consult with that tool; do not ask the human to relay.",
        boundary:
          "The consultation is a separate read-only Worker, not the target original chat. Use bridge_consult_result; do not resubmit while running.",
        routing: targets.length
          ? "The saved project binding chooses the target project."
          : "No target binding is saved; bridge_consult will fall back to the caller project.",
      },
    };
  }

  // 这些 Map/Set 都是进程内状态：连接、配对请求、SSE 流、后台任务和远端会话映射。
  const csrf = randomBytes(32).toString("hex"),
    connections = new Map(),
    requests = new Map(),
    streams = new Set(),
    operations = [],
    incoming = new Map(),
    consultJobs = new Map(),
    limits = normalizeConsultLimits(consultLimits);

  // 重启后恢复历史核对记录，但不会自动重放未完成任务。
  for (const record of store.listConsultations())
    consultJobs.set(record.id, record);
  let agents = {},
    standaloneAgents = {},
    desktopApps = detectDesktopApps(),
    toolsLoading = true,
    host = null,
    revision = 0,
    closed = false,
    saveQueue = Promise.resolve();

  /**
   * 把连接 ID 映射为凭证文件路径。
   *
   * 连接 ID 会直接参与文件路径，因此必须只允许 UUID 格式；
   * 否则恶意 id 可能变成 ../ 路径穿越，读到数据目录之外的文件。
   */
  const file = (id) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Invalid connection");
    return join(dir, "connections", id + ".json");
  };

  /**
   * 读取一个已登记连接的完整凭证。
   *
   * 先检查 connections 里是否登记过该 id，再读磁盘。
   * 这样即使调用方猜到文件名，也不能读取未登记的文件。
   */
  const credential = async (id) => {
    if (!connections.has(id)) throw Error("Unknown connection");
    return JSON.parse(await readFile(file(id), "utf8"));
  };

  /**
   * 保存连接元数据并原子写入凭证文件。
   *
   * 内存里的 connections 只保留 UI 需要的字段，完整 token 留在磁盘文件中。
   * 写入串行化并先写 .tmp 再 rename：
   * - 避免并发写互相覆盖；
   * - 避免进程崩溃后留下半截 JSON；
   * - 文件权限固定为 0600。
   */
  const persist = (c) => {
    connections.set(c.id, {
      id: c.id,
      name: c.name,
      url: c.url,
      status: c.status || "unknown",
      agents: c.agents || {},
      bidirectional: !!c.bidirectional,
      legacy: !!c.legacy,
      peerId: c.peerId,
      deviceId: c.deviceId,
    });
    saveQueue = saveQueue
      .catch(() => {})
      .then(async () => {
        await writeFile(file(c.id) + ".tmp", JSON.stringify(c), {
          mode: 0o600,
        });
        await rename(file(c.id) + ".tmp", file(c.id));
      });
    return saveQueue;
  };

  // 只恢复连接元数据；在线状态和 agents 仍以远端 /health 的实时结果为准。
  for (const name of await readdir(join(dir, "connections"))) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    try {
      const c = JSON.parse(
        await readFile(join(dir, "connections", name), "utf8"),
      );
      connections.set(name.slice(0, -5), {
        id: name.slice(0, -5),
        name: c.remoteName || c.device?.name || new URL(c.url).hostname,
        url: c.url,
        status: "unknown",
        agents: {},
        bidirectional: !!c.bidirectional,
        legacy: c.legacy !== false,
        peerId: c.peerId,
        deviceId: c.deviceId,
      });
    } catch {}
  }

  // incoming-map 记录“远端 peer + 远端会话”到本机会话的映射，避免重复建会话。
  try {
    for (const [k, v] of Object.entries(
      JSON.parse(await readFile(join(dir, "incoming-map.json"), "utf8")),
    ))
      incoming.set(k, v);
  } catch {}

  /**
   * 列出本机可用于配对的局域网 IPv4 地址。
   *
   * 只保留非 internal 的 IPv4；
   * 169.254.* 是链路本地地址，通常不能跨机器访问，所以标记为不推荐。
   */
  const addresses = () =>
    Object.values(networkInterfaces())
      .flat()
      .filter((a) => a.family === "IPv4" && !a.internal)
      .map((a) => ({
        address: a.address,
        kind: a.address.startsWith("10.") ? "private" : "lan",
        recommended: !a.address.startsWith("169.254."),
      }));

  /**
   * 把内部 operation 转成可返回给 UI 的对象。
   *
   * AbortController 和 Promise 不能 JSON 序列化，必须先剥离。
   * compact=true 时连 output 也不返回，避免 SSE 状态快照携带大段日志。
   */
  const publicOperation = (o, compact) => {
    const { controller, promise, resources, output, ...value } = o;
    return compact ? value : { ...value, output };
  };

  /**
   * 把内部核对记录转成 API 返回格式。
   *
   * 列表接口会截断问题和结果，防止一次 status 请求把几十万字符推到前端；
   * 只有 bridge_consult_result 才通过 full=true 返回完整内容。
   * 同时计算已运行时间和距离上次进展的时间，供 UI 和看门狗使用。
   */
  const publicConsult = (record, full = false) => {
    const { fingerprint, ...value } = record,
      now = Date.now(),
      started = Date.parse(record.startedAt),
      last = Date.parse(record.lastProgressAt || record.startedAt);
    return {
      ...value,
      question: full
        ? value.question
        : String(value.question || "").slice(0, 2000),
      result: full ? value.result : String(value.result || "").slice(0, 4000),
      elapsedMs: Number.isFinite(started) ? Math.max(0, now - started) : 0,
      idleMs: Number.isFinite(last) ? Math.max(0, now - last) : 0,
    };
  };

  /**
   * 返回最近 100 条核对记录。
   *
   * 按 startedAt 倒序排列，最新记录在前。
   * 限制 100 条是为了让状态快照大小可控，完整历史仍保存在 workspace 中。
   */
  const consultList = () =>
    [...consultJobs.values()]
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .slice(0, 100)
      .map(publicConsult);

  /**
   * 聚合 UI 所需的完整状态快照。
   *
   * 把 workspace、连接、核对、原生收件箱、配对请求和操作进度合并成一个对象。
   * 安全约束：
   * - host 只暴露配对码和 peer 列表，不暴露 token；
   * - compact 模式不携带 operation 的大段输出；
   * - 项目路径只来自本机已保存项目，不接受远端任意路径。
   */
  const state = (compact = false) => {
    const s = store.snapshot(),
      attention = attentionItems({
        requests: [...requests.values()],
        consultations: [...consultJobs.values()],
        conversations: s.conversations,
        projects: s.projects,
        dismissed: s.settings?.dismissedAttention || [],
      });
    return {
      name: s.device.name,
      ...s,
      attention,
      nativeSessions: nativeInbox?.catalog() || [],
      nativeInbox: (() => {
        const n = nativeInbox.snapshot();
        return { ...n, questions: n.questions.slice(-100) };
      })(),
      agents,
      standaloneAgents,
      desktopApps,
      toolsLoading,
      consultLimits: limits,
      consultations: consultList(),
      addresses: addresses(),
      host: host
        ? {
            code: host.pairing.code,
            port: host.port,
            project: host.project,
            requests: [...requests.values()],
            peers: Object.values(host.state.peers).map(
              ({ id, name, deviceId }) => ({ id, name, deviceId }),
            ),
          }
        : null,
      connections: [...connections.values()],
      conversations: s.conversations.map((c) => ({
        ...c,
        ...(c.connectionId.startsWith("incoming:")
          ? { incoming: true, direction: "incoming" }
          : {}),
      })),
      operations: operations.map((o) => publicOperation(o, compact)),
      operation: operations.length
        ? publicOperation(operations.at(-1), compact)
        : null,
      revision,
    };
  };

  /**
   * 向所有 SSE 客户端广播一个事件。
   *
   * 每个事件都按 SSE 的 data: 格式编码。
   * 慢客户端积压超过 1MB 时直接断开，避免一个卡住的浏览器拖住整个控制面。
   */
  const emit = (event) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of streams) {
      if (res.writableLength > 1000000) {
        res.destroy();
        streams.delete(res);
      } else res.write(data);
    }
  };

  /**
   * 标记状态变化并广播 compact 状态。
   *
   * revision 每次自增，前端可以用它判断是否收到新快照。
   * closed 之后不再广播，避免关闭过程中访问已释放的资源。
   */
  const changed = () => {
    if (closed) return;
    revision++;
    emit({ type: "state", state: state(true) });
  };
  notifyNative = changed;
  let updateCache = null;

  /**
   * 检查 GitHub 最新发布。
   *
   * GitHub API 可能限流且响应较慢，因此结果缓存 5 分钟。
   * updateInfo 只返回版本号、安装包元数据和发布说明，不执行任何下载。
   */
  const checkUpdate = async () => {
    if (updateCache && Date.now() - updateCache.at < 300000)
      return updateCache.info;
    const info = updateInfo(version, await latestRelease());
    updateCache = { at: Date.now(), info };
    return info;
  };

  /**
   * 下载并打开最新 DMG 安装包。
   *
   * 下载前校验：
   * - 发布里确实有 DMG；
   * - 声明大小不超过 300MB。
   * 下载后再次校验响应状态、实际大小和声明大小，
   * 防止把错误页或超大文件写到本地。下载完成后交给系统 open 打开。
   */
  const downloadUpdate = async () => {
    const info = await checkUpdate();
    if (!info.installer) throw Error("当前发布没有可下载的 DMG 安装包");
    if (info.installer.size > 300_000_000)
      throw Error("安装包超过 300MB，已停止下载");
    const folder = join(dir, "updates");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const target = join(folder, info.installer.name.replace(/[^\w.-]/g, "_"));
    const response = await fetch(info.installer.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(600000),
    });
    if (!response.ok) throw Error("下载安装包失败 HTTP " + response.status);
    const data = Buffer.from(await response.arrayBuffer());
    if (
      !data.length ||
      data.length > 300_000_000 ||
      (info.installer.size && data.length !== info.installer.size)
    )
      throw Error("安装包内容与发布信息不一致");
    await writeFile(target, data, { mode: 0o600 });
    spawn("open", [target], { detached: true, stdio: "ignore" }).unref();
    return { path: target, name: info.installer.name, version: info.latest };
  };

  /**
   * 追加一条会话消息并实时广播。
   *
   * workspace 负责持久化；这里额外发 message 事件，
   * 让当前打开的会话可以局部追加，而不是等下一次全量状态刷新。
   */
  const message = (id, input) => {
    const m = store.appendMessage(id, { agent: "", ...input });
    emit({ type: "message", conversationId: id, message: m });
    return m;
  };
  const refreshing = new Map();

  /**
   * 刷新单个 peer 的在线状态和可用工具。
   *
   * 同一个连接可能被心跳、SSE 和 UI 同时触发刷新，
   * 因此用 refreshing Map 复用进行中的 Promise，避免并发打满 /health。
   * 成功时更新 agents/status/device；失败时只标记 offline，不删除凭证。
   */
  const refresh = (id) => {
    if (refreshing.has(id)) return refreshing.get(id);
    const pending = (async () => {
      const c = await credential(id),
        before = JSON.stringify(connections.get(id));
      try {
        const h = await makeClient(c.url, c.token)("/health");
        const current = connections.get(id);
        if (!current) return h;
        Object.assign(current, {
          status: "online",
          agents: h.agents || {},
          legacy: !h.capabilities?.catalog,
          ...(h.device ? { name: h.device.name, deviceId: h.device.id } : {}),
        });
        if (h.device?.name && c.remoteName !== h.device.name) {
          const updated = {
            ...c,
            remoteName: h.device.name,
            deviceId: h.device.id,
          };
          saveQueue = saveQueue
            .catch(() => {})
            .then(async () => {
              await writeFile(file(id) + ".tmp", JSON.stringify(updated), {
                mode: 0o600,
              });
              await rename(file(id) + ".tmp", file(id));
            });
          await saveQueue;
        }
        if (JSON.stringify(current) !== before) changed();
        return h;
      } catch (e) {
        const current = connections.get(id);
        if (current && current.status !== "offline") {
          current.status = "offline";
          changed();
        }
        throw e;
      }
    })().finally(() => refreshing.delete(id));
    refreshing.set(id, pending);
    return pending;
  };

  /**
   * 统一执行一个会真实调用 AI 的后台任务。
   *
   * 所有模型调用都走这里，集中处理四件事：
   * 1. 同一会话只允许一个运行中的操作；
   * 2. 通过 resources 给项目/工具加互斥锁，避免并发写同一 native session；
   * 3. 统一处理完成、失败、取消三种终态；
   * 4. 在终态更新会话状态、落盘并广播 SSE。
   *
   * label 用于 UI 展示，work 是实际逻辑，onSettled 用于核对任务的额外落盘。
   */
  const task = (
    label,
    work,
    {
      conversationId,
      connection,
      resources = [],
      agent,
      id = randomUUID(),
      resourceLimit = 1,
      onSettled,
    } = {},
  ) => {
    // 先取运行中的任务，后面用它做会话级和资源级互斥检查。
    const running = operations.filter((o) => o.status === "running");
    if (
      conversationId &&
      running.some((o) => o.conversationId === conversationId)
    )
      throw Error("该会话已有操作在进行");
    if (
      resources.some(
        (key) =>
          running.filter((o) => o.resources.includes(key)).length >=
          resourceLimit,
      )
    )
      throw Error(
        resourceLimit > 1
          ? "目标工具已达到并发上限，请稍后再试"
          : "该会话或项目工具已有操作在进行",
      );
    const startedMs = Date.now(),
      o = {
        id,
        label,
        status: "running",
        started: new Date(startedMs).toISOString(),
        startedMs,
        output: "",
        conversationId,
        connection,
        resources,
        agent,
        controller: new AbortController(),
      };

    // 先登记再启动 Promise，这样 UI 立刻能看到 running 状态。
    operations.push(o);

    // 只保留最近 30 条操作；优先删除最旧的非运行记录。
    if (operations.length > 30) {
      const done = operations.findIndex((o) => o.status !== "running");
      if (done >= 0) operations.splice(done, 1);
    }
    changed();

    // work 里的异常统一转成 failed，abort 统一转成 cancelled，避免未处理 rejection。
    o.promise = Promise.resolve()
      .then(() => work(o))
      .then(() => {
        o.status = o.controller.signal.aborted ? "cancelled" : "completed";
      })
      .catch((e) => {
        o.status = o.controller.signal.aborted ? "cancelled" : "failed";
        output(o, e.message);
      })
      .finally(() => {
        if (conversationId)
          store.updateConversation(conversationId, { status: o.status });
        if (onSettled) onSettled(o);
        changed();
      });
    return { id: o.id, promise: o.promise };
  };

  /**
   * 追加任务输出并广播 output 事件。
   *
   * 只保留最后 200KB，防止长时间运行的 CLI 把内存和 SSE 撑爆。
   * 每个 chunk 单独广播，UI 可以边跑边显示。
   */
  const output = (o, text) => {
    o.output = (o.output + text + "\n").slice(-200000);
    emit({ type: "output", operationId: o.id, text: text + "\n" });
  };

  /**
   * 启动一次只读跨工具核对。
   *
   * 输入：
   * - session：来源 AI 会话（由 native-mcp 或 UI 提供）；
   * - tool：目标工具；
   * - projectId：可选，显式指定目标项目；
   * - text：要核对的问题。
   *
   * 路由优先级：显式 projectId > 保存的项目绑定 > 来源会话当前项目。
   * 启动前依次做去重、预算、并发三道检查；
   * 通过后创建一个独立 managed 会话，并交给 task 在后台执行。
   */
  consultStart = async ({ session, tool, projectId, text }) => {
    const snapshot = store.snapshot(),
      now = Date.now(),
      source = snapshot.projects.find((p) => {
        try {
          return (
            session.projectPath && p.path === realpathSync(session.projectPath)
          );
        } catch {
          return false;
        }
      });

    // 没有显式 projectId 时，才查项目绑定；绑定决定“这个问题该找哪个仓库”。
    const binding =
      !projectId && source
        ? snapshot.bindings.find(
            (item) =>
              item.sourceProjectId === source.id && item.targetTool === tool,
          )
        : null;
    const project = projectId
      ? snapshot.projects.find((p) => p.id === projectId)
      : binding
        ? snapshot.projects.find((p) => p.id === binding.targetProjectId)
        : source;

    // source 必须是本机已登记项目，否则不允许多工具核对写回来源会话。
    if (!source)
      throw Error("当前 AI 工具目录未登记为项目，请先在 App 中添加该项目");
    if (!project) throw Error("目标项目未登记");
    if (!["claude", "codex", "cursor", "deepseek"].includes(tool))
      throw Error("Target AI tool unavailable");
    if (!Object.hasOwn(agents, tool)) throw Error("Target AI tool unavailable");
    const route = {
      sourceProjectId: source.id,
      sourceProjectName: source.name,
      targetProjectId: project.id,
      targetProjectName: project.name,
      targetTool: tool,
      mode: projectId ? "explicit" : binding ? "binding" : "current",
    };
    const records = [...consultJobs.values()],
      fingerprint = consultFingerprint({
        sourceSessionId: session.id,
        targetTool: tool,
        targetProjectId: project.id,
        text,
      }),
      duplicate = findDuplicate(records, {
        fingerprint,
        now,
        windowMs: limits.duplicateWindowMs,
      });

    // 精确重复的问题直接复用已有 consultId，防止模型重试造成无限 Worker。
    if (duplicate)
      return {
        ...publicConsult(duplicate, true),
        consultId: duplicate.id,
        deduplicated: true,
        notice:
          "The same consultation already exists; use this consultId instead of resubmitting.",
      };

    // 第一道闸：同一来源会话在窗口内的核对次数上限。
    const budget = checkBudget(records, {
      sourceSessionId: session.id,
      now,
      limits,
    });
    if (!budget.allow)
      throw Error(
        `该会话 ${Math.round(budget.windowMs / 60000)} 分钟内已发起 ${budget.limit} 次跨工具核对；已停止继续启动，请先处理已有结果。`,
      );

    // 第二道闸：同一目标工具/项目的并发 Worker 上限。
    const parallel = checkParallel(records, {
      targetTool: tool,
      targetProjectId: project.id,
      limits,
    });
    if (!parallel.allow)
      throw Error(
        `目标工具并发上限为 ${parallel.limit}，已有 ${parallel.used} 个只读核对在运行；请稍后重试。`,
      );
    const threadId = `consult-${session.id}-${tool}-${project.id}`,
      round =
        records.filter((record) => record.threadId === threadId).length + 1,
      id = randomUUID(),
      stamp = new Date(now).toISOString();

    // 每对“来源会话 + 目标工具 + 目标项目”复用一个 managed 会话，延续上下文。
    let target;
    try {
      target = store.getSession(threadId);
    } catch {
      target = store.registerSession({
        id: threadId,
        projectId: project.id,
        tool,
        title: `${session.title} · 跨工具核对`,
        mode: "managed",
        shared: false,
      });
    }
    const record = {
      id,
      threadId,
      sourceSessionId: session.id,
      sourceProjectId: source.id,
      sourceTitle: session.title,
      targetTool: tool,
      targetProjectId: project.id,
      targetProjectName: project.name,
      targetSessionId: target.id,
      question: text,
      status: "running",
      route,
      round,
      startedAt: stamp,
      updatedAt: stamp,
      lastProgressAt: stamp,
      progressEvents: 0,
      outputBytes: 0,
      fingerprint,
    };
    let watchdog,
      notifyAt = 0;
    consultJobs.set(id, record);
    if (consultJobs.size > 100) {
      const stale = [...consultJobs.values()]
        .filter((item) => item.status !== "running")
        .sort((a, b) =>
          String(a.startedAt).localeCompare(String(b.startedAt)),
        )[0];
      if (stale) consultJobs.delete(stale.id);
    }
    let started;
    try {
      started = task(
        "跨工具核对",
        async (o) => {
          // 提示词明确只读边界和单问题范围，避免 Worker 扩展成新的任务链。
          const prompt = `你是 Agents Calling 启动的只读核对 Worker，不是对方原聊天，也不直接与人对话。\n线程：${threadId} · 第 ${round} 轮\n项目：${project.name}（${project.path}）\n来源：${source.name} / ${session.title}\n核对问题：${text}\n只读取证，不修改文件，不执行来源任务，不扩展无关话题。请回答结论、依据文件/函数，以及仍需来源方确认的事项。\n一次只回答当前核对问题；证据不足时，只列出最需要来源方确认的一项，不要扩散成新的任务。`;
          const result = await runner(
            prompt,
            target.nativeSessionId,
            o.controller.signal,
            project.path,
            tool,
            {
              fast: true,
              readOnly: true,

              // 流式输出用于刷新进展时间、累计字节数，并最多每秒推一次 SSE。
              onOutput: (chunk) => {
                const at = Date.now();
                record.lastProgressAt = new Date(at).toISOString();
                record.progressEvents += 1;
                record.outputBytes += Buffer.byteLength(chunk);
                if (at - notifyAt >= 1000) {
                  notifyAt = at;
                  changed();
                }
              },
            },
          );
          if (result.session_id) {
            target.nativeSessionId = result.session_id;
            store.updateSession(target.id, {
              nativeSessionId: result.session_id,
            });
          }

          // 核对结果只保留 40KB；完整输出仍在 operation.output 中。
          record.result = String(result.result).slice(0, 40000);
          record.lastProgressAt = new Date().toISOString();
          output(o, record.result);
        },
        {
          id,
          resources: [`consult-target:${project.id}:${tool}`],
          resourceLimit: limits.maxParallelPerTarget,
          agent: tool,

          // task 结束时统一落盘，确保重启后状态和 UI 一致。
          onSettled: (o) => {
            clearInterval(watchdog);
            if (!record.stopReason) record.status = o.status;
            record.updatedAt = new Date().toISOString();
            if (record.status === "failed")
              record.error = o.output.trim() || record.error;
            try {
              store.saveConsultation(record);
            } catch {}
            changed();
          },
        },
      );
    } catch (e) {
      consultJobs.delete(id);
      throw e;
    }
    try {
      store.saveConsultation(record);
    } catch (e) {
      started.promise.catch(() => {});
      const op = operations.find((item) => item.id === id);
      op?.controller.abort();
      consultJobs.delete(id);
      throw e;
    }
    changed();
    const op = operations.find((item) => item.id === id);

    // 看门狗按“最后进展时间”判断 stalled，不依赖 runner 自己是否超时。
    watchdog = setInterval(
      () => {
        if (record.status !== "running" || record.stopReason)
          return clearInterval(watchdog);
        const progress = checkProgress(record, { now: Date.now(), limits });
        if (!progress.stalled) return;
        record.stopReason = progress.reason;
        record.status = progress.reason;
        record.error =
          progress.reason === "timeout"
            ? "核对超过最长运行时间，已停止。"
            : "长时间没有收到 Worker 进展，已停止以避免挂死。";
        record.updatedAt = new Date().toISOString();
        store.saveConsultation(record);
        op?.controller.abort();
        changed();
        clearInterval(watchdog);
      },
      Math.min(1000, Math.max(50, Math.floor(limits.noProgressMs / 4))),
    );
    watchdog.unref?.();
    return {
      consultId: id,
      threadId,
      status: "running",
      round,
      route,
      budget: {
        used: budget.used,
        limit: budget.limit,
        windowMs: budget.windowMs,
      },
      parallel: { used: parallel.used, limit: parallel.limit },
      notice:
        "Managed read-only consultation started in the background; it is not the target original chat.",
    };
  };

  /**
   * 读取一次核对的结果。
   *
   * 只允许来源会话读取自己的核对，防止跨会话窥探。
   * waitMs 允许模型最多等待一段时间；超时后返回 running + consultId，
   * 并明确要求不要重复提交。
   */
  consultResult = async ({ session, id, waitMs }) => {
    const record = consultJobs.get(id);
    if (!record || record.sourceSessionId !== session.id)
      throw Error("Unknown consultation");
    const op = operations.find((item) => item.id === id);

    // 最多等待 waitMs；超时仍返回 running，让调用方继续用 consultId 查询。
    if (waitMs && record.status === "running" && op)
      await Promise.race([op.promise, pause(waitMs)]);
    const base = {
      ...publicConsult(record, true),
      consultId: id,
      tool: record.targetTool,
      projectId: record.targetProjectId,
    };
    if (record.status === "completed")
      return { ...base, text: record.result || op?.output.trim() || "" };
    if (record.status === "running")
      return {
        ...base,
        notice:
          "Still running; use bridge_consult_result with this consultId; do not resubmit.",
      };
    return {
      ...base,
      error: record.error || op?.output.trim() || record.status,
    };
  };

  /**
   * 人工停止一次只读核对。
   *
   * 只修改本次核对的状态并 abort 对应 operation；
   * 不会停止来源会话，也不会影响其它正在运行的 Worker。
   */
  consultStop = ({ session, id }) => {
    const record = consultJobs.get(id);
    if (!record || record.sourceSessionId !== session.id)
      throw Error("Unknown consultation");
    if (record.status === "running") {
      record.stopReason = "human_stop";
      record.status = "cancelled";
      record.error = "已由人工停止只读核对。";
      record.updatedAt = new Date().toISOString();
      store.saveConsultation(record);
      operations.find((item) => item.id === id)?.controller.abort();
      changed();
    }
    return publicConsult(record);
  };

  /**
   * 停止本机任务，并通知远端停止对应 job。
   *
   * conversationId 为空时停止所有运行中的任务，否则只停该会话。
   * 先 abort 本机 controller，再尽力调用远端 /stop；
   * 远端失败不阻塞本机清理，避免离线 peer 卡住退出流程。
   */
  const stop = async (conversationId) => {
    // 先 abort 本机任务，再尽力通知远端；远端失败不影响本机清理。
    const jobs = operations.filter(
      (o) =>
        o.status === "running" &&
        (!conversationId || o.conversationId === conversationId),
    );
    for (const o of jobs) {
      o.controller.abort();
      if (o.remoteJobId && o.connection && connections.has(o.connection)) {
        const c = await credential(o.connection);
        await makeClient(c.url, c.token)("/stop", { id: o.remoteJobId }).catch(
          () => {},
        );
      }
    }
  };
  const liveChannels = new Map();

  /**
   * 启动 channel 模式的持续协作。
   *
   * channel 模式允许两端收到消息后继续自主发言，
   * 因此把双方工具都登记为资源锁，防止同项目并发改写。
   * 真正的对话循环在 runChannel 中，本函数只做校验、状态更新和任务包装。
   */
  const runChannelConversation = (id, goal) => {
    const c = store.getConversation(id),
      s = store.getSession(c.localSessionId),
      p = store.getProject(c.projectId),
      remoteProject =
        c.connectionId === "local" && c.remoteProjectId
          ? store.getProject(c.remoteProjectId)
          : p;
    if (c.status === "archived" || c.connectionId.startsWith("incoming:"))
      throw Error("Conversation cannot be started");
    if (typeof goal !== "string" || !goal.trim() || goal.length > 10000)
      throw Error("请输入人工指令（最多10000字）");
    if (!Object.hasOwn(agents, s.tool)) throw Error("Local tool unavailable");
    if (c.connectionId !== "local" && !connections.has(c.connectionId))
      throw Error("Unknown connection");
    return task(
      "频道协作",
      async (o) => {
        store.updateConversation(id, { status: "running", stopReason: null });
        message(id, { side: "human", text: goal, deliveryStatus: "delivered" });
        try {
          await runChannel({
            id,
            task: goal,
            store,
            runner,
            message,
            output,
            remote,
            credential,
            agents,
            signal: o.controller.signal,
            op: o,
            register: (live) => liveChannels.set(id, live),
          });
        } finally {
          liveChannels.delete(id);
        }
      },
      {
        conversationId: id,
        connection: c.connectionId,
        resources: [
          "session:" + s.id,
          "tool:" + p.id + ":" + s.tool,
          ...(c.connectionId === "local"
            ? ["tool:" + remoteProject.id + ":" + c.remoteAgent]
            : []),
        ],
      },
    );
  };

  /**
   * 读取本机身份信息。
   *
   * owner 是用户可读名称，name 是设备名；
   * 旧数据可能只有 name，所以这里补一个 owner 回退。
   */
  const device = () => {
    const d = store.snapshot().device;
    return { ...d, owner: d.owner || d.name };
  };

  /**
   * 启动接收远端请求的桥接服务。
   *
   * 只有用户明确调用时才监听 0.0.0.0，端口限制在 1024-65535。
   * 启动前从已保存项目或显式路径解析项目，并创建 bridge。
   * bridge 的回调负责：
   * - 接收配对请求并落盘反向凭证；
   * - 把远端会话映射成本地会话；
   * - 只向 peer 暴露用户 shared 的会话和项目。
   */
  const startHost = async (body) => {
    if (host) throw Error("接收服务已经启动");
    let project = body.projectId
      ? store.getProject(body.projectId)
      : body.project
        ? store.saveProject({
            name: body.project.split("/").filter(Boolean).at(-1) || "Project",
            path: body.project,
          })
        : null;
    const port = Number(body.port || store.snapshot().settings.networkPort);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw Error("Invalid port");

    // bridge 负责远端协议、配对和接收 job；控制面只提供项目、工具和状态回调。
    const b = await createBridge({
      dir: join(dir, "host"),
      project: project?.path,
      agents,
      device: device(),

      // 远端请求不能抢占本机正在使用的同一项目工具。
      runner: async (...args) => {
        const p = store.snapshot().projects.find((p) => p.path === args[3]);
        if (
          p &&
          operations.some(
            (o) =>
              o.status === "running" &&
              o.resources.includes("tool:" + p.id + ":" + args[4]),
          )
        )
          throw Error("Project tool is busy in a local conversation");
        return runner(...args);
      },
      nativeInbox,
      notify: (r) => {
        requests.set(r.id, r);
        changed();
      },
      onChange: (event) => {
        if (event?.type === "pair-revoked" && connections.has(event.peerId)) {
          connections.delete(event.peerId);
          rm(file(event.peerId), { force: true }).catch(() => {});
          nativeInbox.dropPeer(event.peerId).catch(() => {});
        }
        changed();
      },
      catalog: () => {
        const s = store.snapshot();
        const sessions = s.sessions.filter((s) => s.shared);
        return {
          projects: s.projects
            .filter(
              (p) =>
                p.id === project?.id ||
                sessions.some((s) => s.projectId === p.id),
            )
            .map(({ id, name }) => ({ id, name })),
          sessions: sessions.map((s) => ({
            ...s,
            agent: s.tool,
            projectName: store.getProject(s.projectId).name,
            sourceDevice: device().name,
          })),
        };
      },
      resolveProject: (id) => {
        const s = store.snapshot();
        return id === project?.id ||
          s.sessions.some((s) => s.projectId === id && s.shared)
          ? store.getProject(id).path
          : null;
      },
      onApproved: async ({ request, peer }) => {
        if (!request.reverse) return;
        await persist({
          id: peer.id,
          name: request.device?.name || request.name,
          remoteName: request.device?.name,
          url: request.reverse.url,
          token: request.reverse.token,
          peerId: request.reverse.peerId,
          deviceId: request.device?.id,
          bidirectional: false,
          legacy: false,
        });
      },
      onComplete: async (peer) => {
        if (connections.has(peer.id)) {
          const c = await credential(peer.id);
          await persist({ ...c, bidirectional: true });
          await refresh(peer.id);
        }
      },
      onConversation: async ({ peer, conversation, phase, job }) => {
        const key = peer.id + ":" + conversation.id;
        let id = incoming.get(key);
        if (!id) {
          const p = job.projectId ? store.getProject(job.projectId) : project;
          if (!p) throw Error("No incoming project");
          const s = store.registerSession({
            projectId: p.id,
            tool: job.agent,
            title: conversation.title || "Incoming",
            shared: false,
          });
          const c = store.createConversation({
            projectId: p.id,
            localSessionId: s.id,
            title: conversation.title || "Incoming",
            connectionId: "incoming:" + peer.id,
            remoteAgent: conversation.sourceAgent || job.agent,
            rounds: 1,
          });
          id = c.id;
          incoming.set(key, id);
          await writeFile(
            join(dir, "incoming-map.json"),
            JSON.stringify(Object.fromEntries(incoming)),
            { mode: 0o600 },
          );
        }
        if (phase === "received") {
          store.updateConversation(id, { status: "running" });
          message(id, {
            id: job.id + "-received",
            side: "remote",
            agent: conversation.sourceAgent || "",
            text: job.prompt,
            deliveryStatus: "delivered",
          });
        } else {
          if (job.result)
            message(id, {
              id: job.id + "-reply",
              side: "local",
              agent: job.agent,
              text: job.result,
              deliveryStatus: "completed",
            });
          else if (job.error)
            message(id, {
              id: job.id + "-error",
              side: "system",
              text: job.error,
              deliveryStatus: "failed",
            });
          store.updateConversation(id, {
            status:
              phase === "completed"
                ? "completed"
                : job.status === "cancelled"
                  ? "cancelled"
                  : "failed",
          });
        }
        changed();
      },
    });
    try {
      await new Promise((yes, no) => {
        // 端口冲突等监听错误直接回传给调用方，不要留下半启动的 host。
        b.server.once("error", no);
        b.server.listen(port, "0.0.0.0", yes);
      });
    } catch (e) {
      b.server.close();
      throw e;
    }
    host = { ...b, port, project: project?.path };
    changed();
  };

  /**
   * 向另一台电脑提交任务并轮询结果。
   *
   * 跨电脑调用是“提交 job + 轮询”的模型，不是长连接。
   * 提交后每 250ms 查询一次，最多 10 分钟；
   * 取消时立即停止轮询，并把远端 jobId 从 operation 上清掉。
   */
  const remote = async (c, prompt, conv, o, diagnostic = false) => {
    if (o.controller.signal.aborted) throw Error("cancelled");
    const call = makeClient(c.url, c.token),
      id = randomUUID();
    o.remoteJobId = id;
    await call("/turn", {
      id,
      prompt,
      room: conv?.id || "diagnostic",
      agent: conv?.remoteAgent || "claude",
      diagnostic,
      ...(conv?.remoteProjectId ? { projectId: conv.remoteProjectId } : {}),
      ...(conv?.localSessionId
        ? {
            conversation: {
              id: conv.id,
              title: conv.title,
              sourceDevice: device().name,
              sourceAgent: store.getSession(conv.localSessionId).tool,
              projectName: store.getProject(conv.projectId).name,
            },
          }
        : {}),
    });
    for (let i = 0; i < 2400; i++) {
      if (o.controller.signal.aborted) throw Error("cancelled");
      const job = await call("/jobs/" + id);
      if (job.status === "completed") {
        delete o.remoteJobId;
        return job;
      }
      if (job.status !== "running") {
        delete o.remoteJobId;
        throw Error(job.error || job.status);
      }
      await pause(250);
    }
    throw Error("Remote response timeout");
  };

  /**
   * 执行 meeting 模式的固定轮次协作。
   *
   * 流程：
   * 1. 本机 AI 先回复；
   * 2. 把回复交给目标 AI（同项目直接 runner，跨电脑走 remote job）；
   * 3. 重复 rounds 轮；
   * 4. 最后让本机 AI 收口，输出结论、分歧和需要人类决定的事项。
   *
   * 启动前检查项目工具是否正被接收服务占用，避免两个方向同时写同一会话。
   */
  const runConversation = (id, goal) => {
    const c = store.getConversation(id),
      s = store.getSession(c.localSessionId),
      p = store.getProject(c.projectId),
      remoteProject =
        c.connectionId === "local" && c.remoteProjectId
          ? store.getProject(c.remoteProjectId)
          : p;
    if (c.status === "archived" || c.connectionId.startsWith("incoming:"))
      throw Error("Conversation cannot be started");
    if (typeof goal !== "string" || !goal.trim() || goal.length > 10000)
      throw Error("请输入人工指令（最多10000字）");
    if (!Object.hasOwn(agents, s.tool)) throw Error("Local tool unavailable");
    if (c.connectionId !== "local" && !connections.has(c.connectionId))
      throw Error("Unknown connection");
    if (
      host &&
      Object.values(host.state.jobs).some(
        (j) =>
          j.status === "running" &&
          ((j.agent === s.tool &&
            (j.projectId === p.id ||
              (!j.projectId && host.project === p.path))) ||
            (c.connectionId === "local" &&
              j.agent === c.remoteAgent &&
              (j.projectId === remoteProject.id ||
                (!j.projectId && host.project === remoteProject.path)))),
      )
    )
      throw Error("Project tool is busy receiving a peer request");
    const result = task(
      "执行人工指令",
      async (o) => {
        store.updateConversation(id, { status: "running" });
        message(id, { side: "human", text: goal, deliveryStatus: "delivered" });
        let prompt = goal,
          session = s.nativeSessionId;
        const siblingId = "remote-" + c.id;
        let sibling =
          c.connectionId === "local"
            ? store.snapshot().sessions.find((s) => s.id === siblingId)
            : null;
        if (c.connectionId === "local" && !sibling)
          sibling = store.registerSession({
            id: siblingId,
            projectId: remoteProject.id,
            tool: c.remoteAgent,
            title: c.title + " · remote",
            mode: "managed",
            shared: false,
          });
        if (sibling && sibling.projectId !== remoteProject.id)
          throw Error("Remote session belongs to a different project");
        let remoteSession = sibling?.nativeSessionId || null;
        for (let n = 0; n < c.rounds; n++) {
          if (o.controller.signal.aborted) throw Error("cancelled");
          const a = await runner(
            prompt,
            session,
            o.controller.signal,
            p.path,
            s.tool,
            { fast: true },
          );
          session = a.session_id || session;
          store.updateSession(s.id, { nativeSessionId: session });
          message(id, {
            side: "local",
            agent: s.tool,
            text: a.result,
            deliveryStatus: "completed",
          });
          output(o, a.result);
          const b =
            c.connectionId === "local"
              ? await runner(
                  a.result,
                  remoteSession,
                  o.controller.signal,
                  remoteProject.path,
                  c.remoteAgent,
                  { fast: true },
                )
              : await remote(await credential(c.connectionId), a.result, c, o);
          if (sibling) {
            remoteSession = b.session_id || remoteSession;
            store.updateSession(sibling.id, { nativeSessionId: remoteSession });
          }
          message(id, {
            side: "remote",
            agent: c.remoteAgent,
            text: b.result,
            deliveryStatus: "completed",
          });
          output(o, b.result);
          prompt = `人类目标：${goal}\n对方回复：${b.result}`;
        }
        const final = await runner(
          `请综合本轮讨论，给出结论、分歧和需要人类决定的事项。\n${prompt}`,
          session,
          o.controller.signal,
          p.path,
          s.tool,
          { fast: true },
        );
        store.updateSession(s.id, {
          nativeSessionId: final.session_id || session,
        });
        message(id, {
          side: "local",
          agent: s.tool,
          text: final.result,
          deliveryStatus: "completed",
        });
        output(o, final.result);
      },
      {
        conversationId: id,
        connection: c.connectionId,
        resources: [
          "session:" + s.id,
          "tool:" + p.id + ":" + s.tool,
          ...(c.connectionId === "local"
            ? ["tool:" + remoteProject.id + ":" + c.remoteAgent]
            : []),
        ],
      },
    );
    return result;
  };

  /**
   * 本机 UI 与 API 的 HTTP 入口。
   *
   * 统一安全边界：
   * - Host 必须是 127.0.0.1，防 DNS rebinding；
   * - 静态资源只允许 desktop.html/js/css；
   * - API 必须带 CSRF 头，POST 还要求同源 Origin；
   * - 请求体限制 32KB。
   *
   * 路由分为静态资源、GET 状态/SSE、POST 操作三大类。
   */
  const server = http.createServer(async (req, res) => {
    /**
     * 发送 JSON 响应。
     *
     * 统一设置 no-store，防止浏览器缓存状态或错误响应。
     */
    const send = (code, value) => {
      res.writeHead(code, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (req.headers.host !== new URL(origin).host)
        return send(403, { error: "Invalid local host" });
      const url = new URL(req.url, origin),
        path = url.pathname;
      if (
        req.method === "GET" &&
        ["/", "/desktop.js", "/desktop.css"].includes(path)
      ) {
        const html = path === "/";
        let data = await readFile(
          join(source, html ? "desktop.html" : path.slice(1)),
          "utf8",
        );
        if (html) data = data.replace("__BRIDGE_CSRF__", csrf);
        res.writeHead(200, {
          "content-type": html
            ? "text/html; charset=utf-8"
            : path.endsWith(".js")
              ? "text/javascript; charset=utf-8"
              : "text/css; charset=utf-8",
          "cache-control": "no-store",
          "x-frame-options": "DENY",
          "content-security-policy":
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        });
        res.end(data);
        return;
      }
      if (
        req.headers["x-bridge-ui"] !== csrf ||
        (req.method === "POST" && req.headers.origin !== origin)
      )
        return send(403, { error: "Invalid local UI session" });
      if (req.method === "GET" && path === "/api/version")
        return send(200, { version });
      if (req.method === "GET" && path === "/api/update")
        return send(200, await checkUpdate());
      if (req.method === "GET") {
        if (path === "/api/status") return send(200, state());

        // SSE 先推一份 compact state，之后靠 changed() 推增量状态和输出。
        if (path === "/api/events") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
          });
          res.write(
            `data: ${JSON.stringify({ type: "state", state: state(true) })}\n\n`,
          );
          streams.add(res);
          req.on("close", () => streams.delete(res));
          return;
        }
        if (path === "/api/conversations/messages")
          return send(
            200,
            store.messages(url.searchParams.get("id"), {
              after: Number(url.searchParams.get("after") || 0),
              limit: Number(url.searchParams.get("limit") || 100),
            }),
          );
        if (path === "/api/native/sessions") {
          const c = await credential(url.searchParams.get("id"));
          return send(
            200,
            await makeClient(c.url, c.token)("/native/sessions"),
          );
        }
        if (path === "/api/peer/catalog") {
          const c = await credential(url.searchParams.get("id"));
          return send(200, await makeClient(c.url, c.token)("/catalog"));
        }
        return send(404, { error: "Unknown endpoint" });
      }
      if (req.method !== "POST")
        return send(404, { error: "Unknown endpoint" });

      // 请求体上限 32KB；正常表单远小于这个值。
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 32000) throw Error("Request too large");
      }
      const body = JSON.parse(raw || "{}");
      let result = { ok: true };
      if (path === "/api/update/download") {
        result = await downloadUpdate();
        send(200, result);
        return;
      }
      if (path === "/api/device") result = store.setDevice(body);
      else if (path === "/api/settings") result = store.updateSettings(body);
      else if (path === "/api/projects/save") result = store.saveProject(body);
      else if (path === "/api/projects/delete") store.deleteProject(body.id);
      else if (path === "/api/bindings/save") result = store.saveBinding(body);
      else if (path === "/api/bindings/delete")
        result = store.deleteBinding(body);
      else if (path === "/api/conversations/create") {
        const mode = body.mode ?? "meeting";
        if (
          !["codex", "claude", "cursor", "deepseek"].includes(
            body.localAgent,
          ) ||
          !["codex", "claude", "cursor", "deepseek"].includes(
            body.remoteAgent,
          ) ||
          !["meeting", "channel"].includes(mode) ||
          (mode === "meeting" &&
            (!Number.isInteger(body.rounds ?? 1) ||
              (body.rounds ?? 1) < 1 ||
              (body.rounds ?? 1) > 5))
        )
          throw Error("Invalid conversation tools, mode or rounds");
        store.getProject(body.projectId);
        if (body.connectionId === "local" && body.remoteProjectId)
          store.getProject(body.remoteProjectId);
        if (
          body.connectionId !== "local" &&
          !connections.has(body.connectionId)
        )
          throw Error("Unknown connection");
        const session = store.registerSession({
          projectId: body.projectId,
          tool: body.localAgent,
          title: body.title,
          mode: "managed",
          shared: false,
        });
        result = store.createConversation({
          ...body,
          mode,
          localSessionId: session.id,
        });
      } else if (path === "/api/conversations/run")
        result =
          store.getConversation(body.id).mode === "channel"
            ? runChannelConversation(body.id, body.goal)
            : runConversation(body.id, body.goal);
      else if (path === "/api/conversations/message") {
        const live = liveChannels.get(body.id);
        if (!live) throw Error("频道未在运行");
        live.send(body.text);
        result = { ok: true };
      } else if (path === "/api/conversations/stop") await stop(body.id);
      else if (path === "/api/consult/stop") {
        const record = consultJobs.get(body.id);
        if (!record) throw Error("Unknown consultation");
        result = consultStop({
          session: { id: record.sourceSessionId },
          id: body.id,
        });
      } else if (path === "/api/attention/dismiss")
        result = { dismissed: store.dismissAttention(body.id) };
      else if (path === "/api/conversations/archive") {
        if (
          operations.some(
            (o) => o.conversationId === body.id && o.status === "running",
          )
        )
          throw Error("Stop conversation first");
        result = store.updateConversation(body.id, { status: "archived" });
      } else if (path === "/api/host/start") await startHost(body);
      else if (path === "/api/host/rotate") {
        if (!host) throw Error("先启动接收服务");
        result = { code: host.pairing.rotate() };
      } else if (path === "/api/host/approve") {
        if (!host) throw Error("先启动接收服务");
        await host.pairing.approve(body.id, body.accept === true);
        requests.delete(body.id);
      } else if (path === "/api/host/revoke") {
        if (connections.has(body.id)) {
          const c = await credential(body.id);
          await makeClient(c.url, c.token)("/pair/revoke", {}).catch(() => {});
          if (host && host.state.peers[body.id]) {
            host.cancel(body.id);
            await host.pairing.revoke(body.id);
            await nativeInbox.dropPeer(body.id);
          }
          await rm(file(body.id), { force: true });
          connections.delete(body.id);
        } else {
          if (!host) throw Error("先启动接收服务");
          host.cancel(body.id);
          await host.pairing.revoke(body.id);
          await nativeInbox.dropPeer(body.id);
        }
      } else if (path === "/api/refresh") result = await refresh(body.id);
      else if (path === "/api/stop") {
        host?.cancel();
        await stop();

        // 配对只接受私网 IPv4 明文 HTTP；公网地址、路径、查询串和凭证一律拒绝。
      } else if (path === "/api/pair") {
        const u = new URL(body.url);
        if (
          u.protocol !== "http:" ||
          u.username ||
          u.password ||
          u.pathname !== "/" ||
          u.search ||
          u.hash ||
          !/^((10|127)\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(
            u.hostname,
          )
        )
          throw Error("请输入可信内网 IPv4 地址");
        if (!/^\d{8}$/.test(body.code)) throw Error("请输入8位配对码");
        result = task("连接与配对", async (o) => {
          let grant, local;
          if (!u.hostname.startsWith("127.")) {
            local = await new Promise((yes, no) => {
              const socket = createConnection({
                host: u.hostname,
                port: Number(u.port || 80),
              });
              socket.setTimeout(5000, () =>
                socket.destroy(Error("Connection timeout")),
              );
              socket.once("error", no);
              socket.once("connect", () => {
                const address = socket.localAddress?.replace(/^::ffff:/, "");
                socket.destroy();
                yes(address);
              });
            });
            if (!host) await startHost({ projectId: body.projectId });
          }
          const duplex = !!(host && local && !u.hostname.startsWith("127."));
          if (duplex)
            grant = await host.pairing.grant({
              name: device().name,
              deviceId: device().id,
              owner: device().owner,
            });
          try {
            const call = makeClient(u.href, ""),
              request = await call("/pair/start", {
                code: body.code,
                name: body.name || device().name,
                device: device(),
                ...(grant
                  ? {
                      reverse: {
                        url: `http://${local}:${host.port}`,
                        token: grant.token,
                        peerId: grant.peerId,
                      },
                    }
                  : {}),
              });
            for (let i = 0; i < 1200; i++) {
              if (o.controller.signal.aborted) throw Error("cancelled");
              const approved = await call("/pair/result", request);
              if (approved.status === "denied") throw Error("Pairing denied");
              if (approved.status === "approved") {
                const id = grant?.peerId || randomUUID();
                const c = {
                  id,
                  name: approved.device?.name || u.hostname,
                  remoteName: approved.device?.name,
                  url: u.href,
                  token: approved.token,
                  peerId: approved.peerId,
                  deviceId: approved.device?.id,
                  bidirectional: false,
                  legacy: !approved.device,
                };
                await persist(c);
                if (grant) {
                  await host.pairing.activate(grant.peerId);
                  await makeClient(c.url, c.token)("/pair/complete", {});
                  await persist({ ...c, bidirectional: true });
                }
                await refresh(id);
                return;
              }
              await pause(250);
            }
            throw Error("Pairing expired");
          } catch (e) {
            if (grant) {
              await host.pairing.revoke(grant.peerId).catch(() => {});
              connections.delete(grant.peerId);
              await rm(file(grant.peerId), { force: true });
            }
            throw e;
          }
        });

        // desktopOnly 只影响 MCP 配置写入格式，不影响工具是否可用。
      } else if (path === "/api/tools/connect") {
        if (toolsLoading) await detection;
        const p = store.getProject(body.projectId),
          tool = body.agent || body.tool;
        if (!["claude", "cursor", "codex", "deepseek"].includes(tool))
          throw Error(
            "Native connector configuration supports Claude, Cursor, Codex or DeepSeek Harness",
          );
        if (
          (body.targetTool !== undefined ||
            body.targetProjectId !== undefined) &&
          (!body.targetTool || !body.targetProjectId)
        )
          throw Error("目标工具和目标项目需要一起选择");
        const { configureNativeTool } = await import(
          "../native/native-config.mjs"
        );
        result = await configureNativeTool({
          project: p.path,
          tool,
          dir,
          desktopOnly: !!desktopApps[tool] && !standaloneAgents[tool],
        });
        if (body.targetTool)
          store.saveBinding({
            sourceProjectId: p.id,
            targetTool: body.targetTool,
            targetProjectId: body.targetProjectId,
          });
      } else if (path === "/api/tools/diagnose") {
        const p = store.getProject(body.projectId);
        if (!Object.hasOwn(agents, body.agent))
          throw Error("Local tool unavailable");
        result = task(
          "诊断本机 AI",
          async (o) => {
            const r = await runner(
              "请仅回复 BRIDGE_OK",
              null,
              o.controller.signal,
              p.path,
              body.agent,
              { diagnostic: true },
            );
            output(o, r.result);
          },
          { agent: body.agent, resources: ["tool:" + p.id + ":" + body.agent] },
        );
      } else if (path === "/api/discuss") {
        if (!connections.has(body.id)) throw Error("Unknown connection");
        if (
          typeof body.goal !== "string" ||
          !body.goal.trim() ||
          body.goal.length > 10000 ||
          !Number.isInteger(body.rounds) ||
          body.rounds < 1 ||
          body.rounds > 5 ||
          !["codex", "claude", "cursor", "deepseek"].includes(
            body.localAgent,
          ) ||
          !["codex", "claude", "cursor", "deepseek"].includes(body.remoteAgent)
        )
          throw Error("Invalid discussion");
        const p = body.projectId
          ? store.getProject(body.projectId)
          : store.saveProject({ name: "Project", path: body.project });
        const session = store.registerSession({
          projectId: p.id,
          tool: body.localAgent,
          title: body.room || "Discussion",
        });
        const conv = store.createConversation({
          title: body.room || "Discussion",
          projectId: p.id,
          localSessionId: session.id,
          connectionId: body.id,
          remoteAgent: body.remoteAgent,
          remoteProjectId: body.remoteProjectId,
          rounds: body.rounds,
        });
        result = runConversation(conv.id, body.goal);
      } else if (["/api/check", "/api/diagnose"].includes(path)) {
        const c = await credential(body.id);
        const h = await refresh(body.id);
        if (!Object.hasOwn(h.agents, body.remoteAgent))
          throw Error("Remote tool unavailable");
        const localProject =
          path !== "/api/diagnose"
            ? body.projectId
              ? store.getProject(body.projectId)
              : store.saveProject({ name: "Project", path: body.project })
            : null;
        result = task(
          "检测 AI 与会话",
          async (o) => {
            let prompt = "请仅回复 BRIDGE_OK";
            if (path !== "/api/diagnose") {
              const p = localProject;
              if (!Object.hasOwn(agents, body.localAgent))
                throw Error("Local tool unavailable");
              const r = await runner(
                prompt,
                null,
                o.controller.signal,
                p.path,
                body.localAgent,
                {},
              );
              output(o, r.result);
            }
            const r = await remote(
              c,
              prompt,
              { id: "diagnostic", remoteAgent: body.remoteAgent },
              o,
              true,
            );
            output(o, r.result);
          },
          {
            connection: body.id,
            resources: localProject
              ? ["tool:" + localProject.id + ":" + body.localAgent]
              : [],
          },
        );
      } else return send(404, { error: "Unknown endpoint" });
      if (path !== "/api/refresh") changed();
      send(200, result);
    } catch (e) {
      if (!res.headersSent) send(400, { error: e.message });
      else res.destroy();
    }
  });
  try {
    // 缓存只用来让首屏立刻有内容；真实检测随后会覆盖它。
    const cached = JSON.parse(
      await readFile(join(dir, "agents-cache.json"), "utf8"),
    );
    if (toolsLoading) Object.assign(agents, cached);
  } catch {}

  // 两路检测分开：agents 包含桌面 App 内置 runtime，standaloneAgents 只算独立 CLI。
  const detection = Promise.all([
    Promise.resolve()
      .then(detect)
      .then(async (found) => {
        if (closed) return;
        for (const key of Object.keys(agents)) delete agents[key];
        Object.assign(agents, found || {});
        desktopApps = detectDesktopApps();
        await writeFile(
          join(dir, "agents-cache.json"),
          JSON.stringify(agents),
          { mode: 0o600 },
        );
        changed();
      }),
    Promise.resolve()
      .then(detectStandalone)
      .then((standalone) => {
        if (closed) return;
        for (const key of Object.keys(standaloneAgents))
          delete standaloneAgents[key];
        Object.assign(standaloneAgents, standalone || {});
        changed();
      }),
  ])
    .catch(() => {})
    .finally(() => {
      toolsLoading = false;
      changed();
      if (!closed && store.snapshot().settings.autoStartHost && !host)
        startHost({
          projectId: store.snapshot().settings.selectedProjectId || undefined,
        }).catch(() => {});
    });

  // 心跳既刷新 peer 在线状态，也给 SSE 连接发注释帧保活。
  const heartbeat = setInterval(() => {
    for (const id of connections.keys()) refresh(id).catch(() => {});
    for (const res of streams) res.write(": keepalive\n\n");
  }, healthInterval);
  heartbeat.unref();
  return {
    server,
    csrf,
    store,

    /**
     * 关闭控制面并释放所有资源。
     *
     * 关闭顺序：
     * 1. 标记 closed，停止心跳和新广播；
     * 2. 停止运行中的任务；
     * 3. 结束 SSE 流；
     * 4. 关闭接收服务；
     * 5. 等待任务、刷新和落盘队列结束；
     * 6. 关闭原生收件箱、HTTP server 和 workspace。
     *
     * 先停任务再关存储，避免退出时还有写入操作。
     */
    async close() {
      closed = true;
      clearInterval(heartbeat);
      await stop().catch(() => {});
      for (const res of streams) res.end();
      streams.clear();
      if (host) {
        host.cancel();
        await new Promise((r) => host.server.close(r));
      }
      await Promise.allSettled(operations.map((o) => o.promise));
      await Promise.allSettled([...refreshing.values()]);
      await saveQueue;
      await nativeInbox.close();
      await new Promise((r) => server.close(r));
      store.close();
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const dir =
    process.argv[2] ||
    join(process.env.HOME, "Library", "Application Support", "AI Bridge");
  // Swift 外壳会传入自己的 PID；CLI 直接启动时没有这个参数。
  // 这个归属信息让下一次启动能区分“仍在使用的后台”和“App 崩溃后遗留的后台”。
  const appPid = Number(process.argv[3]) || null;
  const runtimeFile = join(dir, "ui-runtime.json");
  const runtimeNonce = randomUUID();
  const control = await createControl({ dir });

  /**
   * 删除本进程写下的 UI 运行描述。
   *
   * 只有 nonce 匹配时才删除，避免误删后来接管的后台描述；
   * 正常退出和收到 SIGINT/SIGTERM 时都会调用。
   */
  const clearRuntime = async () => {
    try {
      const owner = JSON.parse(await readFile(runtimeFile, "utf8"));
      if (owner.nonce === runtimeNonce) await rm(runtimeFile, { force: true });
    } catch {}
  };

  control.server.listen(0, "127.0.0.1", async () => {
    const url = `http://127.0.0.1:${control.server.address().port}`;

    // 运行描述只给同用户的本机 App 读取：端口、CSRF、PID 和版本。
    try {
      await writeFile(
        runtimeFile,
        JSON.stringify({
          pid: process.pid,
          appPid,
          url,
          token: control.csrf,
          nonce: runtimeNonce,
          version,
          startedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
    } catch (error) {
      // 描述写失败不影响当前启动，App 仍可通过 stdout 标记加载界面。
      console.error("Cannot write UI runtime descriptor:", error.message);
    }
    console.log(`BRIDGE_UI_READY=${url}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      try {
        await control.close();
      } finally {
        await clearRuntime();
        process.exit(0);
      }
    });
}
