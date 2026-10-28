import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openWorkspace} from './workspace.mjs';
import {runChannel} from './channel.mjs';

async function fixture({limits, runner, connectionId = 'local', remote, credential}) {
  const dir = await mkdtemp(join(tmpdir(), 'channel-'));
  const store = await openWorkspace(dir);
  const project = store.saveProject({name:'p', path:dir});
  const session = store.registerSession({projectId:project.id, tool:'codex', title:'main', nativeSessionId:'m-local'});
  const conversation = store.createConversation({title:'c', projectId:project.id, localSessionId:session.id, connectionId, remoteAgent:'claude', mode:'channel', limits, rounds:1});
  const messages = [], events = [], calls = [];
  let control;
  const message = (id, input) => { const m = store.appendMessage(id, {agent:'', ...input}); messages.push(m); return m; };
  const output = (op, text) => events.push(text);
  const wrapped = async (prompt, sessionId, signal, projectPath, agent) => {
    calls.push({prompt, sessionId, agent});
    return runner(prompt, sessionId, signal, projectPath, agent);
  };
  const run = signal => runChannel({id:conversation.id, task:'修 bug', store, runner:wrapped, message, output, remote, credential, agents:{codex:'test', claude:'test'}, signal, op:{}, register:r => {control = r;}});
  message(conversation.id, {side:'human', text:'修 bug'});
  return {dir, store, project, session, conversation, messages, events, calls, run, control:() => control, close:() => rm(dir, {recursive:true, force:true})};
}

const timeout = ms => new Promise((_, reject) => setTimeout(() => reject(Error('timeout ' + ms)), ms).unref?.());
const within = (promise, ms = 2000) => Promise.race([promise, timeout(ms)]);

test('two agents exchange messages and stop when both end', async () => {
  const f = await fixture({runner: async (prompt, sessionId, signal, path, agent) => {
    if (agent === 'codex') return {session_id:sessionId || 'm-local', result: sessionId === 'm-local' ? '我先查日志' : '收到 [[END]]'};
    return {session_id:sessionId || 'm-remote', result:'我这边已定位 [[END]]'};
  }});
  try {
    const reason = await within(f.run());
    assert.equal(reason, 'done');
    assert.equal(f.store.getConversation(f.conversation.id).stopReason, 'done');
    assert.deepEqual(f.messages.map(m => m.side), ['human', 'local', 'remote', 'local']);
  } finally { await f.close(); }
});

test('message budget stops the channel before the limit is exceeded', async () => {
  let n = 0;
  const f = await fixture({limits:{maxMessages:2}, runner: async (prompt, sessionId) => ({session_id:sessionId || 's', result:'reply ' + (++n)})});
  try {
    const reason = await within(f.run());
    assert.equal(reason, 'budget');
    const c = f.store.getConversation(f.conversation.id);
    assert.equal(c.stopReason, 'budget');
    assert.equal(c.usage.messages, 2);
    assert.equal(f.messages.filter(m => m.side !== 'human').length, 2);
  } finally { await f.close(); }
});

test('three identical agent replies are treated as a loop', async () => {
  const f = await fixture({runner: async (prompt, sessionId) => ({session_id:sessionId || 's', result:'同一句'})});
  try {
    assert.equal(await within(f.run()), 'duplicate');
    assert.equal(f.store.getConversation(f.conversation.id).stopReason, 'duplicate');
  } finally { await f.close(); }
});

test('a busy main turn is not interrupted; a sidecar answers instead', async () => {
  let releaseMain, releaseRemote, n = 0;
  const mainGate = new Promise(resolve => { releaseMain = resolve; });
  const remoteGate = new Promise(resolve => { releaseRemote = resolve; });
  const f = await fixture({runner: async (prompt, sessionId, signal, path, agent) => {
    if (agent === 'codex' && sessionId === 'm-local') { await mainGate; return {session_id:'m-local', result:'主线完成 [[END]]'}; }
    if (agent === 'codex') return {session_id:sessionId || 'inbox-s', result:'侧线答复 ' + (++n) + ' [[END]]'};
    if (!prompt.includes('收件侧线')) { await remoteGate; return {session_id:sessionId || 'm-remote', result:'远端主线 [[END]]'}; }
    return {session_id:sessionId || 'remote-inbox', result:'远端侧线 [[END]]'};
  }});
  try {
    const running = f.run();
    for (let i = 0; i < 100 && !f.calls.some(c => c.sessionId === 'm-local'); i++) await new Promise(r => setTimeout(r, 5));
    assert.ok(f.calls.some(c => c.sessionId === 'm-local'), 'main turn never started');
    f.control().send('补充：先跑测试');
    for (let i = 0; i < 100 && !f.calls.some(c => c.prompt.includes('收件侧线')); i++) await new Promise(r => setTimeout(r, 5));
    const sidecar = f.calls.find(c => c.prompt.includes('收件侧线'));
    assert.ok(sidecar, 'sidecar never ran: ' + JSON.stringify(f.calls.map(c => c.sessionId + ':' + c.prompt.slice(0, 30))));
    assert.match(sidecar.prompt, /收件侧线/);
    assert.match(sidecar.prompt, /补充：先跑测试/);
    assert.match(sidecar.prompt, /\[human\] 补充：先跑测试/);
    assert.doesNotMatch(sidecar.prompt, /\[human\] 修 bug/, 'sidecar must not re-read the message already claimed by the main turn');
    assert.equal(f.calls.filter(c => c.sessionId === 'm-local' && !c.prompt.includes('收件侧线')).length, 1);
    for (let i = 0; i < 100 && !f.messages.some(m => m.text.startsWith('侧线答复')); i++) await new Promise(r => setTimeout(r, 5));
    await new Promise(r => setTimeout(r, 20));
    assert.ok(!f.calls.some(c => c.agent === 'claude' && c.prompt.includes('收件侧线')), 'sidecar reply must not wake a peer sidecar');
    releaseMain();
    releaseRemote();
    assert.equal(await within(running), 'done');
    assert.ok(f.messages.some(m => m.text.startsWith('侧线答复')));
    assert.ok(f.messages.some(m => m.text === '主线完成'));
  } finally { releaseMain(); releaseRemote(); await f.close(); }
});

test('human stop aborts the in-flight turn and records human_stop', async () => {
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const f = await fixture({runner:(prompt, sessionId, signal) => {
    if (sessionId === 'm-local') {
      started();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), {once:true}));
    }
    return {session_id:sessionId || 's', result:'[[END]]'};
  }});
  try {
    const running = f.run();
    await began;
    f.control().stop('human_stop');
    assert.equal(await within(running), 'human_stop');
    assert.equal(f.store.getConversation(f.conversation.id).stopReason, 'human_stop');
  } finally { await f.close(); }
});

test('a sidecar failure keeps its message for the main line', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let main = 0, peer = 0;
  const f = await fixture({runner:async (prompt, sessionId, signal, path, agent) => {
    if (agent === 'codex' && sessionId === 'm-local') {
      main += 1;
      if (main === 1) { await gate; return {session_id:'m-local', result:'主线完成 [[END]]'}; }
      return {session_id:'m-local', result:'已处理补充 [[END]]'};
    }
    if (agent === 'codex') throw Error('sidecar down');
    return {session_id:'m-remote', result: ++peer === 1 ? '远端收到 [[END]]' : '[[END]]'};
  }});
  try {
    const running = f.run();
    for (let i = 0; i < 100 && !f.calls.some(c => c.sessionId === 'm-local'); i++) await new Promise(r => setTimeout(r, 5));
    f.control().send('补充：先跑测试');
    for (let i = 0; i < 100 && !f.events.some(t => t.includes('侧线] 失败')); i++) await new Promise(r => setTimeout(r, 5));
    assert.ok(f.events.some(t => t.includes('侧线] 失败')), 'sidecar failure was not reported');
    release();
    assert.equal(await within(running), 'done');
    const prompts = f.calls.filter(c => c.sessionId === 'm-local').map(c => c.prompt);
    assert.ok(prompts.some(p => p.includes('[human] 补充：先跑测试')), 'unread human message was not delivered to the main line');
    assert.ok(f.messages.some(m => m.text === '已处理补充'));
  } finally { release(); await f.close(); }
});

test('remote main and inbox use distinct rooms accepted by the peer', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const rooms = [];
  let local = 0;
  const f = await fixture({
    connectionId:'peer-1',
    credential:async () => ({url:'http://peer', token:'t'}),
    remote:async (c, prompt, conv) => {
      rooms.push(conv.id);
      if (!prompt.includes('收件侧线')) { await gate; return {result:'远端主线 [[END]]'}; }
      return {result:'[[END]]'};
    },
    runner:async (prompt, sessionId) => ({session_id:sessionId || 'local-1', result:'本机先看 ' + (++local)})
  });
  try {
    const running = f.run();
    for (let i = 0; i < 100 && !rooms.length; i++) await new Promise(r => setTimeout(r, 5));
    f.control().send('补充：先跑测试');
    for (let i = 0; i < 100 && rooms.length < 2; i++) await new Promise(r => setTimeout(r, 5));
    const unique = [...new Set(rooms)];
    assert.equal(unique.length, 2, JSON.stringify(rooms));
    assert.ok(unique.every(room => /^[a-zA-Z0-9_-]{1,80}$/.test(room)), JSON.stringify(rooms));
    assert.ok(unique.includes(f.conversation.id + '-inbox'), JSON.stringify(rooms));
    f.control().stop('human_stop');
    assert.equal(await within(running), 'human_stop');
  } finally { release(); await f.close(); }
});
