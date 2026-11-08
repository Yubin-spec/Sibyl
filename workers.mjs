import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {canonicalProjectPath,projectKey} from './project-path.mjs';
import {normalizeWorkerLimits,workerTurnTimeoutMs,checkWorkerCapacity,checkProgress} from './consult-policy.mjs';
import {chooseCodexModel} from './model-policy.mjs';
import {normalizeScope,findLeaseConflict,scopeSharedConflicts,checkPaths} from './path-scope.mjs';
import {
  assertSupportedRepository,
  createWorkerWorktree,
  commitWorktree,
  readSharedFiles,
  stagedPaths,
  listRefs,
  refChanges,
  scopeFingerprint,
  fingerprintChanges
} from './worker-worktree.mjs';
import {collectWorkerReport,writeWorkerReport} from './worker-report.mjs';
import {buildDispatchPrompt,WORKER_POLICY} from './worker-policy.mjs';

const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const iso = ms => new Date(ms).toISOString();
const LIVE = new Set(['starting', 'running']);
const EFFORTS = ['low', 'medium', 'high', 'ultra'];

const defaultScripts = {
  codex: fileURLToPath(new URL('./scripts/spawn-codex-chat.mjs', import.meta.url)),
  claude: fileURLToPath(new URL('./scripts/spawn-claude-chat.mjs', import.meta.url))
};

async function defaultKillTree(pid) {
  if (!pid) return false;
  if (process.platform === 'win32') {
    try { await run('taskkill', ['/pid', String(pid), '/T', '/F']); return true; } catch { return false; }
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { return false; } }
  return true;
}

function defaultIsAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function snapshot(record) {
  const value = {...record};
  for (const field of ['child', 'childExit', 'setupPromise', 'finalizing', 'done', 'resolveDone', 'lastTurnPromise', 'transcript', 'sharedExtra']) delete value[field];
  return value;
}

export function createWorkerService({
  dataDir,
  store,
  limits = normalizeWorkerLimits(),
  scripts = {},
  now = Date.now,
  onChange = () => {},
  killTree = defaultKillTree,
  isAlive = defaultIsAlive,
  sessionAlive = () => true,
  orphanGraceMs = 10 * 60 * 1000
} = {}) {
  const records = new Map();
  const leases = [];
  let closing = false;
  let stopped = false;
  const scriptsMap = {...defaultScripts, ...scripts};

  function save(record) {
    record.updatedAt = iso(now());
    try { store.saveWorker(snapshot(record)); } catch {}
    try { onChange(); } catch {}
  }

  function publicWorker(record) {
    const started = Date.parse(record.startedAt);
    const last = Date.parse(record.lastProgressAt || record.startedAt);
    return {
      workerId: record.id,
      status: record.status,
      tool: record.tool,
      tier: record.tier,
      scope: record.scope,
      leadScope: record.leadScope,
      projectPath: record.projectPath,
      worktreePath: record.worktreePath,
      branch: record.branch,
      model: record.model,
      effort: record.effort,
      modelReason: record.modelReason,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      endedAt: record.endedAt,
      stopReason: record.stopReason,
      error: record.error,
      turns: record.turns,
      lastTurn: record.lastTurn,
      elapsedMs: Number.isFinite(started) ? Math.max(0, now() - started) : 0,
      idleMs: Number.isFinite(last) ? Math.max(0, now() - last) : 0,
      ...(record.report ? {report: record.report} : {})
    };
  }

  function releaseLeases(record) {
    const ids = new Set(record.leaseIds ?? []);
    for (let index = leases.length - 1; index >= 0; index--) if (ids.has(leases[index].leaseId)) leases.splice(index, 1);
    record.leaseIds = [];
  }

  function own(session, workerId) {
    const record = records.get(workerId);
    if (!record || record.sourceSessionId !== session.id) throw Error('Unknown worker');
    return record;
  }

  function settle(record, value) {
    if (!record.turn || value.id !== record.turn.id) return;
    const turn = record.turn;
    record.turn = null;
    clearTimeout(turn.timer);
    if (value.type === 'error') {
      record.lastTurn = {...record.lastTurn, status: 'failed', error: value.error || 'Worker turn failed', endedAt: iso(now())};
      turn.reject(Error(value.error || 'Worker turn failed'));
    } else {
      const text = value.text ?? '';
      record.lastTurn = {...record.lastTurn, status: 'completed', text, endedAt: iso(now())};
      record.transcript = (record.transcript ?? '') + '\n' + text;
      turn.resolve({text});
    }
    record.lastProgressAt = iso(now());
    save(record);
  }

  function executeTurn(record, prompt, timeoutMs) {
    if (record.cancelled) return Promise.reject(Error('Worker is closed'));
    if (record.status !== 'running') return Promise.reject(Error(record.status === 'starting' ? 'Worker is still starting; call bridge_worker_result first' : 'Worker is not running'));
    if (record.turn) return Promise.reject(Error('A turn is already running in this worker'));
    record.pendingFirstTurn = false;
    const id = ++record.serial;
    record.turns = (record.turns ?? 0) + 1;
    record.lastTurn = {id, status: 'running', startedAt: iso(now())};
    record.lastProgressAt = iso(now());
    const promise = new Promise((resolveTurn, rejectTurn) => {
      record.turn = {id, resolve: resolveTurn, reject: rejectTurn};
    });
    record.lastTurnPromise = promise.catch(() => {});
    const timer = setTimeout(() => {
      if (record.turn?.id !== id) return;
      const turn = record.turn;
      record.turn = null;
      record.lastTurn = {...record.lastTurn, status: 'failed', error: 'Worker turn timed out', endedAt: iso(now())};
      turn.reject(Error('Worker turn timed out'));
    }, timeoutMs ?? workerTurnTimeoutMs(record.tier));
    record.turn.timer = timer;
    try {
      record.child.stdin.write(JSON.stringify({id, op: 'turn', prompt}) + '\n');
    } catch (error) {
      clearTimeout(timer);
      record.turn = null;
      record.lastTurn = {...record.lastTurn, status: 'failed', error: error.message, endedAt: iso(now())};
      return Promise.reject(error);
    }
    return promise;
  }

  function spawnChild(record) {
    const script = scriptsMap[record.tool];
    if (!script) throw Error('tool must be codex or claude');
    const cwd = record.tier === 'consult' ? record.projectPath : record.worktreePath;
    const args = [script, '--rpc', '--dir', dataDir, '--project', cwd,
      '--sandbox', record.tier === 'consult' ? 'read-only' : 'workspace-write',
      '--effort', record.effort ?? 'high', '--timeout-ms', '600000'];
    if (record.model) args.push('--model', record.model);
    if (record.tool === 'codex') args.push('--instructions', WORKER_POLICY);
    const child = spawn(process.execPath, args, {cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
    record.child = child;
    record.childPid = child.pid;
    record.stderr = '';
    child.stderr.on('data', chunk => { record.stderr = (record.stderr + chunk.toString()).slice(-2000); });
    child.stdin.on('error', () => {});
    record.childExit = new Promise(resolve => child.once('close', () => { record.childClosed = true; resolve(); }));
    let resolveStart;
    let rejectStart;
    const started = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    const startupTimer = setTimeout(() => rejectStart(Error('Worker startup timed out')), 30000);
    child.on('error', error => {
      clearTimeout(startupTimer);
      if (!record.threadId) rejectStart(error);
      else if (record.turn) {
        const turn = record.turn;
        record.turn = null;
        clearTimeout(turn.timer);
        turn.reject(error);
      }
    });
    child.once('close', (code, signal) => {
      clearTimeout(startupTimer);
      if (!record.threadId) rejectStart(Error(`Worker exited (code ${code}, signal ${signal})${record.stderr ? ' ' + record.stderr.trim() : ''}`));
      if (record.turn) {
        const turn = record.turn;
        record.turn = null;
        clearTimeout(turn.timer);
        turn.reject(Error('Worker exited'));
      }
      if (!record.finalizing && !record.cancelled && record.threadId) void finalize(record, 'failed', Error('Worker exited unexpectedly'));
    });
    createInterface({input: child.stdout}).on('line', line => {
      let value;
      try { value = JSON.parse(line); } catch { return; }
      if (!record.threadId && value.type === 'thread' && value.threadId) {
        clearTimeout(startupTimer);
        record.threadId = value.threadId;
        resolveStart();
        return;
      }
      if (!record.threadId && value.type === 'error') {
        clearTimeout(startupTimer);
        rejectStart(Error(value.error || 'Worker failed to start'));
        return;
      }
      settle(record, value);
    });
    return started;
  }

  async function setup(record, input) {
    try {
      if (record.tier !== 'consult') {
        const wt = await createWorkerWorktree({projectPath: record.projectPath, workerId: record.id, scope: record.scope});
        Object.assign(record, {
          worktreePath: wt.worktreePath,
          branch: wt.branch,
          baseCommit: wt.baseCommit,
          snapshotCommit: wt.snapshotCommit,
          leadDigest: wt.leadDigest
        });
        if (record.cancelled) return;
      }
      if (record.cancelled) return;
      record.refsBefore = await listRefs(record.projectPath);
      await spawnChild(record);
      if (record.cancelled) return;
      record.status = 'running';
      record.lastProgressAt = iso(now());
      save(record);
    } catch (error) {
      record.error = error.message;
      save(record);
      throw error;
    }
  }

  async function closeChild(record) {
    if (!record.child) return {gone: true};
    try { record.child.stdin.write(JSON.stringify({id: ++record.serial, op: 'close'}) + '\n'); } catch {}
    await Promise.race([record.childExit ?? Promise.resolve(), sleep(5000)]);
    if (isAlive(record.childPid)) await killTree(record.childPid);
    await Promise.race([record.childExit ?? Promise.resolve(), sleep(2000)]);
    return {gone: !isAlive(record.childPid)};
  }

  function finalize(record, status, error) {
    if (record.finalizing) return record.finalizing;
    record.cancelled = true;
    record.finalizing = (async () => {
      await record.setupPromise?.catch(() => {});
      if (record.turn) {
        const turn = record.turn;
        record.turn = null;
        clearTimeout(turn.timer);
        turn.reject(Error('Worker closed'));
      }
      const {gone} = await closeChild(record);
      if (!gone) {
        record.status = 'orphan';
        record.stopReason = 'exit-unconfirmed';
        record.error = 'Worker process tree is still alive; lease retained';
        save(record);
        record.resolveDone?.(publicWorker(record));
        return publicWorker(record);
      }
      let head = record.snapshotCommit ?? null;
      if (record.worktreePath && record.snapshotCommit) {
        try {
          head = (await commitWorktree(record.worktreePath, 'sibyl: worker handoff', {branch: record.branch, snapshotCommit: record.snapshotCommit})) ?? record.snapshotCommit;
        } catch (commitError) {
          record.reportError = commitError.message;
        }
      }
      if (record.tier !== 'consult' && record.worktreePath && head) {
        try {
          const report = await collectWorkerReport({
            worktreePath: record.worktreePath,
            projectPath: record.projectPath,
            workerId: record.id,
            snapshotCommit: record.snapshotCommit,
            headCommit: head,
            text: record.transcript ?? '',
            scope: record.scope,
            sharedExtra: record.sharedExtra
          });
          if (record.leadDigest) {
            const after = await scopeFingerprint(record.projectPath, record.scope);
            if (after.truncated) {
              report.reviewReasons.push('主导方改动指纹被截断，验收需人工确认');
              report.needsReview = true;
            }
            const changes = fingerprintChanges(record.leadDigest, after);
            if (changes.length) {
              report.leadChanges = changes;
              report.reviewReasons.push(`主导方在租约内改动了：${changes.join(', ')}`);
              report.needsReview = true;
              report.deliverable.path = null;
              report.deliverable.reason = report.deliverable.reason ?? `主导方在租约内改动了：${changes.join(', ')}`;
            }
          }
          if (record.refsBefore) {
            const after = await listRefs(record.projectPath);
            const ignore = [...records.values()]
              .filter(other => other.branch && (other === record || LIVE.has(other.status)))
              .map(other => 'refs/heads/' + other.branch);
            const changedRefs = refChanges(record.refsBefore, after, {ignore});
            if (changedRefs.length) {
              report.refsChanged = changedRefs;
              report.reviewReasons.push(`派活后有 ref 变动：${changedRefs.join(', ')}`);
              report.needsReview = true;
              report.deliverable.path = null;
              report.deliverable.reason = report.deliverable.reason ?? `派活后有 ref 变动：${changedRefs.join(', ')}`;
            }
          }
          const paths = await writeWorkerReport({
            projectPath: record.projectPath,
            workerId: record.id,
            report,
            patch: report.patchText,
            deliverablePatch: report.deliverable.reason === null ? report.patchText : null
          });
          report.patchPath = paths.patchPath;
          report.reportPath = paths.reportPath;
          report.deliverable.path = paths.deliverablePatchPath;
          record.headCommit = head;
          record.report = report;
        } catch (reportError) {
          record.reportError = reportError.message;
          record.headCommit = head;
        }
      } else if (record.tier === 'consult') {
        record.report = {summary: record.lastTurn?.text ?? '', verificationSource: 'worker-self-report', reported: false};
      }
      record.status = status;
      record.error = error?.message ?? null;
      record.endedAt = iso(now());
      releaseLeases(record);
      save(record);
      record.resolveDone?.(publicWorker(record));
      return publicWorker(record);
    })();
    return record.finalizing;
  }

  async function start(input) {
    if (closing) throw Error('Daemon is shutting down');
    const session = input?.session;
    if (!session?.id || !session?.projectPath) throw Error('Invalid worker session');
    const tool = input.tool;
    if (!['codex', 'claude'].includes(tool)) throw Error('tool must be codex or claude');
    const tier = input.tier ?? 'dispatch';
    if (!['consult', 'dispatch', 'parallel'].includes(tier)) throw Error('tier must be consult, dispatch or parallel');
    const projectPath = canonicalProjectPath(session.projectPath);
    const {base} = await assertSupportedRepository(projectPath);
    const scope = tier === 'consult'
      ? ((input.scope?.length ?? 0) ? normalizeScope(input.scope) : [])
      : normalizeScope(input.scope);
    const leadScope = (input.leadScope?.length ?? 0) ? normalizeScope(input.leadScope) : [];
    const sharedExtra = await readSharedFiles(projectPath);
    if (tier !== 'consult') {
      const shared = scopeSharedConflicts(scope, {extra: sharedExtra});
      if (shared.length) throw Error(`共享文件只能由主导方修改：${shared.join(', ')}；请让工作方在交工报告里提出 changeRequests`);
      const staged = new Set(await stagedPaths(projectPath));
      const overlap = scope.find(entry => [...staged].some(path => path === entry || path.startsWith(entry + '/') || entry.startsWith(path + '/')));
      if (overlap) throw Error('主导方在 scope 内有已暂存改动；先提交或取消暂存再派活');
    }
    const repositoryKey = projectKey(projectPath);
    if (leadScope.length) {
      const selfConflict = findLeaseConflict([{workerId: 'lead', scope: leadScope}], scope, {repositoryKey});
      if (selfConflict) throw Error(`路径租约冲突：${selfConflict.path} 已被主导方租约占用；等它交工后再派`);
    }
    const leaseConflict = findLeaseConflict(leases, scope, {repositoryKey});
    if (leaseConflict) throw Error(`路径租约冲突：${leaseConflict.path} 已被${leaseConflict.workerId === 'lead' ? '主导方租约' : '工作方 ' + leaseConflict.workerId} 占用；等它交工后再派`);
    if (leadScope.length) {
      for (const lease of leases) {
        if (lease.repositoryKey !== repositoryKey || lease.ownerSessionId === session.id) continue;
        const conflict = findLeaseConflict([lease], leadScope, {repositoryKey});
        if (conflict) throw Error(`路径租约冲突：${conflict.path} 已被${conflict.workerId === 'lead' ? '主导方租约' : '工作方 ' + conflict.workerId} 占用；等它交工后再派`);
      }
    }
    const capacity = checkWorkerCapacity([...records.values()], {sourceSessionId: session.id, projectPath, tier, now: now(), limits: limits[tier]});
    if (!capacity.allow) {
      if (capacity.reason === 'budget') throw Error(`${Math.round(limits[tier].windowMs / 60000)} 分钟内已派 ${limits[tier].maxPerWindow} 个工作方；先处理已有报告`);
      if (capacity.reason === 'live-project') throw Error(`该项目同时最多 ${limits[tier].maxLivePerProject} 个工作方；先等工作方交工`);
      if (tier === 'dispatch') throw Error('派个活（dispatch）同时只能有一个工作方；多工作方请用分头干（tier: parallel）');
      throw Error(`该会话同时最多 ${limits[tier].maxLivePerSession} 个工作方；先等工作方交工`);
    }

    const requestedModel = input.model ?? 'auto';
    if (typeof requestedModel !== 'string' || requestedModel.length > 80) throw Error('Invalid model');
    if (input.effort !== undefined && !EFFORTS.includes(input.effort)) throw Error('effort must be low, medium, high or ultra');
    let model;
    let effort;
    let modelReason;
    if (tool === 'claude' && requestedModel === 'auto') {
      model = null;
      effort = input.effort ?? null;
      modelReason = 'claude-default';
    } else if (requestedModel === 'auto') {
      const choice = chooseCodexModel({tier, kind: input.kind ?? null, risk: input.risk ?? 'normal'});
      model = choice.model;
      effort = input.effort ?? choice.effort;
      modelReason = choice.reason;
    } else {
      model = requestedModel;
      effort = input.effort ?? 'medium';
      modelReason = 'explicit';
    }

    if (closing) throw Error('Daemon is shutting down');
    const id = randomUUID();
    const worktreePath = tier === 'consult' ? null : join(projectPath, '.sibyl', 'worktrees', id);
    const branch = tier === 'consult' ? null : `sibyl/worker/${id}`;
    const timestamp = iso(now());
    const record = {
      id,
      sourceSessionId: session.id,
      status: 'starting',
      tool,
      tier,
      scope,
      leadScope,
      sharedExtra,
      projectPath,
      repositoryKey,
      worktreePath,
      branch,
      baseCommit: base,
      snapshotCommit: null,
      worktreeCreated: false,
      model,
      effort,
      modelReason,
      startedAt: timestamp,
      updatedAt: timestamp,
      lastProgressAt: timestamp,
      endedAt: null,
      stopReason: null,
      error: null,
      turns: 0,
      lastTurn: null,
      report: null,
      childPid: null,
      threadId: null,
      serial: 0,
      cancelled: false,
      finalizing: null,
      setupPromise: null,
      lastTurnPromise: null,
      transcript: '',
      pendingFirstTurn: Boolean(input.prompt),
      leaseIds: [],
      leadDigest: null,
      refsBefore: null
    };
    record.done = new Promise(resolve => { record.resolveDone = resolve; });
    const workerLease = {leaseId: randomUUID(), repositoryKey, ownerSessionId: session.id, ownerRole: 'worker', workerId: id, scope, generation: 0};
    leases.push(workerLease);
    record.leaseIds.push(workerLease.leaseId);
    if (leadScope.length) {
      const leadLease = leases.find(lease => lease.repositoryKey === repositoryKey && lease.ownerSessionId === session.id && lease.ownerRole === 'lead' && lease.scope.length === leadScope.length && lease.scope.every((entry, index) => entry === leadScope[index]));
      if (leadLease) record.leaseIds.push(leadLease.leaseId);
      else {
        const created = {leaseId: randomUUID(), repositoryKey, ownerSessionId: session.id, ownerRole: 'lead', workerId: 'lead', scope: leadScope, generation: 0};
        leases.push(created);
        record.leaseIds.push(created.leaseId);
      }
    }
    records.set(id, record);
    save(record);
    record.setupPromise = setup(record, input);
    record.setupPromise.then(() => {
      if (record.cancelled || record.status !== 'running' || !input.prompt) return;
      const prompt = tier === 'consult'
        ? input.prompt
        : buildDispatchPrompt({task: input.prompt, scope: record.scope, worktreePath: record.worktreePath, branch: record.branch, sharedFiles: record.sharedExtra});
      executeTurn(record, prompt, input.timeoutMs).then(() => finalize(record, 'completed')).catch(turnError => finalize(record, 'failed', turnError));
    }).catch(setupError => {
      if (!record.finalizing) void finalize(record, 'failed', setupError);
    });
    return {
      ...publicWorker(record),
      leadMustWaitFor: scope,
      notice: tier === 'consult'
        ? 'Read-only worker started; use bridge_worker_result to read the answer.'
        : 'Worker started in the background; use bridge_worker_result to wait for the report.'
    };
  }

  function turn({session, workerId, prompt, timeoutMs}) {
    const record = own(session, workerId);
    if (record.status === 'starting') throw Error('Worker is still starting; call bridge_worker_result first');
    if (record.status !== 'running') throw Error('Worker is not running');
    if (record.turn) throw Error('A turn is already running in this worker');
    if (typeof prompt !== 'string' || !prompt.trim()) throw Error('prompt must be a non-empty string');
    const promise = executeTurn(record, prompt, timeoutMs);
    promise.catch(() => {});
    return {workerId: record.id, turnId: record.lastTurn.id, status: 'running', accepted: true};
  }

  async function result({session, workerId, waitMs = 0}) {
    const record = own(session, workerId);
    if (record.lastTurn?.status === 'running' && waitMs > 0) await Promise.race([record.lastTurnPromise, sleep(waitMs)]);
    return {...publicWorker(record), lastTurn: record.lastTurn};
  }

  async function close({session, workerId}) {
    const record = own(session, workerId);
    if (record.status === 'orphan') {
      await killTree(record.childPid);
      if (isAlive(record.childPid)) throw Error('Worker process tree is still alive; cannot release the lease');
      record.status = 'interrupted';
      record.stopReason = null;
      record.endedAt = iso(now());
      releaseLeases(record);
      save(record);
      return publicWorker(record);
    }
    if (!LIVE.has(record.status)) return publicWorker(record);
    record.stopReason = record.stopReason ?? 'closed';
    return finalize(record, record.turn || record.pendingFirstTurn ? 'stopped' : 'completed');
  }

  function accept({session, workerId, accepted, note}) {
    const record = own(session, workerId);
    if (LIVE.has(record.status) || !record.report) throw Error('Worker has not finished');
    record.report.acceptance = accepted ? 'accepted' : 'rejected';
    if (note !== undefined) record.report.acceptanceNote = String(note).slice(0, 2000);
    save(record);
    return publicWorker(record);
  }

  function list({session, all = false} = {}) {
    return [...records.values()]
      .filter(record => all || !session || record.sourceSessionId === session.id)
      .map(publicWorker);
  }

  async function checkLease({session, paths}) {
    const sharedExtra = await readSharedFiles(session.projectPath);
    const checked = checkPaths(paths ?? [], leases, {sharedExtra, repositoryKey: projectKey(session.projectPath)});
    return {allowed: checked.allowed, blocked: checked.blocked.map(({path, workerId}) => ({path, workerId})), shared: checked.shared, invalid: checked.invalid};
  }

  async function closeAll() {
    closing = true;
    const live = [...records.values()].filter(record => LIVE.has(record.status));
    await Promise.allSettled(live.map(record => finalize(record, 'interrupted', Error('后台已关闭，工作方被中断；工作树和分支保留。'))));
  }

  function stop() {
    stopped = true;
    clearInterval(watchdog);
  }

  for (const loaded of store.listWorkers?.() ?? []) {
    const record = {...loaded};
    if (record.status === 'starting' || record.status === 'running') {
      record.status = 'interrupted';
      record.error = '后台已重启；该工作方未完成，工作树和分支保留。';
    }
    records.set(record.id, record);
    if (record.stopReason === 'exit-unconfirmed') {
      record.status = 'orphan';
      const leaseId = record.leaseIds?.[0] ?? randomUUID();
      record.leaseIds = record.leaseIds?.length ? record.leaseIds : [leaseId];
      leases.push({leaseId, repositoryKey: record.repositoryKey, ownerSessionId: record.sourceSessionId, ownerRole: 'worker', workerId: record.id, scope: record.scope, generation: 0});
    }
  }

  const minIdle = Math.min(...Object.values(limits).map(limit => limit.noProgressMs));
  const watchdog = setInterval(() => {
    if (stopped || closing) return;
    for (const record of [...records.values()]) {
      if (!LIVE.has(record.status) || record.finalizing) continue;
      const limit = limits[record.tier];
      if (!limit) continue;
      const current = now();
      if (!sessionAlive(record.sourceSessionId) && current - Date.parse(record.lastProgressAt || record.startedAt) > orphanGraceMs) {
        record.stopReason = 'orphan';
        void finalize(record, 'orphan', Error('主导方会话已结束且工作方长时间没有进展，已作为孤儿停止；工作树和分支保留。'));
        continue;
      }
      const progress = checkProgress(record, {now: current, limits: {maxDurationMs: limit.maxDurationMs, noProgressMs: limit.noProgressMs}});
      if (progress.stalled) {
        record.stopReason = progress.reason;
        void finalize(record, 'stopped', Error(progress.reason === 'timeout' ? '工作方超过最长运行时间，已停止。' : '长时间没有收到工作方进展，已停止。'));
        continue;
      }
    }
  }, Math.min(1000, Math.max(50, Math.floor(Math.min(minIdle, orphanGraceMs) / 4))));
  watchdog.unref?.();

  return {start, turn, result, close, accept, list, checkLease, closeAll, stop};
}
