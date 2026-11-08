import {readFile, writeFile, mkdir, realpath, stat, rename, rm} from 'node:fs/promises';
import {resolve, relative, sep, join, dirname, basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {
  PROTOCOL_VERSION, HASH_VERSION, REVIEW_STATES,
  parsePlanDeclaration, isStructural, parseVerdict, writeCodexReviewSection,
  findPlanFiles, normalizeReviewConfig, buildReviewPrompt, buildResponsePrompt
} from './plan-review-policy.mjs';

const TERMINAL = new Set(['approved', 'rejected', 'cancelled', 'failed']);
const ACTIVE = new Set(['starting', 'awaiting-visibility', 'reviewing', 'changes-required', 'deadlock', 'interrupted']);
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const iso = ms => new Date(ms).toISOString();

async function writeAtomic(path, data) {
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, data, {mode: 0o600, flag: 'wx'});
    await rename(temp, path);
  } finally {
    await rm(temp, {force: true});
  }
}

function issueKey(issue) {
  return issue?.id;
}

function questionKey(question) {
  return question?.id;
}

export function createPlanReviewService({
  store,
  workers,
  now = Date.now,
  onChange = () => {},
  config = normalizeReviewConfig(),
  focusThread = async () => 'unknown',
  readConstraints = async projectPath => {
    try {
      return (await readFile(join(projectPath, 'CLAUDE.md'), 'utf8')).slice(0, 4000);
    } catch {
      return '';
    }
  },
  reconcileMs = 30000
} = {}) {
  const records = new Map();
  const queues = new Map();
  let startLock = Promise.resolve();
  let timer = null;
  let closed = false;

  for (const record of store.listPlanReviews?.() ?? []) records.set(record.id, record);

  const save = record => {
    record.updatedAt = iso(now());
    store.savePlanReview(record);
    try { onChange(); } catch {}
  };

  const publicReview = record => {
    const {pendingPrompt, requests, lastProcessedKey, ...value} = record;
    return {reviewId: record.id, ...value};
  };

  const own = (session, record) => {
    if (!session?.id || record.currentActorSessionId !== session.id) throw Error('Review does not belong to this actor');
    return record;
  };

  const withQueue = (reviewId, work) => {
    const previous = queues.get(reviewId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    queues.set(reviewId, next.catch(() => {}));
    return next.finally(() => {
      if (queues.get(reviewId) === next) queues.delete(reviewId);
    });
  };

  const withStartLock = work => {
    const next = startLock.catch(() => {}).then(work);
    startLock = next.catch(() => {});
    return next;
  };

  function projectInfo(session) {
    if (!session?.projectPath) throw Error('Invalid review session');
    const projectPath = resolve(session.projectPath);
    return {projectPath, projectId: session.projectId ?? projectPath};
  }

  async function readPlan(session, planPath) {
    const {projectPath, projectId} = projectInfo(session);
    if (typeof planPath !== 'string' || !planPath.trim() || planPath.length > 1024) throw Error('Invalid plan path');
    const absolute = resolve(projectPath, planPath);
    const real = await realpath(absolute).catch(() => { throw Error('Plan not found'); });
    if (real !== projectPath && !real.startsWith(projectPath + sep)) throw Error('Plan is outside the project');
    const info = await stat(real);
    if (!info.isFile()) throw Error('Plan is not a file');
    if (info.size > config.maxPlanBytes) throw Error('Plan is too large');
    const text = await readFile(real, 'utf8');
    const parsed = parsePlanDeclaration(text);
    if (parsed.errors.length) throw Error('Plan declaration error: ' + parsed.errors.join('; '));
    return {
      absolute: real,
      relative: relative(projectPath, real).split(sep).join('/'),
      text,
      parsed,
      projectPath,
      projectId
    };
  }

  function sessionFor(record) {
    return {id: record.currentActorSessionId, projectPath: record.projectPath, projectId: record.projectId, tool: 'claude'};
  }

  function activeFor(projectId, planPath) {
    return [...records.values()].find(record => record.projectId === projectId && record.planPath === planPath && ACTIVE.has(record.status));
  }

  async function snapshot(record, prompt) {
    const directory = join(record.projectPath, '.sibyl', 'reviews', record.id);
    await mkdir(directory, {recursive: true});
    const path = join(directory, 'round-' + record.round + '.md');
    await writeAtomic(path, record.planSnapshot);
    return path;
  }

  async function artifact(record) {
    const path = join(record.projectPath, '.sibyl', 'reviews', record.id + '.json');
    try {
      await mkdir(dirname(path), {recursive: true});
      await writeAtomic(path, JSON.stringify({
        ...publicReview(record),
        rounds: record.rounds,
        artifactError: record.artifactError ?? null
      }, null, 2) + '\n');
      record.artifactPath = path;
      record.artifactError = null;
    } catch (error) {
      record.artifactPath = path;
      record.artifactError = error.message;
    }
    save(record);
  }

  async function waitForThread(record) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const value = await workers.result({
        session: sessionFor(record),
        workerId: record.workerId,
        waitMs: 1000
      });
      if (value.threadId) return value.threadId;
      if (['failed', 'stopped', 'orphan'].includes(value.status)) throw Error(value.error || 'Worker failed to start');
      await sleep(100);
    }
    return null;
  }

  async function launch(record, {initial = false, final = false} = {}) {
    if (closed) throw Error('Review service is closed');
    const started = await workers.start({
      session: sessionFor(record),
      tool: 'codex',
      tier: 'consult',
      kind: 'review',
      risk: 'high',
      model: final ? config.reviewerFinalModel : config.reviewerModel,
      effort: config.reviewerEffort,
      mcp: 'none'
    });
    record.workerId = started.workerId;
    record.threadId = started.threadId ?? null;
    record.status = 'starting';
    record.visibility = 'unknown';
    save(record);
    const threadId = await waitForThread(record);
    if (!threadId) {
      record.status = 'failed';
      record.error = 'Worker did not return a threadId';
      save(record);
      await artifact(record);
      return publicReview(record);
    }
    record.threadId = threadId;
    const visibility = await focusThread({threadId, projectPath: record.projectPath, planPath: record.planPath});
    record.visibility = visibility === 'opened' ? 'opened' : 'unknown';
    if (record.visibility !== 'opened') {
      record.status = 'awaiting-visibility';
      save(record);
      return publicReview(record);
    }
    const snapshotPath = await snapshot(record);
    const constraints = await readConstraints(record.projectPath);
    const previous = record.rounds.length ? JSON.stringify(record.rounds.at(-1), null, 2) : '';
    const prompt = initial
      ? buildReviewPrompt({snapshotPath, projectPath: record.projectPath, planPath: record.planPath, round: record.round, focus: record.focus, previous, constraints})
      : buildResponsePrompt({snapshotPath, projectPath: record.projectPath, planPath: record.planPath, round: record.round, previous, constraints});
    await workers.turn({
      session: sessionFor(record),
      workerId: record.workerId,
      prompt,
      timeoutMs: config.turnMs
    });
    record.status = 'reviewing';
    record.pendingPrompt = null;
    save(record);
    return publicReview(record);
  }

  async function closeWorker(record) {
    if (!record.workerId) return;
    try {
      const value = await workers.close({session: sessionFor(record), workerId: record.workerId});
      record.cleanup = value?.status === 'orphan' ? 'orphan' : 'closed';
    } catch {
      record.cleanup = 'orphan';
    }
  }

  async function handleVerdict(record, text) {
    const parsed = parseVerdict(text, {focus: record.focus});
    record.rawVerdict = text;
    if (!parsed.ok) {
      record.status = 'failed';
      record.error = parsed.error;
      return;
    }
    record.verdict = parsed.verdict;
    record.issues = parsed.verdict.issues;
    record.questions = parsed.verdict.questions;
    record.focusWarning = parsed.focusWarning ?? null;
    record.rounds.push({
      round: record.round,
      planHash: record.planHash,
      planSnapshot: record.planSnapshot,
      verdict: parsed.verdict,
      responses: record.responses,
      rawVerdict: text
    });
    if (parsed.verdict.verdict === 'approve') {
      const fresh = await readPlan({projectPath: record.projectPath, projectId: record.projectId}, record.planPath).catch(() => null);
      if (!fresh || fresh.parsed.inputHash !== record.planHash) {
        record.status = 'changes-required';
        record.error = 'Plan changed while review was pending';
        return;
      }
      const written = writeCodexReviewSection(fresh.text, {
        status: 'approved',
        summary: parsed.verdict.summary,
        reviewer: 'codex',
        round: record.round,
        accepted: record.responses.map(item => item.issueId ?? item.questionId),
        residualRisks: []
      });
      await writeFile(fresh.absolute, written, 'utf8');
      store.savePlanApproval({
        projectId: record.projectPath,
        planPath: record.planPath,
        reviewId: record.id,
        planHash: record.planHash,
        hashVersion: record.hashVersion,
        status: 'approved',
        approvedAt: iso(now())
      });
      record.status = 'approved';
      record.approvedAt = iso(now());
      return;
    }
    if (record.round >= record.maxRounds) record.status = 'deadlock';
    else record.status = 'changes-required';
  }

  async function processWorkerValue(record, value) {
    const turn = value?.lastTurn;
    if (turn?.status === 'completed') {
      const key = record.workerId + ':' + turn.id;
      if (record.lastProcessedKey === key) return;
      record.lastProcessedKey = key;
      await handleVerdict(record, turn.text ?? '');
      await closeWorker(record);
      save(record);
      await artifact(record);
      return;
    }
    if (turn?.status === 'failed' || ['failed', 'stopped', 'orphan'].includes(value?.status)) {
      record.status = value?.stopReason === 'exit-unconfirmed' || value?.status === 'orphan' ? 'interrupted' : 'failed';
      record.error = turn?.error || value?.error || value?.stopReason || 'Worker stopped';
      await closeWorker(record);
      save(record);
      await artifact(record);
    }
  }

  async function reconcile() {
    if (closed) return;
    for (const record of records.values()) {
      try {
        if (record.status === 'reviewing' && record.workerId) {
          const value = await workers.result({session: sessionFor(record), workerId: record.workerId, waitMs: 0});
          await processWorkerValue(record, value);
        }
        if (['starting', 'awaiting-visibility', 'reviewing', 'changes-required'].includes(record.status) && now() > record.deadline) {
          record.status = 'failed';
          record.error = 'timeout: whole review exceeded';
          await closeWorker(record);
          save(record);
          await artifact(record);
        }
      } catch {}
    }
  }

  async function start({session, planPath}) {
    if (session?.tool && session.tool !== 'claude') throw Error('Only Claude can request plan review');
    return withStartLock(async () => {
      const plan = await readPlan(session, planPath);
      const structural = isStructural(plan.parsed);
      if (!structural.required) return {required: false, reviewId: null, reasons: structural.reasons};
      const existing = activeFor(plan.projectId, plan.relative);
      if (existing) {
        if (existing.planHash === plan.parsed.inputHash) return {...publicReview(existing), notice: 'Existing review returned; do not resubmit.'};
        existing.status = 'cancelled';
        existing.error = 'Superseded by a changed plan';
        existing.endedAt = iso(now());
        save(existing);
      }
      const stamp = iso(now());
      const record = {
        id: randomUUID(),
        protocolVersion: PROTOCOL_VERSION,
        hashVersion: HASH_VERSION,
        projectId: plan.projectId,
        projectPath: plan.projectPath,
        planPath: plan.relative,
        planHash: plan.parsed.inputHash,
        planSnapshot: plan.text,
        declaration: {review: plan.parsed.review, change: plan.parsed.change},
        focus: plan.parsed.focus,
        status: 'starting',
        round: 1,
        maxRounds: config.maxRounds,
        finalRoundUsed: false,
        workerId: null,
        threadId: null,
        visibility: 'unknown',
        cleanup: null,
        createdBySessionId: session.id,
        currentActorSessionId: session.id,
        verdict: null,
        issues: [],
        questions: [],
        responses: [],
        rounds: [],
        artifactPath: null,
        artifactError: null,
        interruptedFrom: null,
        deadline: now() + config.wholeReviewMs,
        createdAt: stamp,
        updatedAt: stamp,
        approvedAt: null,
        error: null,
        rawVerdict: null,
        pendingPrompt: null,
        requests: {},
        lastProcessedKey: null
      };
      records.set(record.id, record);
      save(record);
      void launch(record, {initial: true}).catch(error => {
        if (closed) return;
        record.status = 'failed';
        record.error = error.message;
        save(record);
        void artifact(record);
      });
      return publicReview(record);
    });
  }

  async function result({session, reviewId, waitMs = 0}) {
    const record = records.get(reviewId);
    if (!record) throw Error('Unknown review');
    own(session, record);
    if (record.status === 'reviewing' && record.workerId) {
      const value = await workers.result({session: sessionFor(record), workerId: record.workerId, waitMs: Math.min(waitMs, 25000)});
      await processWorkerValue(record, value);
    }
    return publicReview(record);
  }

  async function continueReview({session, reviewId, confirmVisibility}) {
    return withQueue(reviewId, async () => {
      const record = records.get(reviewId);
      if (!record) throw Error('Unknown review');
      own(session, record);
      if (record.status !== 'awaiting-visibility') throw Error('Review is not awaiting-visibility');
      if (confirmVisibility !== true) throw Error('Visibility must be confirmed');
      const snapshotPath = await snapshot(record);
      const constraints = await readConstraints(record.projectPath);
      const previous = record.rounds.length ? JSON.stringify(record.rounds.at(-1), null, 2) : '';
      const prompt = record.round === 1
        ? buildReviewPrompt({snapshotPath, projectPath: record.projectPath, planPath: record.planPath, round: record.round, focus: record.focus, previous, constraints})
        : buildResponsePrompt({snapshotPath, projectPath: record.projectPath, planPath: record.planPath, round: record.round, previous, constraints});
      await workers.turn({session: sessionFor(record), workerId: record.workerId, prompt, timeoutMs: config.turnMs});
      record.status = 'reviewing';
      record.visibility = 'opened';
      save(record);
      return publicReview(record);
    });
  }

  function validateResponses(record, responses) {
    if (!Array.isArray(responses) || responses.length < 1 || responses.length > 20) throw Error('responses must be 1..20 items');
    const openIssues = new Set(record.issues.filter(issue => issue.severity === 'blocker' || issue.severity === 'major').map(issueKey));
    const openQuestions = new Set(record.questions.map(questionKey));
    const seenIssues = new Set();
    const seenQuestions = new Set();
    const normalized = [];
    for (const response of responses) {
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw Error('Invalid response');
      if (response.type === 'issue') {
        if (typeof response.issueId !== 'string' || !openIssues.has(response.issueId)) throw Error('Unknown or resolved issueId');
        if (seenIssues.has(response.issueId)) throw Error('Duplicate issueId');
        if (!['accept', 'reject'].includes(response.decision)) throw Error('Invalid decision');
        if (response.decision === 'accept' && !String(response.planChange ?? '').trim() && !String(response.evidence ?? '').trim()) throw Error('accept needs planChange or evidence');
        if (response.decision === 'reject' && !String(response.evidence ?? '').trim()) throw Error('reject needs evidence');
        for (const field of ['evidence', 'planChange']) {
          if (response[field] !== undefined && (typeof response[field] !== 'string' || response[field].length > 2000)) throw Error('Invalid ' + field);
        }
        seenIssues.add(response.issueId);
        normalized.push({type: 'issue', issueId: response.issueId, decision: response.decision, evidence: response.evidence ?? '', planChange: response.planChange ?? ''});
      } else if (response.type === 'question') {
        if (typeof response.questionId !== 'string' || !openQuestions.has(response.questionId)) throw Error('Unknown questionId');
        if (seenQuestions.has(response.questionId)) throw Error('Duplicate questionId');
        if (typeof response.answer !== 'string' || !response.answer.trim() || response.answer.length > 2000) throw Error('Invalid answer');
        seenQuestions.add(response.questionId);
        normalized.push({type: 'question', questionId: response.questionId, answer: response.answer});
      } else {
        throw Error('Invalid response type');
      }
    }
    for (const id of openIssues) if (!seenIssues.has(id)) throw Error('Missing response for issue ' + id);
    for (const id of openQuestions) if (!seenQuestions.has(id)) throw Error('Missing response for question ' + id);
    if (Buffer.byteLength(JSON.stringify(normalized)) > config.maxResponsesBytes) throw Error('Responses are too large');
    return normalized;
  }

  async function respond({session, reviewId, responses, planPath, expectedRound, requestId}) {
    return withQueue(reviewId, async () => {
      const record = records.get(reviewId);
      if (!record) throw Error('Unknown review');
      own(session, record);
      if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) throw Error('Invalid requestId');
      const fingerprint = JSON.stringify(responses);
      if (record.requests[requestId] !== undefined) {
        if (record.requests[requestId] !== fingerprint) throw Error('requestId reused with different payload');
        return publicReview(record);
      }
      if (record.status !== 'changes-required') throw Error('Review is not awaiting responses');
      if (!Number.isInteger(expectedRound) || expectedRound !== record.round) throw Error('Stale or invalid round');
      const normalized = validateResponses(record, responses);
      const plan = await readPlan({projectPath: record.projectPath, projectId: record.projectId}, planPath ?? record.planPath);
      record.planSnapshot = plan.text;
      record.planHash = plan.parsed.inputHash;
      record.responses = normalized;
      record.requests[requestId] = fingerprint;
      record.round += 1;
      record.status = 'starting';
      save(record);
      await launch(record, {initial: false}).catch(error => {
        if (closed) return;
        record.status = 'failed';
        record.error = error.message;
        save(record);
        void artifact(record);
      });
      return publicReview(record);
    });
  }

  async function decide({session, reviewId, choice}) {
    return withQueue(reviewId, async () => {
      const record = records.get(reviewId);
      if (!record) throw Error('Unknown review');
      own(session, record);
      if (record.status !== 'deadlock') throw Error('Review is not in deadlock');
      if (choice === '0' || choice === 0) {
        record.status = 'cancelled';
        record.error = 'Cancelled by human decision';
        await closeWorker(record);
        save(record);
        return publicReview(record);
      }
      if (choice !== '1' && choice !== 1) throw Error('choice must be 1 or 0');
      if (record.finalRoundUsed) throw Error('Final round was already used');
      record.finalRoundUsed = true;
      record.round += 1;
      record.status = 'starting';
      save(record);
      await launch(record, {initial: false, final: true}).catch(error => {
        if (closed) return;
        record.status = 'failed';
        record.error = error.message;
        save(record);
        void artifact(record);
      });
      return publicReview(record);
    });
  }

  async function recover({session, reviewId, takeover}) {
    return withQueue(reviewId, async () => {
      const record = records.get(reviewId);
      if (!record) throw Error('Unknown review');
      if (record.status !== 'interrupted') throw Error('Review is not interrupted');
      if (session?.id !== record.currentActorSessionId) {
        if (takeover !== true || resolve(session?.projectPath ?? '') !== record.projectPath) throw Error('Takeover is not allowed for this actor');
        record.currentActorSessionId = session.id;
      }
      record.error = null;
      if (record.interruptedFrom === 'changes-required') {
        record.status = 'changes-required';
        save(record);
        return publicReview(record);
      }
      if (record.interruptedFrom === 'awaiting-visibility') {
        record.status = 'awaiting-visibility';
        save(record);
        return publicReview(record);
      }
      record.status = 'starting';
      save(record);
      await launch(record, {initial: false}).catch(error => {
        if (closed) return;
        record.status = 'failed';
        record.error = error.message;
        save(record);
        void artifact(record);
      });
      return publicReview(record);
    });
  }

  function list({session, all = false} = {}) {
    return [...records.values()]
      .filter(record => all || record.currentActorSessionId === session?.id)
      .map(publicReview);
  }

  async function check({projectPath, filePath, mode = 'ask'} = {}) {
    const project = resolve(projectPath);
    const plans = [];
    for (const relativePath of await findPlanFiles(project)) {
      const absolute = join(project, relativePath);
      let text;
      try { text = await readFile(absolute, 'utf8'); } catch { continue; }
      const parsed = parsePlanDeclaration(text);
      const structural = isStructural(parsed);
      if (!structural.required) continue;
      const record = [...records.values()].find(item => item.planPath === relativePath && resolve(item.projectPath) === project);
      const approval = store.getPlanApproval?.(project, relativePath);
      const approved = approval && approval.hashVersion === HASH_VERSION && approval.planHash === parsed.inputHash && ['approved'].includes(approval.status);
      plans.push({path: relativePath, hash: parsed.inputHash, approved, errors: parsed.errors, irreversible: parsed.change.irreversible});
      if (parsed.errors.length && record) return {block: true, mode: 'ask', reason: '受管理计划的声明已损坏：' + relativePath, plans};
      if (approved) continue;
      if (filePath) {
        const target = resolve(project, filePath);
        const planDir = join(project, 'docs', 'superpowers', 'plans') + sep;
        if (target === absolute || target.startsWith(planDir)) continue;
      }
      const deny = parsed.change.irreversible;
      return {
        block: true,
        mode: mode === 'warn' ? 'warn' : deny ? 'deny' : 'ask',
        reason: '结构计划未通过评审：' + relativePath,
        plans
      };
    }
    return {block: false, mode, reason: null, plans};
  }

  async function resume() {
    for (const record of records.values()) {
      if (['starting', 'awaiting-visibility', 'reviewing', 'changes-required'].includes(record.status)) {
        record.interruptedFrom = record.status;
        record.status = 'interrupted';
        record.error = 'daemon restarted';
        save(record);
      }
    }
    if (!timer) {
      timer = setInterval(() => { void reconcile(); }, reconcileMs);
      timer.unref?.();
    }
  }

  function close() {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    state: () => [...records.values()].map(publicReview),
    resume, start, result, respond, decide, continueReview: continueReview, recover, list, check, close,
    reconcile
  };
}
