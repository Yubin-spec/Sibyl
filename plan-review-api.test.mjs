import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openNativeInbox} from './native-inbox.mjs';

const reviewId = '11111111-1111-1111-1111-111111111111';

function fakePlanReview() {
  const calls = [];
  return {
    calls,
    check: async input => { calls.push(['check', input]); return {block: true, mode: 'ask', reason: '需要评审', plans: []}; },
    start: async input => { calls.push(['start', input]); return {reviewId, status: 'starting', projectPath: input.session.projectPath}; },
    result: async input => { calls.push(['result', input]); return {reviewId, status: 'changes-required', actor: input.session.id}; },
    respond: async input => { calls.push(['respond', input]); return {reviewId, responses: input.responses}; },
    decide: async input => { calls.push(['decide', input]); return {reviewId, choice: input.choice}; },
    continueReview: async input => { calls.push(['continue', input]); return {reviewId, status: 'reviewing'}; },
    recover: async input => { calls.push(['recover', input]); return {reviewId, takeover: input.takeover}; },
    list: async input => { calls.push(['list', input]); return [{reviewId, actor: input.session.id}]; }
  };
}

test('plan review endpoints separate token-only checks from session leases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plan-review-api-'));
  const planReview = fakePlanReview();
  const inbox = await openNativeInbox({dir, planReview});
  try {
    const runtime = JSON.parse(await readFile(join(dir, 'native-runtime.json'), 'utf8'));
    const post = async (path, body, token = runtime.token) => {
      const response = await fetch(new URL(path, runtime.url), {
        method: 'POST',
        headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'},
        body: JSON.stringify(body)
      });
      const value = await response.json();
      return {status: response.status, value};
    };
    const registered = await post('/register', {tool: 'claude', title: 't', projectPath: process.cwd()});
    const session = {id: registered.value.id, lease: registered.value.lease};

    const check = await post('/plan-review/check', {protocol: 'plan-review/v1', projectPath: process.cwd(), filePath: 'src/a.mjs'});
    assert.equal(check.status, 200);
    assert.equal(check.value.block, true);
    assert.equal(planReview.calls.at(-1)[0], 'check');
    assert.equal((await post('/plan-review/check', {protocol: 'nope', projectPath: process.cwd()})).status, 400);

    const started = await post('/plan-review/start', {protocol: 'plan-review/v1', ...session, planPath: 'docs/x.md'});
    assert.equal(started.status, 202, JSON.stringify(started.value));
    assert.equal(started.value.reviewId, reviewId);
    assert.equal(planReview.calls.at(-1)[1].session.projectPath, process.cwd());
    assert.equal((await post('/plan-review/start', {protocol: 'plan-review/v1', id: session.id, lease: 'wrong', planPath: 'docs/x.md'})).status, 400);

    const result = await post('/plan-review/result', {protocol: 'plan-review/v1', ...session, reviewId, waitMs: 0});
    assert.equal(result.status, 200);
    assert.equal(result.value.status, 'changes-required');
    assert.equal((await post('/plan-review/result', {protocol: 'plan-review/v1', ...session, reviewId, waitMs: 30000})).status, 400);

    const responses = [{type: 'issue', issueId: 'R1', decision: 'accept', evidence: 'fixed'}];
    const responded = await post('/plan-review/respond', {protocol: 'plan-review/v1', ...session, reviewId, responses, expectedRound: 1, requestId: 'r1'});
    assert.equal(responded.status, 200);
    assert.deepEqual(responded.value.responses, responses);
    assert.equal((await post('/plan-review/respond', {protocol: 'plan-review/v1', ...session, reviewId, responses: [], expectedRound: 1, requestId: 'r2'})).status, 400);
    assert.equal((await post('/plan-review/respond', {protocol: 'plan-review/v1', ...session, reviewId, responses, expectedRound: 1, requestId: 'r3', planPath: 'x'.repeat(2000)})).status, 400);

    assert.equal((await post('/plan-review/decide', {protocol: 'plan-review/v1', ...session, reviewId, choice: '2'})).status, 400);
    assert.equal((await post('/plan-review/decide', {protocol: 'plan-review/v1', ...session, reviewId, choice: '1'})).status, 200);

    assert.equal((await post('/plan-review/continue', {protocol: 'plan-review/v1', ...session, reviewId, confirmVisibility: false})).status, 400);
    assert.equal((await post('/plan-review/continue', {protocol: 'plan-review/v1', ...session, reviewId, confirmVisibility: true})).status, 200);
    assert.equal((await post('/plan-review/recover', {protocol: 'plan-review/v1', ...session, reviewId, takeover: 'yes'})).status, 400);
    assert.equal((await post('/plan-review/recover', {protocol: 'plan-review/v1', ...session, reviewId, takeover: true})).status, 200);

    const list = await post('/plan-review/list', {protocol: 'plan-review/v1', ...session, all: true});
    assert.equal(list.status, 200);
    assert.equal(list.value.reviews[0].reviewId, reviewId);
    assert.equal((await post('/plan-review/list', {protocol: 'plan-review/v1', ...session, all: 'yes'})).status, 400);
  } finally {
    await inbox.close();
    await rm(dir, {recursive: true, force: true});
  }
});
