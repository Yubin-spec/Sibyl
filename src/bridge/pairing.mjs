/**
 * 设备配对状态机。
 *
 * 负责短期配对码、审批、反向授权、凭证轮换和撤销。这里不负责网络传输，
 * 只维护“谁已经获得访问权”以及授权是否已经激活。
 */
import { randomInt, randomBytes, randomUUID, createHash } from "node:crypto";
import { isIP } from "node:net";

/**
 * 校验 UUID 字符串。
 *
 * device id、peer id 都必须是标准 UUID，避免路径/协议字段被注入其它字符。
 */
const uuid = (v) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * 校验可读名称。
 *
 * 只允许字母、数字、空格、下划线、点和短横线，长度 1-80。
 */
const safe = (v) =>
  typeof v === "string" && /^[\p{L}\p{N} _.-]{1,80}$/u.test(v);

/**
 * 校验并裁剪设备元数据。
 *
 * 只保留 id/name/owner，防止远端把任意字段写进 peer 记录。
 */
export function safeDevice(v) {
  if (!v || !uuid(v.id) || !safe(v.name) || !safe(v.owner))
    throw Error("Invalid device metadata");
  return { id: v.id, name: v.name, owner: v.owner };
}

/**
 * 校验反向连接地址和凭证。
 *
 * 要求：
 * - 私网 IPv4；
 * - 明文 http；
 * - 主机与请求来源 IP 一致；
 * - 不带路径/查询/账号密码；
 * - token 是 64 位十六进制，peerId 是 UUID。
 */
function safeReverse(v, ip) {
  let u;
  try {
    u = new URL(v.url);
  } catch {
    throw Error("Invalid reverse URL");
  }
  const parts = u.hostname.split(".").map(Number),
    privateIP =
      isIP(u.hostname) === 4 &&
      (parts[0] === 10 ||
        (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31));
  if (
    u.protocol !== "http:" ||
    !privateIP ||
    u.hostname !== ip ||
    !/^http:\/\/[^/]+:\d+\/?$/.test(v.url) ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash ||
    !Number(u.port || 80) ||
    !/^[a-f0-9]{64}$/i.test(v.token || "") ||
    !uuid(v.peerId)
  )
    throw Error("Invalid reverse address or credentials");
  return { url: u.origin, token: v.token, peerId: v.peerId };
}

/**
 * 计算 token/secret 的 SHA-256。
 *
 * 状态文件只保存哈希，不保存明文 token。
 */
const hash = (value) => createHash("sha256").update(value).digest("hex");

/**
 * 创建设备配对状态机。
 *
 * 管理短期配对码、待审批请求、peer 凭证、反向授权和撤销。
 * 所有变更通过 save 落盘，通过 notify/onChange 通知 UI。
 */
export function createPairing({
  peers,
  save,
  notify = () => {},
  now = Date.now,
  onApproved,
  metadata,
  onChange = () => {},
}) {
  metadata = metadata ? safeDevice(metadata) : undefined;
  let code = String(randomInt(10000000, 100000000)),
    expires = now() + 300000;

  // pending 是短期配对请求，attempts 是按 IP 的限流窗口。
  const pending = new Map(),
    attempts = new Map();

  // 每次操作前清理过期请求和限流窗口，避免 Map 无限增长。
  const prune = () => {
    for (const [id, r] of pending) if (r.expires < now()) pending.delete(id);
    for (const [ip, r] of attempts) if (r.until < now()) attempts.delete(ip);
  };
  return {
    get code() {
      return code;
    },

    /**
     * 轮换配对码。
     *
     * 新码 5 分钟有效；旧码立即失效。
     */
    rotate() {
      code = String(randomInt(10000000, 100000000));
      expires = now() + 300000;
      return code;
    },

    /**
     * 开始一次配对请求。
     *
     * 校验来源 IP、尝试频率、配对码、设备元数据和反向地址；
     * 通过后生成 pending 请求，等待主机人工同意。
     */
    start(body, ip) {
      prune();
      ip = String(ip).replace(/^::ffff:/, "");
      const device =
        body?.device === undefined ? undefined : safeDevice(body.device);
      const reverse =
        body?.reverse === undefined ? undefined : safeReverse(body.reverse, ip);
      if (attempts.size > 1000 && !attempts.has(ip))
        throw Error("Too many requests");
      const count = attempts.get(ip) || { n: 0, until: now() + 60000 };
      attempts.set(ip, count);

      // 同一 IP 每分钟最多 5 次配对尝试，防止暴力猜 8 位码。
      if (++count.n > 5) throw Error("Too many attempts; wait one minute");
      if (now() > expires)
        throw Error("Pairing code expired; ask host to rotate");
      if (
        body?.code !== code ||
        typeof body.name !== "string" ||
        !/^[\p{L}\p{N} _.-]{1,60}$/u.test(body.name)
      )
        throw Error("Invalid pairing code or name");

      // 待审批请求上限 20，防止有人刷爆主机 UI。
      if (pending.size >= 20) throw Error("Too many pending requests");
      const request = {
        id: randomUUID(),
        secret: randomBytes(32).toString("hex"),
        name: body.name,
        device,
        reverse,
        ip,
        status: "pending",
        expires: now() + 300000,
      };
      pending.set(request.id, request);
      notify({ id: request.id, name: request.name, ip, device });
      onChange({ type: "pair-request", id: request.id });
      return { id: request.id, secret: request.secret };
    },

    /**
     * 同意或拒绝配对请求。
     *
     * 同意时生成 peerId 和 token，先落盘再调用 onApproved；
     * 任何一步失败都回滚 peer 和请求状态。
     */
    async approve(id, accepted) {
      prune();
      const r = pending.get(id);
      if (!r || r.status !== "pending") throw Error("Unknown pending request");
      if (!accepted) {
        r.status = "denied";
        onChange({ type: "pair-denied", id });
        return;
      }

      // 先标记 approving，防止并发 approve 生成两个 peer。
      r.status = "approving";
      const token = randomBytes(32).toString("hex"),
        peerId = randomUUID();
      peers[peerId] = {
        id: peerId,
        name: r.name,
        hash: hash(token),
        deviceId: r.device?.id,
        owner: r.device?.owner,
        created: new Date(now()).toISOString(),
      };
      try {
        await save();
        await onApproved?.({ request: r, peer: peers[peerId], token });
      } catch (e) {
        delete peers[peerId];
        r.status = "pending";
        await save();
        throw e;
      }
      Object.assign(r, { status: "approved", token, peerId });
      onChange({ type: "pair-approved", id, peerId });
    },

    /**
     * 查询配对结果。
     *
     * 必须同时提供请求 id 和 secret，防止别人枚举 id 拿到 token。
     */
    result(id, secret) {
      prune();
      const r = pending.get(id);
      if (!r || hash(String(secret)) !== hash(r.secret))
        throw Error("Unknown pairing request");
      if (["pending", "approving"].includes(r.status))
        return { status: "pending" };
      pending.delete(id);
      return {
        status: r.status,
        token: r.token,
        peerId: r.peerId,
        ...(metadata ? { device: metadata } : {}),
      };
    },

    /**
     * 用 Bearer token 查找 peer。
     *
     * 只匹配 enabled 的 peer，且比较哈希而不是明文。
     */
    authenticate(token) {
      const digest = hash(token);
      return (
        Object.values(peers).find(
          (peer) => peer.enabled !== false && peer.hash === digest,
        ) || null
      );
    },

    /**
     * 预授权一个反向 peer。
     *
     * 用于双向配对：先创建未激活 peer，等双方确认后再 activate。
     */
    async grant({ name, deviceId, owner, enabled = false }) {
      if (
        !safe(name) ||
        (deviceId !== undefined && !uuid(deviceId)) ||
        (owner !== undefined && !safe(owner)) ||
        typeof enabled !== "boolean"
      )
        throw Error("Invalid peer metadata");
      const peerId = randomUUID(),
        token = randomBytes(32).toString("hex");
      peers[peerId] = {
        id: peerId,
        name,
        deviceId,
        owner,
        enabled,
        hash: hash(token),
        created: new Date(now()).toISOString(),
      };
      try {
        await save();
      } catch (e) {
        delete peers[peerId];
        throw e;
      }
      return { peerId, token };
    },

    /**
     * 激活一个预授权 peer。
     *
     * 激活后该 token 才能通过 authenticate；落盘失败会回滚 enabled。
     */
    async activate(id) {
      const peer = peers[id];
      if (!peer) throw Error("Unknown peer");
      const old = peer.enabled;
      peer.enabled = true;
      try {
        await save();
      } catch (e) {
        peer.enabled = old;
        throw e;
      }
      onChange({ type: "pair-activated", peerId: id });
    },

    /**
     * 撤销一个 peer。
     *
     * 先从内存删除，再落盘；落盘失败会恢复，避免状态和磁盘不一致。
     */
    async revoke(id) {
      if (!Object.hasOwn(peers, id)) throw Error("Unknown peer");
      const peer = peers[id];
      delete peers[id];
      try {
        await save();
      } catch (e) {
        peers[id] = peer;
        throw e;
      }
      onChange({ type: "pair-revoked", peerId: id });
    },
  };
}
