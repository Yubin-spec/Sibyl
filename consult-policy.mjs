import {createHash} from 'node:crypto';

export const DEFAULT_CONSULT_LIMITS = Object.freeze({
  windowMs: 10 * 60 * 1000,
  maxPerWindow: 12,
  maxParallelPerTarget: 2,
  maxDurationMs: 180 * 1000,
  noProgressMs: 120 * 1000,
  duplicateWindowMs: 5 * 60 * 1000
});

export const DEFAULT_WORKER_LIMITS = Object.freeze({
  consult: Object.freeze({maxDurationMs:15*60*1000,noProgressMs:10*60*1000,windowMs:60*60*1000,maxPerWindow:12,maxLivePerSession:2,maxLivePerProject:3}),
  dispatch: Object.freeze({maxDurationMs:30*60*1000,noProgressMs:15*60*1000,windowMs:60*60*1000,maxPerWindow:6,maxLivePerSession:1,maxLivePerProject:2}),
  parallel: Object.freeze({maxDurationMs:60*60*1000,noProgressMs:15*60*1000,windowMs:60*60*1000,maxPerWindow:10,maxLivePerSession:3,maxLivePerProject:4})
});

export function normalizeWorkerLimits(value = {}) {
  for (const tier of Object.keys(value)) {
    if (!Object.hasOwn(DEFAULT_WORKER_LIMITS, tier)) throw new Error(`Invalid worker limit tier: ${tier}`);
  }
  const result = {};
  for (const [tier, defaults] of Object.entries(DEFAULT_WORKER_LIMITS)) {
    const limits = {...defaults};
    const patch = value[tier];
    if (patch !== undefined && (typeof patch !== 'object' || patch === null || Array.isArray(patch))) throw new Error(`Invalid worker limit tier: ${tier}`);
    for (const [key, next] of Object.entries(patch ?? {})) {
      if (!Object.hasOwn(defaults, key)) throw new Error(`Invalid worker limit: ${key}`);
      if (!Number.isInteger(next) || next < 1) throw new Error(`Invalid worker limit: ${key}`);
      limits[key] = next;
    }
    result[tier] = limits;
  }
  return result;
}

export function workerTurnTimeoutMs(tier) {
  if (!['consult', 'dispatch', 'parallel'].includes(tier)) throw new Error('tier must be consult, dispatch or parallel');
  return 600000;
}

export function checkWorkerCapacity(records, {sourceSessionId, projectPath, now, limits}) {
  const live = records.filter(record => ['starting', 'running'].includes(record.status));
  const liveSession = live.filter(record => record.sourceSessionId === sourceSessionId).length;
  const liveProject = live.filter(record => record.projectPath === projectPath).length;
  const used = records.filter(record => record.sourceSessionId === sourceSessionId && now - started(record) <= limits.windowMs).length;
  if (liveSession >= limits.maxLivePerSession) return {allow: false, reason: 'live-session', liveSession, liveProject, used, limits};
  if (liveProject >= limits.maxLivePerProject) return {allow: false, reason: 'live-project', liveSession, liveProject, used, limits};
  if (used >= limits.maxPerWindow) return {allow: false, reason: 'budget', liveSession, liveProject, used, limits};
  return {allow: true, liveSession, liveProject, used, limits};
}

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
