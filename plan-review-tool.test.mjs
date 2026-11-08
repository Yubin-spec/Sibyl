import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openNativeInbox} from './native-inbox.mjs';
import {mcpClient} from './worker-test-support.mjs';

const reviewId = '22222222-2222-2222-2222-222222222222';

test('plan review MCP tools forward JSON and reject malformed arguments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plan-review-tool-'));
  const project = join(dir, 'project');
  await mkdir(project);
  const calls = [];
  const planReview = {
    check: async input => { calls.push(['check', input]); return {block: true, mode: 'ask', reason: 'review', plans: []}; },
    start: async input => { calls.push(['start', input]); return {reviewId, status: 'starting'}; },
    result: async input => { calls.push(['result', input]); return {reviewId, status: 'changes-required'}; },
    respond: async input => { calls.push(['respond', input]); return {reviewId, responses: input.responses}; },
    decide: async input => { calls.push(['decide', input]); return {reviewId, choice: input.choice}; },
    continueReview: async input => { calls.push(['continue', input]); return {reviewId, status: 'reviewing'}; },
    recover: async input => { calls.push(['recover', input]); return {reviewId, takeover: input.takeover}; },
    list: async input => { calls.push(['list', input]); return [{reviewId, actor: input.session.id}]; }
  };
  const inbox = await openNativeInbox({dir, planReview});
  const client = mcpClient(dir, 'claude', project);
  try {
    const listed = await client.call('tools/list');
    for (const name of ['bridge_plan_review', 'bridge_plan_review_result', 'bridge_plan_review_respond', 'bridge_plan_review_decide', 'bridge_plan_review_continue', 'bridge_plan_review_recover', 'bridge_plan_review_list']) {
      assert.ok(listed.tools.some(tool => tool.name === name), name);
    }
    const started = await client.tool('bridge_plan_review', {planPath: 'docs/x.md'});
    assert.equal(started.reviewId, reviewId);
    const result = await client.tool('bridge_plan_review_result', {reviewId, waitMs: 0});
    assert.equal(result.status, 'changes-required');
    const responses = [{type: 'issue', issueId: 'R1', decision: 'accept', evidence: 'fixed'}];
    const responded = await client.tool('bridge_plan_review_respond', {
      reviewId, responses: JSON.stringify(responses), expectedRound: 1, requestId: 'r1'
    });
    assert.deepEqual(responded.responses, responses);
    await assert.rejects(client.tool('bridge_plan_review_respond', {
      reviewId, responses: 'not json', expectedRound: 1, requestId: 'r2'
    }), /valid JSON/);
    await assert.rejects(client.tool('bridge_plan_review_decide', {reviewId, choice: '2'}), /Invalid choice/);
    const list = await client.tool('bridge_plan_review_list', {all: true});
    assert.equal(list.reviews[0].reviewId, reviewId);
    assert.equal((await client.tool('bridge_plan_review_continue', {reviewId, confirmVisibility: true})).status, 'reviewing');
    assert.equal((await client.tool('bridge_plan_review_recover', {reviewId, takeover: true})).takeover, true);
  } finally {
    await client.close();
    await inbox.close();
    await rm(dir, {recursive: true, force: true});
  }
});
