import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createControl} from './control.mjs';

async function fixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'channel-api-'));
  const c = await createControl({dir, detect:async () => ({claude:'test', codex:'test'}), ...options});
  await new Promise(r => c.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${c.server.address().port}`;
  const call = async (path, body) => {
    const r = await fetch(base + path, {method:body ? 'POST' : 'GET', headers:{origin:base, 'x-bridge-ui':c.csrf, 'content-type':'application/json'}, body:body ? JSON.stringify(body) : undefined});
    const value = await r.json();
    assert.equal(r.status, 200, JSON.stringify(value));
    return value;
  };
  return {dir, c, call, close:async () => {await c.close(); await rm(dir, {recursive:true, force:true});}};
}

async function settle(f) {
  for (let i = 0; i < 200; i++) {
    const s = await f.call('/api/status');
    if (s.operation && s.operation.status !== 'running') return s;
    await new Promise(r => setTimeout(r, 10));
  }
  throw Error('operation did not finish');
}

test('channel conversations run through the control API and keep their stop reason', async () => {
  let n = 0;
  const f = await fixture({runner:async (prompt, sessionId) => ({session_id:sessionId || 's' + (++n), result:'reply ' + n})});
  try {
    const p = await f.call('/api/projects/save', {name:'p', path:f.dir});
    const conv = await f.call('/api/conversations/create', {title:'channel', projectId:p.id, localAgent:'codex', connectionId:'local', remoteAgent:'claude', mode:'channel', limits:{maxMessages:3}});
    assert.equal(conv.mode, 'channel');
    await f.call('/api/conversations/run', {id:conv.id, goal:'修 bug'});
    const s = await settle(f);
    assert.equal(s.operation.status, 'completed');
    const c = s.conversations.find(x => x.id === conv.id);
    assert.equal(c.stopReason, 'budget');
    assert.equal(c.usage.messages, 3);
    const history = await f.call('/api/conversations/messages?id=' + conv.id);
    assert.equal(history.messages[0].side, 'human');
    assert.equal(history.messages.filter(m => m.side !== 'human').length, 3);
  } finally { await f.close(); }
});

test('a human can inject a message into a running channel', async () => {
  let release;
  const gate = new Promise(r => {release = r;});
  let n = 0;
  const f = await fixture({runner:async (prompt, sessionId) => {
    if (!sessionId) { await gate; return {session_id:'m', result:'first [[END]]'}; }
    return {session_id:sessionId, result:'reply ' + (++n) + ' [[END]]'};
  }});
  try {
    const p = await f.call('/api/projects/save', {name:'p', path:f.dir});
    const conv = await f.call('/api/conversations/create', {title:'channel', projectId:p.id, localAgent:'codex', connectionId:'local', remoteAgent:'claude', mode:'channel', limits:{maxMessages:6}});
    await f.call('/api/conversations/run', {id:conv.id, goal:'修 bug'});
    for (let i = 0; i < 100; i++) {
      const s = await f.call('/api/status');
      if (s.operation?.status === 'running') break;
      await new Promise(r => setTimeout(r, 10));
    }
    await f.call('/api/conversations/message', {id:conv.id, text:'补充：先跑测试'});
    release();
    await settle(f);
    const history = await f.call('/api/conversations/messages?id=' + conv.id);
    assert.ok(history.messages.some(m => m.side === 'human' && m.text.includes('补充')));
  } finally { release(); await f.close(); }
});

test('injecting into a channel that is not running is rejected', async () => {
  const f = await fixture();
  try {
    const p = await f.call('/api/projects/save', {name:'p', path:f.dir});
    const conv = await f.call('/api/conversations/create', {title:'channel', projectId:p.id, localAgent:'codex', connectionId:'local', remoteAgent:'claude', mode:'channel'});
    const r = await fetch(`http://127.0.0.1:${f.c.server.address().port}/api/conversations/message`, {method:'POST', headers:{origin:`http://127.0.0.1:${f.c.server.address().port}`, 'x-bridge-ui':f.c.csrf, 'content-type':'application/json'}, body:JSON.stringify({id:conv.id, text:'hi'})});
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /未在运行/);
  } finally { await f.close(); }
});
