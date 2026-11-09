import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gateWorkerStart} from './worker-gate.mjs';
import {openNativeInbox} from './native-inbox.mjs';
import {createPlanReviewService} from './plan-review.mjs';

test('consult bypasses the gate without calling check', async () => {
  let called = false;
  const result = await gateWorkerStart({tier: 'consult', projectPath: '/p', check: async () => { called = true; return {block: true}; }});
  assert.deepEqual(result, {allowed: true});
  assert.equal(called, false);
});

test('a write tier is refused while a structural plan is unapproved', async () => {
  const seen = [];
  const check = async input => {
    seen.push(input);
    return {block: true, mode: 'ask', reason: '结构计划未通过评审：demo.plan.md', plans: [{path: 'demo.plan.md', approved: false}]};
  };
  assert.deepEqual(await gateWorkerStart({tier: 'dispatch', projectPath: '/p', check}),
    {allowed: false, reason: '结构计划未通过评审：demo.plan.md'});
  assert.equal((await gateWorkerStart({tier: 'parallel', projectPath: '/p', check})).allowed, false);
  assert.deepEqual(seen[0], {projectPath: '/p', strict: true});
});

test('a write tier passes only on an explicit block:false result', async () => {
  const check = async () => ({block: false, mode: 'ask', reason: null, plans: []});
  assert.deepEqual(await gateWorkerStart({tier: 'dispatch', projectPath: '/p', check}), {allowed: true});
  for (const result of [{}, {error: 'unavailable'}, {block: 'true'}, null, []]) {
    const denied = await gateWorkerStart({tier: 'dispatch', projectPath: '/p', check: async () => result});
    assert.equal(denied.allowed, false, JSON.stringify(result));
    assert.match(denied.reason, /invalid result/i);
  }
});

test('the refusal names the blocking plan even without a reason', async () => {
  const check = async () => ({block: true, plans: [{path: 'docs/superpowers/plans/demo.md', approved: false}]});
  const result = await gateWorkerStart({tier: 'dispatch', projectPath: '/p', check});
  assert.equal(result.allowed, false);
  assert.match(result.reason, /docs\/superpowers\/plans\/demo\.md/);
});

test('a write tier without a project is refused', async () => {
  const result = await gateWorkerStart({tier: 'dispatch', check: async () => ({block: false})});
  assert.equal(result.allowed, false);
  assert.match(result.reason, /project/i);
});

test('the gate fails closed when the review service is missing or throws', async () => {
  assert.equal((await gateWorkerStart({tier: 'dispatch', projectPath: '/p'})).allowed, false);
  const thrown = await gateWorkerStart({tier: 'dispatch', projectPath: '/p', check: async () => { throw Error('boom'); }});
  assert.equal(thrown.allowed, false);
  assert.match(thrown.reason, /plan review/i);
  assert.match(thrown.reason, /boom/);
});

async function startInbox({worker, planReview}) {
  const dir = await mkdtemp(join(tmpdir(), 'worker-gate-inbox-'));
  const inbox = await openNativeInbox({dir, worker, planReview});
  const runtime = JSON.parse(await readFile(join(dir, 'native-runtime.json'), 'utf8'));
  const post = async (path, body) => {
    const response = await fetch(new URL(path, runtime.url), {method: 'POST',
      headers: {authorization: 'Bearer ' + runtime.token, 'content-type': 'application/json'}, body: JSON.stringify(body)});
    return {status: response.status, value: await response.json()};
  };
  const registered = await post('/register', {tool: 'codex', title: 't', projectPath: process.cwd()});
  return {dir, inbox, post, session: {id: registered.value.id, lease: registered.value.lease}};
}

test('the inbox refuses dispatch and parallel but still starts consult', async () => {
  const starts = [], checks = [];
  const {dir, inbox, post, session} = await startInbox({
    worker: {start: async input => { starts.push(input); return {workerId: '11111111-1111-1111-1111-111111111111', status: 'starting'}; }},
    planReview: {check: async input => {
      checks.push(input);
      return {block: true, mode: 'ask', reason: '结构计划未通过评审：demo.plan.md', plans: [{path: 'demo.plan.md', approved: false}]};
    }}
  });
  try {
    const dispatch = await post('/worker/start', {...session, tool: 'codex', tier: 'dispatch', scope: ['a.mjs']});
    assert.equal(dispatch.status, 400);
    assert.match(dispatch.value.error, /demo\.plan\.md/);
    const parallel = await post('/worker/start', {...session, tool: 'codex', tier: 'parallel', scope: ['a.mjs']});
    assert.equal(parallel.status, 400);
    assert.equal(starts.length, 0);
    assert.equal(checks.length, 2);
    assert.deepEqual(checks[0], {projectPath: process.cwd(), strict: true});

    const consult = await post('/worker/start', {...session, tool: 'codex', tier: 'consult'});
    assert.equal(consult.status, 202, JSON.stringify(consult.value));
    assert.equal(starts.length, 1);
  } finally { await inbox.close(); await rm(dir, {recursive: true, force: true}); }
});

for (const [label, planReview, pattern] of [
  ['missing', undefined, /plan review/i],
  ['throwing', {check: async () => { throw Error('boom'); }}, /boom/]
]) {
  test(`a ${label} plan reviewer still allows consult but not dispatch`, async () => {
    const starts = [];
    const {dir, inbox, post, session} = await startInbox({
      worker: {start: async input => { starts.push(input); return {workerId: 'w'}; }},
      planReview
    });
    try {
      const dispatch = await post('/worker/start', {...session, tool: 'codex', tier: 'dispatch', scope: ['a.mjs']});
      assert.equal(dispatch.status, 400);
      assert.match(dispatch.value.error, pattern);
      assert.equal(starts.length, 0);
      assert.equal((await post('/worker/start', {...session, tool: 'codex', tier: 'consult'})).status, 202);
      assert.equal(starts.length, 1);
    } finally { await inbox.close(); await rm(dir, {recursive: true, force: true}); }
  });
}

const fakeStore = () => ({
  listPlanReviews: () => [],
  savePlanReview: () => {},
  getPlanApproval: () => null
});

function serviceWith(fileSystem) {
  return createPlanReviewService({store: fakeStore(), workers: {}, fileSystem});
}

test('strict check scans only managed plan paths and surfaces managed failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worker-gate-strict-'));
  const plansDir = join(dir, 'docs', 'superpowers', 'plans');
  const cacheDir = join(dir, 'unrelated-cache');
  await mkdir(plansDir, {recursive: true});
  await mkdir(cacheDir, {recursive: true});
  const planText = '---\nreview: required\n---\n# Demo plan\n';
  try {
    const plain = serviceWith();
    assert.equal((await plain.check({projectPath: dir})).block, false);
    assert.equal((await plain.check({projectPath: dir, strict: true})).block, false);

    const calls = [];
    const deny = (...names) => {
      const error = Object.assign(Error('EACCES: ' + names.join(',')), {code: 'EACCES'});
      return error;
    };
    const readdirSpy = async (path, options) => {
      calls.push(path);
      if (path === plansDir) throw deny('plans');
      if (path.includes('unrelated-cache')) throw deny('unrelated-cache');
      return readdir(path, options);
    };
    const scanFail = serviceWith({readdir: readdirSpy});
    calls.length = 0;
    await assert.rejects(scanFail.check({projectPath: dir, strict: true}), error =>
      /docs\/superpowers\/plans/.test(error.message) && /EACCES/.test(error.message));
    assert.ok(calls.every(path => !path.includes('unrelated-cache')), 'strict scan must not enter unrelated directories');
    assert.equal((await scanFail.check({projectPath: dir})).block, false);

    await writeFile(join(plansDir, 'demo.md'), planText);
    const readSpy = async path => {
      if (path.endsWith('demo.md')) throw deny('demo.md');
      return readFile(path, 'utf8');
    };
    const readFail = serviceWith({readFile: readSpy});
    await assert.rejects(readFail.check({projectPath: dir, strict: true}), error =>
      /demo\.md/.test(error.message) && /EACCES/.test(error.message));
    assert.equal((await readFail.check({projectPath: dir})).block, false);

    const gate = await gateWorkerStart({tier: 'dispatch', projectPath: dir, check: input => readFail.check(input)});
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /demo\.md/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
