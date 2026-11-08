import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {workerFixture, registerNative, wait} from './worker-test-support.mjs';

test('control wires plan review from HTTP through approval', async () => {
  const f = await workerFixture('review', {focusThread: async () => 'opened'});
  try {
    const planPath = 'docs/superpowers/plans/demo.md';
    await mkdir(join(f.project, 'docs', 'superpowers', 'plans'), {recursive: true});
    await writeFile(join(f.project, planPath), `---
review: required
change:
  scope: [api]
---
# Demo

body
`);
    const native = await registerNative(f);
    const started = await native.call('/plan-review/start', {protocol: 'plan-review/v1', planPath});
    assert.ok(started.reviewId);
    const done = await wait(async () => {
      const value = await native.call('/plan-review/result', {
        protocol: 'plan-review/v1', reviewId: started.reviewId, waitMs: 100
      });
      return value.status === 'approved' ? value : null;
    });
    assert.equal(done.status, 'approved');
    const text = await readFile(join(f.project, planPath), 'utf8');
    assert.match(text, /review: approved/);
    assert.match(text, /SIBYL_REVIEW_BEGIN/);
    const state = await f.call('/api/status');
    assert.equal(state.planReviews.find(item => item.reviewId === started.reviewId).status, 'approved');
  } finally {
    await f.close();
  }
});
