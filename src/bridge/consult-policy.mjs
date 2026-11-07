/**
 * 跨工具只读咨询的策略层。
 *
 * 负责三件事：
 * 1. 为同一问题生成稳定指纹，避免重复启动 Worker；
 * 2. 限制单个来源会话的时间窗口调用量和目标工具并发数；
 * 3. 判断 Worker 是否超时或长时间没有进展。
 *
 * 这些限制是防止 Agent 无休止互相询问的第一道闸门。
 */
import { createHash } from "node:crypto";

export const DEFAULT_CONSULT_LIMITS = Object.freeze({
  windowMs: 10 * 60 * 1000,
  maxPerWindow: 12,
  maxParallelPerTarget: 2,
  maxDurationMs: 180 * 1000,
  noProgressMs: 120 * 1000,
  duplicateWindowMs: 5 * 60 * 1000,
});

/**
 * 校验并补全只读核对限制。
 *
 * 只接受已知 key 的正整数；未知字段忽略，非法值直接抛错。
 * 返回完整限制对象，供控制面和 UI 共用。
 */
export function normalizeConsultLimits(value = {}) {
  const limits = { ...DEFAULT_CONSULT_LIMITS };
  for (const key of Object.keys(DEFAULT_CONSULT_LIMITS)) {
    if (value[key] === undefined) continue;
    if (!Number.isInteger(value[key]) || value[key] < 1)
      throw new Error(`Invalid consult limit: ${key}`);
    limits[key] = value[key];
  }
  return limits;
}

/**
 * 为一次核对生成稳定指纹。
 *
 * 对来源会话、目标工具、目标项目和规范化后的问题做 SHA-256；
 * 相同问题会得到相同指纹，用于去重。
 */
export function consultFingerprint({
  sourceSessionId,
  targetTool,
  targetProjectId,
  text,
}) {
  const normalized = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  return createHash("sha256")
    .update(
      [sourceSessionId, targetTool, targetProjectId, normalized].join("\0"),
    )
    .digest("hex");
}

/**
 * 安全解析记录开始时间。
 *
 * 非法或缺失时间按 0 处理，避免 NaN 参与窗口计算。
 */
const started = (record) => {
  const value = Date.parse(record.startedAt);
  return Number.isFinite(value) ? value : 0;
};

/**
 * 查找窗口内的重复核对。
 *
 * 只匹配指定状态、相同指纹且开始时间在窗口内的记录；
 * 找到就返回原记录，让调用方复用 consultId。
 */
export function findDuplicate(
  records,
  { fingerprint, now, windowMs, statuses = ["running", "completed"] },
) {
  return (
    records.find(
      (record) =>
        statuses.includes(record.status) &&
        record.fingerprint === fingerprint &&
        now - started(record) <= windowMs,
    ) || null
  );
}

/**
 * 检查来源会话的窗口调用量。
 *
 * 统计同一来源会话在 windowMs 内发起的核对数量；
 * 达到 maxPerWindow 就拒绝。
 */
export function checkBudget(records, { sourceSessionId, now, limits }) {
  const used = records.filter(
    (record) =>
      record.sourceSessionId === sourceSessionId &&
      now - started(record) <= limits.windowMs,
  ).length;
  return used >= limits.maxPerWindow
    ? {
        allow: false,
        used,
        limit: limits.maxPerWindow,
        windowMs: limits.windowMs,
      }
    : {
        allow: true,
        used,
        limit: limits.maxPerWindow,
        windowMs: limits.windowMs,
      };
}

/**
 * 检查目标工具/项目的并发数。
 *
 * 只统计 running 且目标工具和目标项目都相同的记录；
 * 达到 maxParallelPerTarget 就拒绝。
 */
export function checkParallel(
  records,
  { targetTool, targetProjectId, limits },
) {
  const used = records.filter(
    (record) =>
      record.status === "running" &&
      record.targetTool === targetTool &&
      record.targetProjectId === targetProjectId,
  ).length;
  return used >= limits.maxParallelPerTarget
    ? { allow: false, used, limit: limits.maxParallelPerTarget }
    : { allow: true, used, limit: limits.maxParallelPerTarget };
}

/**
 * 判断核对是否超时或停滞。
 *
 * 总时长超过 maxDurationMs => timeout；
 * 距离最后进展超过 noProgressMs => stalled。
 */
export function checkProgress(record, { now, limits }) {
  const elapsedMs = Math.max(0, now - started(record));
  const last = Date.parse(record.lastProgressAt || record.startedAt);
  const idleMs = Math.max(
    0,
    now - (Number.isFinite(last) ? last : started(record)),
  );
  if (elapsedMs > limits.maxDurationMs)
    return { stalled: true, reason: "timeout", elapsedMs, idleMs };
  if (idleMs > limits.noProgressMs)
    return { stalled: true, reason: "stalled", elapsedMs, idleMs };
  return { stalled: false, elapsedMs, idleMs };
}
