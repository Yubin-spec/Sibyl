import {createHash} from 'node:crypto';

export const DEFAULT_CONSULT_LIMITS = Object.freeze({
  windowMs: 10 * 60 * 1000,
  maxPerWindow: 12,
  maxParallelPerTarget: 2,
  maxDurationMs: 180 * 1000,
  noProgressMs: 120 * 1000,
  duplicateWindowMs: 5 * 60 * 1000
});

export function normalizeConsultLimits(value = {}) {
  const limits = {...DEFAULT_CONSULT_LIMITS};
  for (const key of Object.keys(DEFAULT_CONSULT_LIMITS)) {
    if (value[key] === undefined) continue;
    if (!Number.isInteger(value[key]) || value[key] < 1) throw new Error(`Invalid consult limit: ${key}`);
    limits[key] = value[key];
  }
  return limits;
}

export function consultFingerprint({sourceSessionId, targetTool, targetProjectId, text}) {
  const normalized = String(text ?? '').trim().replace(/\s+/g, ' ');
  return createHash('sha256').update([sourceSessionId, targetTool, targetProjectId, normalized].join('\0')).digest('hex');
}

const started = record => {
  const value = Date.parse(record.startedAt);
  return Number.isFinite(value) ? value : 0;
};

export function findDuplicate(records, {fingerprint, now, windowMs, statuses = ['running', 'completed']}) {
  return records.find(record => statuses.includes(record.status) && record.fingerprint === fingerprint && now - started(record) <= windowMs) || null;
}

export function checkBudget(records, {sourceSessionId, now, limits}) {
  const used = records.filter(record => record.sourceSessionId === sourceSessionId && now - started(record) <= limits.windowMs).length;
  return used >= limits.maxPerWindow
    ? {allow: false, used, limit: limits.maxPerWindow, windowMs: limits.windowMs}
    : {allow: true, used, limit: limits.maxPerWindow, windowMs: limits.windowMs};
}

export function checkParallel(records, {targetTool, targetProjectId, limits}) {
  const used = records.filter(record => record.status === 'running' && record.targetTool === targetTool && record.targetProjectId === targetProjectId).length;
  return used >= limits.maxParallelPerTarget
    ? {allow: false, used, limit: limits.maxParallelPerTarget}
    : {allow: true, used, limit: limits.maxParallelPerTarget};
}

export function checkProgress(record, {now, limits}) {
  const elapsedMs = Math.max(0, now - started(record));
  const last = Date.parse(record.lastProgressAt || record.startedAt);
  const idleMs = Math.max(0, now - (Number.isFinite(last) ? last : started(record)));
  if (elapsedMs > limits.maxDurationMs) return {stalled: true, reason: 'timeout', elapsedMs, idleMs};
  if (idleMs > limits.noProgressMs) return {stalled: true, reason: 'stalled', elapsedMs, idleMs};
  return {stalled: false, elapsedMs, idleMs};
}
