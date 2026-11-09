import test from 'node:test';
import assert from 'node:assert/strict';
import {observerTime, observerVerdict, observerPipelineStats, observerTimelineItems} from './observer-model.mjs';

const state = {
  planReviews: [
    {reviewId: 'r1', planPath: 'docs/a.md', status: 'changes-required', round: 2, maxRounds: 3, verdict: {verdict: 'changes-required'}, issues: [{id: 'R1'}], updatedAt: '2026-11-09T03:00:00.000Z'},
    {reviewId: 'r2', planPath: 'docs/b.md', status: 'approved', round: 1, maxRounds: 3, verdict: 'approve', updatedAt: '2026-11-09T01:00:00.000Z'}
  ],
  workers: [{workerId: 'w1', tool: 'codex', tier: 'dispatch', status: 'running', turns: 1, startedAt: '2026-11-09T02:00:00.000Z', updatedAt: '2026-11-09T02:30:00.000Z'}],
  consultations: [],
  operations: [],
  attention: [{key: 'pair:p1', kind: 'pair', title: '配对请求', at: null}]
};

test('timeline keeps untimed items and sorts valid timestamps newest first', () => {
  const items = observerTimelineItems(state);
  assert.deepEqual(items.map(item => item.stage), ['计划评审', '工作方', '计划评审', '待处理']);
  assert.equal(items.at(-1).at, null);
  assert.equal(items[0].needsResponse, true);
  assert.equal(items[0].anchor, 'observer-review-r1');
});

test('pipeline counts active reviews and folds awaiting responses into the needs-you stage', () => {
  assert.deepEqual(observerPipelineStats(state), {reviews: 1, needingResponse: 1, workers: 1, attention: 2});
});

test('verdict accepts objects and strings', () => {
  assert.equal(observerVerdict(state.planReviews[0]), 'changes-required');
  assert.equal(observerVerdict(state.planReviews[1]), 'approve');
  assert.equal(observerVerdict({}), '');
});

test('observerTime tolerates missing and invalid timestamps', () => {
  assert.equal(observerTime(null), '');
  assert.equal(observerTime('not-a-date'), '');
  assert.match(observerTime('2026-11-09T03:04:05.000Z'), /^\d{2}:\d{2}$|^\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('empty state produces no timeline items', () => {
  assert.deepEqual(observerTimelineItems({}), []);
  assert.deepEqual(observerPipelineStats({}), {reviews: 0, needingResponse: 0, workers: 0, attention: 0});
});
