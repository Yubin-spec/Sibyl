/**
 * 本地持久化层（SQLite）。
 *
 * 负责设备身份、设置、项目、会话、会话绑定、消息、核对记录和恢复状态。
 * 设计原则：
 * - 所有写操作走事务，避免会话和消息出现半写入状态；
 * - 数据库和目录权限收紧到 0600/0700；
 * - 重启时把“running”记录标记为中断，绝不自动重放可能已经执行过的任务；
 * - 本层只做校验和保存，不调用模型、不访问网络。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  canonicalProjectPath,
  projectKey,
} from "../platform/project-path.mjs";

const tools = ["claude", "codex", "cursor", "deepseek"];
const statuses = [
  "idle",
  "running",
  "completed",
  "failed",
  "cancelled",
  "archived",
];
// 以下 validate 辅助函数是信任边界：所有来自 UI/MCP 的写入都先经过这里。
const limitKeys = {
  maxMessages: [1, 200],
  maxTurnsPerAgent: [1, 50],
  maxDurationMs: [1000, 86400000],
  idleTimeoutMs: [1000, 86400000],
  duplicateLimit: [2, 10],
};
const defaults = {
  page: "conversations",
  selectedProjectId: "",
  closeToTray: true,
  autoStartHost: false,
  networkPort: 47831,
};

/**
 * 校验字符串字段。
 *
 * empty=false 时要求非空；empty=true 时允许空串。
 * 所有写库入口都先过这里，避免把 undefined、数字或超长异常值写进 SQLite。
 */
function text(value, field, empty = false) {
  if (typeof value !== "string" || (!empty && !value.trim()))
    throw new Error(`Invalid ${field}`);
  return value;
}

/**
 * 校验枚举字段。
 *
 * tools、status、mode 等字段只允许固定集合，防止拼写错误进入持久化数据。
 */
function oneOf(value, values, field) {
  if (!values.includes(value)) throw new Error(`Invalid ${field}`);
  return value;
}

/**
 * 校验整数范围。
 *
 * 用于端口、轮次、分页大小等数值；NaN、浮点数和小数都会被拒绝。
 */
function integer(value, min, max, field) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${field}`);
  return value;
}

/**
 * 校验布尔字段。
 *
 * 设置项必须是真正的 boolean，避免 "false" 字符串被当成 true。
 */
function boolean(value, field) {
  if (typeof value !== "boolean") throw new Error(`Invalid ${field}`);
  return value;
}

/**
 * 校验补丁对象只包含允许字段。
 *
 * 所有 update/patch 入口都用它拒绝未知字段，防止调用方误传敏感字段或拼错字段。
 */
function keys(patch, allowed) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("Expected object");
  for (const key of Object.keys(patch))
    if (!allowed.includes(key)) throw new Error(`Unsupported field: ${key}`);
}

/**
 * 校验 channel 模式的消息/轮次/超时限制。
 *
 * 返回只包含调用方显式设置的字段；未设置的项保持 null，让上层使用默认值。
 */
function limits(value) {
  if (value == null) return null;
  keys(value, Object.keys(limitKeys));
  const out = {};
  for (const [key, [min, max]] of Object.entries(limitKeys))
    if (value[key] !== undefined) out[key] = integer(value[key], min, max, key);
  return out;
}

/**
 * 校验双方消息游标。
 *
 * cursor 是非负整数，用于 channel 模式下判断哪些消息已经处理过。
 */
function cursors(value) {
  keys(value, ["local", "remote"]);
  return {
    local: integer(value.local ?? 0, 0, Number.MAX_SAFE_INTEGER, "cursor"),
    remote: integer(value.remote ?? 0, 0, Number.MAX_SAFE_INTEGER, "cursor"),
  };
}

/**
 * 统一的时间戳格式。
 *
 * 所有记录都用 ISO 字符串，前端可以直接排序和展示。
 */
const now = () => new Date().toISOString();

/**
 * 打开或初始化一个数据目录。
 *
 * 数据库使用 WAL 之外的单文件 SQLite，并把目录权限限制为 0700。
 * 首次创建后写入设备身份、默认设置、空绑定和空核对列表。
 */
export async function openWorkspace(dir) {
  // 数据目录只允许当前用户访问；数据库文件随后再收紧到 0600。
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "workspace.sqlite");
  const db = new DatabaseSync(file);
  await chmod(file, 0o600);

  // 外键保证会话/消息不会引用不存在的项目；busy_timeout 让并发写入稍等而不是立刻失败。
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`);

  // schema 版本高于当前代码时拒绝启动，避免新库被旧代码写坏。
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version > 1) {
    db.close();
    throw new Error("Unsupported workspace schema version");
  }
  // 所有多表写入都走 BEGIN IMMEDIATE，失败时整体回滚，避免会话/消息半写入。

  /**
   * 在一个立即事务里执行写操作。
   *
   * BEGIN IMMEDIATE 会尽早拿写锁，避免两个进程同时改同一张表；
   * 任何异常都 ROLLBACK，保证会话、消息和元数据不会半写入。
   */
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  try {
    transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), localSessionId TEXT NOT NULL REFERENCES sessions(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (conversationId TEXT NOT NULL REFERENCES conversations(id), id TEXT NOT NULL, offset INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(conversationId,id), UNIQUE(conversationId,offset));
        PRAGMA user_version=1;`);
      db.prepare("INSERT OR IGNORE INTO meta VALUES (?,?)").run(
        "device",
        JSON.stringify({ id: randomUUID(), name: hostname(), owner: "" }),
      );
      db.prepare("INSERT OR IGNORE INTO meta VALUES (?,?)").run(
        "settings",
        JSON.stringify(defaults),
      );
      db.prepare("INSERT OR IGNORE INTO meta VALUES (?,?)").run(
        "bindings",
        JSON.stringify([]),
      );
      db.prepare("INSERT OR IGNORE INTO meta VALUES (?,?)").run(
        "consultations",
        JSON.stringify([]),
      );
      // 上次进程退出时仍在 running 的会话不能自动继续，否则可能重复执行副作用。

      // 重启时不能自动继续 running 会话，否则可能重复执行已经产生副作用的模型调用。
      for (const row of db.prepare("SELECT id,data FROM conversations").all()) {
        const record = JSON.parse(row.data);
        if (record.status === "running") {
          record.status = "failed";
          record.updatedAt = now();
          db.prepare("UPDATE conversations SET data=? WHERE id=?").run(
            JSON.stringify(record),
            row.id,
          );
        }
      }
    });
  } catch (error) {
    db.close();
    throw error;
  }

  /**
   * 读取 meta 表中的 JSON 对象。
   *
   * device、settings、bindings、consultations 都存在 meta 表里。
   */
  const meta = (key) =>
    JSON.parse(db.prepare("SELECT data FROM meta WHERE key=?").get(key).data);

  /**
   * 写入 meta 表中的 JSON 对象。
   *
   * 只更新 data，不插入新 key；初始化阶段负责 INSERT OR IGNORE。
   */
  const putMeta = (key, value) =>
    db
      .prepare("UPDATE meta SET data=? WHERE key=?")
      .run(JSON.stringify(value), key);
  const consultations = meta("consultations");

  // 只读核对同样不自动重放：统一标记 interrupted，提示用户重新发起或检查已有结果。
  for (const record of consultations)
    if (record.status === "running") {
      record.status = "interrupted";
      record.error = "后台已重启；该核对线程未完成，请重新发起或检查已有结果。";
      record.updatedAt = now();
    }
  if (consultations.some((record) => record.status === "interrupted"))
    putMeta("consultations", consultations);

  /**
   * 按 id 读取一条带 JSON data 的记录。
   *
   * 表名由内部常量传入，id 仍会经过 text() 校验；
   * 找不到记录时抛错，让调用方明确知道引用不存在。
   */
  const get = (table, id) => {
    const row = db
      .prepare(`SELECT data FROM ${table} WHERE id=?`)
      .get(text(id, "id"));
    if (!row) throw new Error(`${table} record not found: ${id}`);
    return JSON.parse(row.data);
  };

  /**
   * 按插入顺序读取整张表。
   *
   * 项目、会话、会话记录都按 rowid 返回，保证 UI 顺序稳定。
   */
  const list = (table) =>
    db
      .prepare(`SELECT data FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => JSON.parse(row.data));

  /**
   * 更新一条记录的 JSON data。
   *
   * 只做 UPDATE；新增记录由各自的 register/create/insert 方法负责。
   */
  const save = (table, record) => {
    db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(
      JSON.stringify(record),
      record.id,
    );
    return record;
  };

  /**
   * 校验并补全会话记录。
   *
   * tool/title/mode/shared/capability 都必须合法；
   * native-inbox 模式如果没有 nativeSessionId，就标记为 unregistered，
   * 避免 UI 把“声明接入”误显示成“已经能收信”。
   */
  function validateSession(record) {
    oneOf(record.tool, tools, "tool");
    text(record.title, "title");
    oneOf(record.mode, ["managed", "native-inbox"], "mode");
    boolean(record.shared, "shared");
    if (record.nativeSessionId !== null)
      text(record.nativeSessionId, "nativeSessionId");
    oneOf(
      record.capability,
      ["managed", "inbox", "unregistered"],
      "capability",
    );
    if (record.mode === "native-inbox" && !record.nativeSessionId)
      record.capability = "unregistered";
    return record;
  }
  return {
    /**
     * 返回 UI 需要的只读快照。
     *
     * 不返回 messages 和 consultations 大列表；
     * 消息按会话分页读取，核对记录走 listConsultations，避免 status 响应过大。
     */
    snapshot() {
      return {
        device: meta("device"),
        settings: meta("settings"),
        projects: list("projects"),
        sessions: list("sessions"),
        conversations: list("conversations"),
        bindings: meta("bindings"),
      };
    },

    /**
     * 更新本机身份。
     *
     * 只允许改 name 和 owner；device id 在首次初始化时生成，之后不可变。
     */
    setDevice(patch) {
      return transaction(() => {
        keys(patch, ["name", "owner"]);
        const record = meta("device");
        for (const [key, value] of Object.entries(patch))
          record[key] = text(value, key, true);
        putMeta("device", record);
        return record;
      });
    },

    /**
     * 更新运行偏好。
     *
     * 只允许 defaults 中声明的字段；
     * 端口、布尔项和字符串分别做类型校验。
     */
    updateSettings(patch) {
      return transaction(() => {
        keys(patch, Object.keys(defaults));
        const record = meta("settings");
        for (const [key, value] of Object.entries(patch)) {
          if (key === "networkPort") integer(value, 1, 65535, key);
          else if (key === "closeToTray" || key === "autoStartHost")
            boolean(value, key);
          else text(value, key, key === "selectedProjectId");
          record[key] = value;
        }
        putMeta("settings", record);
        return record;
      });
    },

    /**
     * 记录用户“稍后处理”的提醒。
     *
     * key 只允许 consult: 或 conversation: 前缀；
     * 最多保留最近 100 条，避免设置数据无限增长。
     */
    dismissAttention(key) {
      return transaction(() => {
        if (
          typeof key !== "string" ||
          !/^(consult|conversation):[a-zA-Z0-9:._-]{1,220}$/.test(key)
        )
          throw new Error("Invalid attention item");
        const record = meta("settings"),
          list = Array.isArray(record.dismissedAttention)
            ? record.dismissedAttention
            : [];
        if (!list.includes(key)) list.push(key);
        record.dismissedAttention = list.slice(-100);
        putMeta("settings", record);
        return record.dismissedAttention;
      });
    },

    /**
     * 新增或更新项目。
     *
     * 路径必须真实存在且是目录；
     * 同一路径不能重复登记；
     * 同名不同 id 的更新必须保持路径唯一。
     */
    saveProject(input) {
      return transaction(() => {
        const name = text(input.name, "name");
        const path = canonicalProjectPath(text(input.path, "path"));
        // SQLite 的 UNIQUE(path) 区分大小写；Windows 上必须按规范化身份查重。
        const key = projectKey(path);
        const duplicate = list("projects").find(
          (project) => projectKey(project.path) === key,
        );

        // 相同路径重复添加时直接返回已有项目，避免用户看到重复条目。
        if (duplicate && input.id === undefined)
          return duplicate;

        // 另一个项目已经占用该路径时拒绝，保证路径唯一。
        if (duplicate && duplicate.id !== input.id)
          throw new Error("Project path already exists");
        const id = input.id === undefined ? randomUUID() : text(input.id, "id");
        const previous = db
          .prepare("SELECT data FROM projects WHERE id=?")
          .get(id);
        const record = {
          id,
          name,
          path,
          createdAt: previous ? JSON.parse(previous.data).createdAt : now(),
        };
        db.prepare(
          "INSERT INTO projects VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,data=excluded.data",
        ).run(id, path, JSON.stringify(record));
        return record;
      });
    },

    /**
     * 删除项目并清理相关绑定。
     *
     * 先确认项目存在；删除后把引用该项目的绑定一并移除，避免悬空路由。
     */
    deleteProject(id) {
      return transaction(() => {
        get("projects", id);
        db.prepare("DELETE FROM projects WHERE id=?").run(id);
        putMeta(
          "bindings",
          meta("bindings").filter(
            (binding) =>
              binding.sourceProjectId !== id && binding.targetProjectId !== id,
          ),
        );
      });
    },

    /**
     * 保存“来源项目 + 目标工具 -> 目标项目”的绑定。
     *
     * 同一来源项目和目标工具只保留一条绑定，新绑定覆盖旧绑定。
     */
    saveBinding(input) {
      return transaction(() => {
        keys(input, ["sourceProjectId", "targetTool", "targetProjectId"]);
        const record = {
          sourceProjectId: text(input.sourceProjectId, "sourceProjectId"),
          targetTool: oneOf(input.targetTool, tools, "targetTool"),
          targetProjectId: text(input.targetProjectId, "targetProjectId"),
        };
        get("projects", record.sourceProjectId);
        get("projects", record.targetProjectId);
        putMeta("bindings", [
          ...meta("bindings").filter(
            (binding) =>
              binding.sourceProjectId !== record.sourceProjectId ||
              binding.targetTool !== record.targetTool,
          ),
          record,
        ]);
        return record;
      });
    },

    /**
     * 删除一条项目绑定。
     *
     * 按来源项目和目标工具定位；不存在时也返回 ok，保证删除操作幂等。
     */
    deleteBinding(input) {
      return transaction(() => {
        keys(input, ["sourceProjectId", "targetTool"]);
        const sourceProjectId = text(input.sourceProjectId, "sourceProjectId"),
          targetTool = oneOf(input.targetTool, tools, "targetTool");
        putMeta(
          "bindings",
          meta("bindings").filter(
            (binding) =>
              binding.sourceProjectId !== sourceProjectId ||
              binding.targetTool !== targetTool,
          ),
        );
        return { ok: true };
      });
    },

    /**
     * 读取项目。
     *
     * 不存在时由 get() 抛错，调用方据此拒绝后续操作。
     */
    getProject(id) {
      return get("projects", id);
    },

    /**
     * 读取工具会话。
     *
     * 不存在时由 get() 抛错，避免把消息写到不存在的会话。
     */
    getSession(id) {
      return get("sessions", id);
    },

    /**
     * 读取一次会话/协作记录。
     *
     * 不存在时由 get() 抛错，避免静默创建错误记录。
     */
    getConversation(id) {
      return get("conversations", id);
    },

    /**
     * 读取最近的只读核对记录。
     *
     * 最多 100 条，按 startedAt 倒序，重启后由控制面恢复到内存。
     */
    listConsultations() {
      return meta("consultations");
    },

    /**
     * 保存一条只读核对记录。
     *
     * 按 id 覆盖旧记录，更新时间戳，并按开始时间保留最近 100 条。
     */
    saveConsultation(record) {
      return transaction(() => {
        const id = text(record.id, "id");
        const value = { ...record, id, updatedAt: now() };
        const list = meta("consultations").filter((item) => item.id !== id);
        list.push(value);
        list.sort((a, b) =>
          String(b.startedAt).localeCompare(String(a.startedAt)),
        );
        putMeta("consultations", list.slice(0, 100));
        return value;
      });
    },

    /**
     * 登记一段工具会话。
     *
     * 先确认项目存在，再校验并写入；
     * native-inbox 模式允许暂时没有 nativeSessionId，但会被标记为 unregistered。
     */
    registerSession(input) {
      return transaction(() => {
        get("projects", input.projectId);
        const record = validateSession({
          id: input.id === undefined ? randomUUID() : text(input.id, "id"),
          projectId: input.projectId,
          tool: input.tool,
          title: input.title,
          nativeSessionId: input.nativeSessionId ?? null,
          mode: input.mode ?? "managed",
          shared: input.shared ?? false,
          capability:
            input.capability ??
            (input.mode === "native-inbox" ? "inbox" : "managed"),
          createdAt: now(),
        });
        db.prepare("INSERT INTO sessions VALUES (?,?,?)").run(
          record.id,
          record.projectId,
          JSON.stringify(record),
        );
        return record;
      });
    },

    /**
     * 更新工具会话的有限字段。
     *
     * 只允许 title/nativeSessionId/mode/shared/capability；
     * 更新后重新跑 validateSession，防止补丁把记录改成非法状态。
     */
    updateSession(id, patch) {
      return transaction(() => {
        keys(patch, [
          "title",
          "nativeSessionId",
          "mode",
          "shared",
          "capability",
        ]);
        return save(
          "sessions",
          validateSession({ ...get("sessions", id), ...patch }),
        );
      });
    },

    /**
     * 创建一次协作记录。
     *
     * 校验项目、本机会话和远端工具；
     * 默认 meeting 模式、1 轮，状态 idle，游标从 0 开始。
     */
    createConversation(input) {
      return transaction(() => {
        get("projects", input.projectId);
        const session = get("sessions", input.localSessionId);
        if (session.projectId !== input.projectId)
          throw new Error("Session belongs to another project");
        oneOf(session.tool, tools, "tool");
        const createdAt = now();
        const record = {
          id: randomUUID(),
          title: text(input.title, "title"),
          projectId: input.projectId,
          localSessionId: input.localSessionId,
          connectionId: text(input.connectionId, "connectionId"),
          remoteAgent: oneOf(input.remoteAgent, tools, "remoteAgent"),
          remoteProjectId:
            input.remoteProjectId == null
              ? null
              : text(input.remoteProjectId, "remoteProjectId"),
          rounds: integer(input.rounds ?? 1, 1, 5, "rounds"),
          mode: oneOf(input.mode ?? "meeting", ["meeting", "channel"], "mode"),
          limits: limits(input.limits),
          cursors: { local: 0, remote: 0 },
          stopReason: null,
          status: "idle",
          createdAt,
          updatedAt: createdAt,
        };
        db.prepare("INSERT INTO conversations VALUES (?,?,?,?)").run(
          record.id,
          record.projectId,
          record.localSessionId,
          JSON.stringify(record),
        );
        return record;
      });
    },

    /**
     * 更新协作记录。
     *
     * 允许更新状态、轮次、模式、限制、游标、停止原因和用量；
     * 所有字段重新校验后再保存。
     */
    updateConversation(id, patch) {
      return transaction(() => {
        keys(patch, [
          "title",
          "status",
          "rounds",
          "mode",
          "limits",
          "cursors",
          "stopReason",
          "lastActivityAt",
          "usage",
        ]);
        const record = {
          ...get("conversations", id),
          ...patch,
          updatedAt: now(),
        };
        text(record.title, "title");
        oneOf(record.status, statuses, "status");
        integer(record.rounds, 1, 5, "rounds");
        if (record.mode !== undefined)
          oneOf(record.mode, ["meeting", "channel"], "mode");
        if (record.limits !== undefined && record.limits !== null)
          record.limits = limits(record.limits);
        if (record.cursors !== undefined)
          record.cursors = cursors(record.cursors);
        if (record.stopReason !== undefined && record.stopReason !== null)
          text(record.stopReason, "stopReason");
        return save("conversations", record);
      });
    },

    /**
     * 追加一条消息。
     *
     * 同一个消息 id 重复写入时：
     * - 内容完全一致：幂等返回旧记录；
     * - 内容不一致：抛错，避免同一 id 被悄悄改成另一条消息。
     * offset 由当前消息数决定，保证分页顺序稳定。
     */
    appendMessage(conversationId, input) {
      return transaction(() => {
        get("conversations", conversationId);
        const content = {
          id: input.id === undefined ? randomUUID() : text(input.id, "id"),
          side: oneOf(
            input.side,
            ["local", "remote", "human", "system"],
            "side",
          ),
          agent: text(input.agent, "agent", true),
          text: text(input.text, "text", true),
        };
        if (input.deliveryStatus !== undefined)
          content.deliveryStatus = text(input.deliveryStatus, "deliveryStatus");
        if (input.replyTo !== undefined)
          content.replyTo = text(input.replyTo, "replyTo");
        const existing = db
          .prepare("SELECT data FROM messages WHERE conversationId=? AND id=?")
          .get(conversationId, content.id);

        // 消息 id 是幂等键：内容相同就返回旧记录，内容不同则拒绝覆盖。
        if (existing) {
          const record = JSON.parse(existing.data);
          const { createdAt, offset, ...previous } = record;
          if (JSON.stringify(previous) !== JSON.stringify(content))
            throw new Error("Message ID content conflict");
          return record;
        }
        const offset = db
          .prepare(
            "SELECT COUNT(*) AS count FROM messages WHERE conversationId=?",
          )
          .get(conversationId).count;
        const record = { ...content, createdAt: now(), offset };
        db.prepare("INSERT INTO messages VALUES (?,?,?,?)").run(
          conversationId,
          record.id,
          offset,
          JSON.stringify(record),
        );
        return record;
      });
    },

    /**
     * 按 offset 分页读取消息。
     *
     * after 是起始 offset，limit 最大 200；
     * 返回 total 和 nextOffset，前端据此控制“较旧/较新”按钮。
     */
    messages(conversationId, { after = 0, limit = 100 } = {}) {
      get("conversations", conversationId);
      integer(after, 0, Number.MAX_SAFE_INTEGER, "after");
      integer(limit, 1, 200, "limit");
      const total = db
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE conversationId=?",
        )
        .get(conversationId).count;
      const messages = db
        .prepare(
          "SELECT data FROM messages WHERE conversationId=? AND offset>=? ORDER BY offset LIMIT ?",
        )
        .all(conversationId, after, limit)
        .map((row) => JSON.parse(row.data));
      return {
        messages,
        total,
        nextOffset: Math.min(after + messages.length, total),
      };
    },

    /**
     * 关闭 SQLite 连接。
     *
     * 控制面退出时调用；关闭后不能再读写，避免退出过程中还有查询。
     */
    close() {
      db.close();
    },
  };
}
