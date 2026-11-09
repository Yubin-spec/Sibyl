import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {reviewFixture} from './plan-review-test-support.mjs';
import {createPlanReviewService} from './plan-review.mjs';
import {DEFAULT_PLAN_REVIEW, PLAN_REVIEW_OPEN, PLAN_REVIEW_CLOSE, parsePlanDeclaration} from './plan-review-policy.mjs';

const approve = `${PLAN_REVIEW_OPEN}
{"verdict":"approve","summary":"ok","issues":[],"questions":[]}
${PLAN_REVIEW_CLOSE}`;
const changes = `${PLAN_REVIEW_OPEN}
{"verdict":"changes-required","summary":"fix","issues":[{"id":"R1","severity":"major","location":"§1","problem":"p","why":"w","suggestion":"s"}],"questions":[]}
${PLAN_REVIEW_CLOSE}`;
const discuss = `${PLAN_REVIEW_OPEN}
{"verdict":"discuss","summary":"question","issues":[],"questions":["why?"]}
${PLAN_REVIEW_CLOSE}`;

test('approve writes the review section and preserves the input hash', async () => {
  const f = await reviewFixture({verdicts: [approve]});
  try {
    const started = await f.service.start({session: f.session, planPath: f.planPath});
    const done = await f.waitStatus(started.reviewId, 'approved');
    assert.equal(done.status, 'approved');
    const text = await readFile(join(f.project, f.planPath), 'utf8');
    assert.match(text, /review: approved/);
    assert.match(text, /SIBYL_REVIEW_BEGIN/);
    assert.equal(parsePlanDeclaration(text).inputHash, started.planHash);
    assert.ok(f.store.getPlanApproval(f.project, f.planPath));
  } finally {
    await f.cleanup();
  }
});

test('the plan review worker ignores the project routing table', async () => {
  const f = await reviewFixture({verdicts: [approve]});
  try {
    const started = await f.service.start({session: f.session, planPath: f.planPath});
    await f.waitStatus(started.reviewId, 'approved');
    assert.equal(f.fake.workers[0].input.useProjectPolicy, false);
    assert.equal(f.fake.workers[0].input.model, 'gpt-6-astra');
    assert.equal(f.fake.workers[0].input.effort, 'ultra');
  } finally {
    await f.cleanup();
  }
});

test('a configured reviewerModel is passed to the review worker', async () => {
  const f = await reviewFixture({verdicts: [approve], config: {reviewerModel: 'gpt-6-luna', reviewerEffort: 'high'}});
  try {
    const started = await f.service.start({session: f.session, planPath: f.planPath});
    await f.waitStatus(started.reviewId, 'approved');
    assert.equal(f.fake.workers[0].input.model, 'gpt-6-luna');
    assert.equal(f.fake.workers[0].input.useProjectPolicy, false);
  } finally {
    await f.cleanup();
  }
});

test('changes-required then respond approves on round 2', async () => {
  const f = await reviewFixture({verdicts: [changes, approve]});
  try {
    const started = await f.service.start({session: f.session, planPath: f.planPath});
    await f.waitStatus(started.reviewId, 'changes-required');
    await f.service.respond({
      session: f.session,
      reviewId: started.reviewId,
      responses: [{type: 'issue', issueId: 'R1', decision: 'accept', evidence: 'fixed'}],
      expectedRound: 1,
      requestId: 'req-1'
    });
    await f.waitStatus(started.reviewId, 'approved');
    assert.equal(f.fake.startCount, 2);
  } finally {
    await f.cleanup();
  }
});

test('three rounds deadlock and the final human round is one-shot', async () => {
  const f = await reviewFixture({verdicts: [changes, changes, changes, approve]});
  try {
    const started = await f.service.start({session: f.session, planPath: f.planPath});
    for (const round of [1, 2]) {
      await f.waitStatus(started.reviewId, 'changes-required');
      await f.service.respond({
        session: f.session,
        reviewId: started.reviewId,
        responses: [{type: 'issue', issueId: 'R1', decision: 'reject', evidence: 'still wrong'}],
        expectedRound: round,
        requestId: 'r' + round
      });
    }
    const deadlock = await f.waitStatus(started.reviewId, 'deadlock');
    assert.equal(deadlock.finalRoundUsed, false);
    const final = await f.service.decide({session: f.session, reviewId: started.reviewId, choice: '1'});
    assert.equal(final.finalRoundUsed, true);
    await assert.rejects(f.service.decide({session: f.session, reviewId: started.reviewId, choice: '1'}), /deadlock|final/i);
    await f.waitStatus(started.reviewId, 'approved');
    assert.equal(f.fake.workers.length, 4);
    for (const worker of f.fake.workers.slice(0, 3)) {
      assert.equal(worker.input.useProjectPolicy, false);
      assert.equal(worker.input.model, 'gpt-6-astra');
      assert.equal(worker.input.kind, 'review');
      assert.equal(worker.input.risk, 'high');
      assert.equal(worker.input.effort, 'ultra');
    }
    assert.equal(f.fake.workers[3].input.model, 'gpt-6-astra');
    assert.equal(f.fake.workers[3].input.effort, 'ultra');
    assert.equal(f.fake.workers[3].input.useProjectPolicy, false);
  } finally {
    await f.cleanup();
  }
});

test('an unparseable verdict fails and keeps the raw text', async () => {
  const f = await reviewFixture({verdicts: ['not a verdict']});
  try {
    const started = await f.service.start({session: f.session, planPath: f.planPath});
    const done = await f.waitStatus(started.reviewId, 'failed');
    assert.match(done.error, /verdict/i);
    assert.match(done.rawVerdict, /not a verdict/);
  } finally {
    await f.cleanup();
  }
});

test('restart from changes-required keeps waiting and a same-project actor can take over', async () => {
  const f = await reviewFixture({verdicts: [changes, approve]});
  try {
    const started = await f.service.start({session: f.session, planPath: f.planPath});
    const before = await f.waitStatus(started.reviewId, 'changes-required');
    f.service.close();
    const reopened = createPlanReviewService({
      store: f.store,
      workers: f.fake,
      config: {...DEFAULT_PLAN_REVIEW},
      focusThread: async () => 'opened',
      readConstraints: async () => '',
      reconcileMs: 10
    });
    await reopened.resume();
    const interrupted = reopened.list({session: f.session, all: true}).find(item => item.id === started.reviewId);
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.interruptedFrom, 'changes-required');
    const other = {...f.session, id: 's2'};
    const recovered = await reopened.recover({session: other, reviewId: started.reviewId, takeover: true});
    assert.equal(recovered.status, 'changes-required');
    assert.equal(recovered.currentActorSessionId, 's2');
    assert.equal(recovered.round, before.round);
    assert.equal(recovered.deadline, before.deadline);
    assert.equal(recovered.finalRoundUsed, before.finalRoundUsed);
    assert.equal(recovered.workerId, before.workerId);
    await assert.rejects(reopened.result({session: f.session, reviewId: started.reviewId}), /actor/i);
    reopened.close();
  } finally {
    await f.cleanup();
  }
});

test('restart from reviewing waits for a new visible thread before sending a turn', async () => {
  const f = await reviewFixture({
    verdicts: [approve],
    hold: true,
    focus: ({threadId}) => threadId === 't1' ? 'opened' : 'unknown'
  });
  try {
    const started = await f.service.start({session: f.session, planPath: f.planPath});
    await f.waitStatus(started.reviewId, 'reviewing');
    f.service.close();
    const reopened = createPlanReviewService({
      store: f.store,
      workers: f.fake,
      config: {...DEFAULT_PLAN_REVIEW},
      focusThread: async ({threadId}) => threadId === 't1' ? 'opened' : 'unknown',
      readConstraints: async () => '',
      reconcileMs: 10
    });
    await reopened.resume();
    const interrupted = reopened.list({session: f.session, all: true}).find(item => item.id === started.reviewId);
    assert.equal(interrupted.status, 'interrupted');
    await assert.rejects(reopened.continueReview({session: f.session, reviewId: started.reviewId, confirmVisibility: true}), /awaiting-visibility/);
    const baseline = f.fake.turnCount;
    const recovered = await reopened.recover({session: f.session, reviewId: started.reviewId});
    assert.equal(recovered.status, 'awaiting-visibility');
    assert.notEqual(recovered.workerId, started.workerId);
    assert.notEqual(recovered.threadId, started.threadId);
    assert.equal(f.fake.turnCount, baseline);
    const continued = await reopened.continueReview({session: f.session, reviewId: started.reviewId, confirmVisibility: true});
    assert.equal(continued.status, 'reviewing');
    assert.equal(f.fake.turnCount, baseline + 1);
    await assert.rejects(reopened.continueReview({session: f.session, reviewId: started.reviewId, confirmVisibility: true}), /awaiting-visibility/);
    assert.equal(f.fake.turnCount, baseline + 1);
    f.fake.complete();
    await reopened.result({session: f.session, reviewId: started.reviewId, waitMs: 10});
    reopened.close();
  } finally {
    await f.cleanup();
  }
});

test('visibility is not confirmed until continue; no turn is sent before that', async () => {
  const f = await reviewFixture({verdicts: [approve], focus: false});
  try {
    const started = await f.service.start({session: f.session, planPath: f.planPath});
    await f.waitStatus(started.reviewId, 'awaiting-visibility');
    assert.equal(f.fake.turnCount, 0);
    const continued = await f.service.continueReview({session: f.session, reviewId: started.reviewId, confirmVisibility: true});
    assert.equal(continued.status, 'reviewing');
    assert.equal(f.fake.turnCount, 1);
    f.fake.complete();
    await f.service.result({session: f.session, reviewId: started.reviewId, waitMs: 10});
  } finally {
    await f.cleanup();
  }
});

test('question-only responses are accepted and coverage is enforced', async () => {
  const f = await reviewFixture({verdicts: [discuss, approve]});
  try {
    const started = await f.service.start({session: f.session, planPath: f.planPath});
    await f.waitStatus(started.reviewId, 'changes-required');
    await assert.rejects(f.service.respond({
      session: f.session, reviewId: started.reviewId, responses: [], expectedRound: 1, requestId: 'empty'
    }), /responses/);
    await f.service.respond({
      session: f.session,
      reviewId: started.reviewId,
      responses: [{type: 'question', questionId: 'Q1', answer: 'because'}],
      expectedRound: 1,
      requestId: 'q1'
    });
    await f.waitStatus(started.reviewId, 'approved');
  } finally {
    await f.cleanup();
  }
});

test('concurrent respond with the same requestId only advances one round', async () => {
  const f = await reviewFixture({verdicts: [changes, approve]});
  try {
    const started = await f.service.start({session: f.session, planPath: f.planPath});
    await f.waitStatus(started.reviewId, 'changes-required');
    const responses = [{type: 'issue', issueId: 'R1', decision: 'accept', evidence: 'fixed'}];
    await Promise.all([
      f.service.respond({session: f.session, reviewId: started.reviewId, responses, expectedRound: 1, requestId: 'same'}),
      f.service.respond({session: f.session, reviewId: started.reviewId, responses, expectedRound: 1, requestId: 'same'})
    ]);
    assert.equal(f.fake.startCount, 2);
    await f.waitStatus(started.reviewId, 'approved');
  } finally {
    await f.cleanup();
  }
});

test('respond rejects missing, unknown and duplicate references', async () => {
  const f = await reviewFixture({verdicts: [changes, approve]});
  try {
    const started = await f.service.start({session: f.session, planPath: f.planPath});
    await f.waitStatus(started.reviewId, 'changes-required');
    await assert.rejects(f.service.respond({
      session: f.session, reviewId: started.reviewId, responses: [{type: 'issue', issueId: 'R9', decision: 'accept', evidence: 'x'}], expectedRound: 1, requestId: 'u'
    }), /Unknown|Missing/);
    await assert.rejects(f.service.respond({
      session: f.session, reviewId: started.reviewId,
      responses: [
        {type: 'issue', issueId: 'R1', decision: 'accept', evidence: 'x'},
        {type: 'issue', issueId: 'R1', decision: 'accept', evidence: 'x'}
      ], expectedRound: 1, requestId: 'd'
    }), /Duplicate/);
    await assert.rejects(f.service.respond({
      session: f.session, reviewId: started.reviewId, responses: [], expectedRound: 1, requestId: 'm'
    }), /responses/);
  } finally {
    await f.cleanup();
  }
});

test('check blocks an unapproved structural plan but allows editing the plan itself', async () => {
  const f = await reviewFixture({verdicts: [approve]});
  try {
    const blocked = await f.service.check({projectPath: f.project, filePath: 'src/a.mjs'});
    assert.equal(blocked.block, true);
    assert.equal(blocked.mode, 'ask');
    const planEdit = await f.service.check({projectPath: f.project, filePath: f.planPath});
    assert.equal(planEdit.block, false);
    const warned = await f.service.check({projectPath: f.project, filePath: 'src/a.mjs', mode: 'warn'});
    assert.equal(warned.mode, 'warn');
    const started = await f.service.start({session: f.session, planPath: f.planPath});
    await f.waitStatus(started.reviewId, 'approved');
    const allowed = await f.service.check({projectPath: f.project, filePath: 'src/a.mjs'});
    assert.equal(allowed.block, false);
  } finally {
    await f.cleanup();
  }
});

test('non-structural plans do not create a review', async () => {
  const f = await reviewFixture({verdicts: [approve]});
  try {
    await assert.rejects(
      f.service.start({session: f.session, planPath: 'docs/superpowers/plans/missing.md'}),
      /not found/i
    );
    const plain = join(f.project, 'docs/superpowers/plans/plain.md');
    await writeFile(plain, '---\nreview: not-required\n---\n# Plain\n');
    const result = await f.service.start({session: f.session, planPath: 'docs/superpowers/plans/plain.md'});
    assert.equal(result.required, false);
    assert.equal(result.reviewId, null);
  } finally {
    await f.cleanup();
  }
});
