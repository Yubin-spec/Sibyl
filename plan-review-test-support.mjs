import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPlanReviewService} from './plan-review.mjs';
import {DEFAULT_PLAN_REVIEW} from './plan-review-policy.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function makeFakeWorkers(verdicts, {hold = false} = {}) {
  const workers = [];
  let startCount = 0;
  let turnCount = 0;
  const fake = {
    workers,
    get startCount() { return startCount; },
    get turnCount() { return turnCount; },
    async start(input) {
      const worker = {
        workerId: 'w' + (++startCount),
        threadId: 't' + startCount,
        verdict: verdicts[Math.min(startCount - 1, verdicts.length - 1)],
        completed: false,
        input
      };
      workers.push(worker);
      return {workerId: worker.workerId, threadId: worker.threadId, status: 'running', model: input.model};
    },
    async result({workerId}) {
      const worker = workers.find(item => item.workerId === workerId);
      if (!worker) throw Error('Unknown worker');
      return {
        workerId,
        status: 'running',
        threadId: worker.threadId,
        lastTurn: worker.completed ? {id: 1, status: 'completed', text: worker.verdict} : null
      };
    },
    async turn({workerId, prompt}) {
      turnCount++;
      const worker = workers.find(item => item.workerId === workerId);
      if (!worker) throw Error('Unknown worker');
      worker.prompt = prompt;
      if (!hold) worker.completed = true;
      return {accepted: true};
    },
    async close({workerId}) {
      const worker = workers.find(item => item.workerId === workerId);
      if (worker) worker.closed = true;
      return {status: 'stopped'};
    },
    complete() {
      for (const worker of workers) worker.completed = true;
    }
  };
  return fake;
}

export async function reviewFixture({verdicts, hold = false, focus = true} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'plan-review-'));
  const project = join(root, 'project');
  const planPath = 'docs/superpowers/plans/demo.md';
  await mkdir(join(project, 'docs', 'superpowers', 'plans'), {recursive: true});
  await writeFile(join(project, planPath), `---
review: required
change:
  scope: [api]
  concurrency: true
---
# Demo

body
`);
  const reviews = new Map();
  const approvals = new Map();
  const store = {
    listPlanReviews: () => [...reviews.values()],
    savePlanReview: record => { reviews.set(record.id, {...record}); return record; },
    getPlanApproval: (projectId, path) => approvals.get(projectId + '\0' + path) ?? null,
    savePlanApproval: approval => { approvals.set(approval.projectId + '\0' + approval.planPath, approval); return approval; }
  };
  const fake = makeFakeWorkers(verdicts, {hold});
  const service = createPlanReviewService({
    store,
    workers: fake,
    config: {...DEFAULT_PLAN_REVIEW},
    focusThread: async input => typeof focus === 'function' ? focus(input) : focus ? 'opened' : 'unknown',
    readConstraints: async () => '',
    reconcileMs: 10
  });
  await service.resume();
  const session = {id: 's1', projectPath: project, projectId: 'p1', tool: 'claude'};
  const waitStatus = async (reviewId, status, ms = 5000) => {
    const end = Date.now() + ms;
    let last = null;
    while (Date.now() < end) {
      last = await service.result({session, reviewId, waitMs: 10});
      if (last.status === status) return last;
      await sleep(10);
    }
    throw Error('timed out waiting for ' + status + ' (last ' + last?.status + ')');
  };
  return {
    root, project, planPath, store, approvals, fake, service, session, waitStatus,
    async cleanup() {
      service.close();
      await rm(root, {recursive: true, force: true});
    }
  };
}
