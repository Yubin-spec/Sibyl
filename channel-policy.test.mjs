import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_LIMITS, newChannelState, checkBudget, accept, shouldStop, parseReply, composePrompt} from './channel-policy.mjs';

const at = 1_000_000;

test('budget allows the twentieth message and denies the twenty-first', () => {
  const state = newChannelState({maxMessages: 2});
  for (const text of ['a', 'b']) {
    assert.deepEqual(checkBudget(state, {agent: 'local', now: at}), {allow: true});
    assert.deepEqual(accept(state, {agent: 'local', text, now: at}), {allow: true});
  }
  assert.equal(state.messages, 2);
  assert.deepEqual(checkBudget(state, {agent: 'local', now: at}), {allow: false, reason: 'budget'});
  assert.equal(shouldStop(state, {now: at, busy: false}), 'budget');
});

test('per-agent turn cap cannot be bypassed by the other side', () => {
  const state = newChannelState({maxTurnsPerAgent: 1, maxMessages: 10});
  accept(state, {agent: 'remote', text: 'hi', now: at});
  assert.equal(checkBudget(state, {agent: 'remote', now: at}).reason, 'budget');
  assert.equal(checkBudget(state, {agent: 'local', now: at}).allow, true);
});

test('duration is measured from the first accepted turn', () => {
  const state = newChannelState({maxDurationMs: 1000});
  assert.equal(checkBudget(state, {agent: 'local', now: at}).allow, true);
  assert.equal(shouldStop(state, {now: at + 500, busy: false}), null);
  accept(state, {agent: 'local', text: 'a', now: at});
  assert.equal(shouldStop(state, {now: at + 1001, busy: false}), 'timeout');
});

test('three consecutive identical replies stop the channel', () => {
  const state = newChannelState();
  assert.equal(accept(state, {agent: 'local', text: 'same', now: at}).allow, true);
  assert.equal(accept(state, {agent: 'local', text: 'same', now: at}).allow, true);
  assert.deepEqual(accept(state, {agent: 'local', text: 'same', now: at}), {allow: false, reason: 'duplicate'});
  assert.equal(state.messages, 2);
});

test('a different reply resets the duplicate streak', () => {
  const state = newChannelState();
  accept(state, {agent: 'local', text: 'a', now: at});
  accept(state, {agent: 'local', text: 'a', now: at});
  accept(state, {agent: 'local', text: 'b', now: at});
  assert.equal(accept(state, {agent: 'local', text: 'a', now: at}).allow, true);
});

test('idle only fires when nothing is running', () => {
  const state = newChannelState({idleTimeoutMs: 100});
  accept(state, {agent: 'local', text: 'a', now: at});
  assert.equal(shouldStop(state, {now: at + 101, busy: true}), null);
  assert.equal(shouldStop(state, {now: at + 101, busy: false}), 'idle');
});

test('reply marker is stripped from the outgoing body', () => {
  assert.deepEqual(parseReply('结论如下\n[[END]]'), {body: '结论如下', done: true});
  assert.deepEqual(parseReply('[[end]]'), {body: '', done: true});
  assert.deepEqual(parseReply('普通回复'), {body: '普通回复', done: false});
  assert.deepEqual(parseReply('已完成 [[END]]'), {body: '已完成', done: true});
  assert.deepEqual(parseReply(undefined), {body: '', done: false});
});

test('prompt carries task, messages, digests and the sidecar caveat', () => {
  const prompt = composePrompt({task: '修 bug', self: 'codex', peer: 'claude', messages: [{side: 'remote', text: '进度？'}], digests: ['已回复 A'], sidecar: true});
  assert.match(prompt, /修 bug/);
  assert.match(prompt, /\[remote\] 进度？/);
  assert.match(prompt, /已回复 A/);
  assert.match(prompt, /收件侧线/);
  assert.match(prompt, /只处理下面列出的待处理消息/);
  assert.match(prompt, /不要重做人类主任务/);
  assert.match(prompt, /不要主动提问或扩展话题/);
  assert.match(prompt, /简短答复/);
  assert.match(prompt, /\[\[END\]\]/);
});

test('defaults match the agreed boundaries', () => {
  assert.equal(DEFAULT_LIMITS.maxMessages, 20);
  assert.equal(DEFAULT_LIMITS.maxTurnsPerAgent, 8);
  assert.equal(DEFAULT_LIMITS.maxDurationMs, 600000);
  assert.equal(DEFAULT_LIMITS.idleTimeoutMs, 120000);
  assert.equal(DEFAULT_LIMITS.duplicateLimit, 3);
});
