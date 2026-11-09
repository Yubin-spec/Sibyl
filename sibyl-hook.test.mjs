import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {decideStop, decidePreTool, decideSessionStart, decideUserPrompt} from './scripts/sibyl-hook.mjs';

const hook = fileURLToPath(new URL('./scripts/sibyl-hook.mjs', import.meta.url));

test('stop blocks an unreviewed structural plan and fails open', async () => {
  const calls = [];
  const call = async (path, body) => { calls.push({path, body}); return {block: true, mode: 'ask', reason: '请先评审'}; };
  assert.deepEqual(await decideStop({cwd: '/p', stop_hook_active: false}, call), {decision: 'block', reason: '请先评审'});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.protocol, 'plan-review/v1');
  assert.equal(calls[0].body.projectPath, '/p');
  assert.deepEqual(await decideStop({cwd: '/p', stop_hook_active: true}, call), {});
  assert.equal(calls.length, 1);
  assert.deepEqual(await decideStop({cwd: '/p'}, async () => { throw Error('down'); }), {});
  assert.match((await decideStop({cwd: '/p'}, async () => { throw Error('Unsupported plan review protocol'); })).notice, /协议/);
});

test('pre-tool asks or denies edits and ignores unrelated tools', async () => {
  const calls = [];
  const call = async (path, body) => { calls.push({path, body}); return {block: true, mode: 'ask', reason: '结构计划未评审'}; };
  const asked = await decidePreTool({cwd: '/p', tool_name: 'Write', tool_input: {file_path: '/p/src/a.mjs'}}, call);
  assert.equal(asked.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(asked.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(calls[0].body.filePath, '/p/src/a.mjs');
  const denied = await decidePreTool({cwd: '/p', tool_name: 'Edit', tool_input: {file_path: '/p/src/a.mjs'}}, async () => ({block: true, mode: 'deny', reason: '不可逆'}));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(await decidePreTool({cwd: '/p', tool_name: 'Read', tool_input: {}}, call), {});
  assert.deepEqual(await decidePreTool({cwd: '/p', tool_name: 'Write', tool_input: {}}, call), {});
  assert.deepEqual(await decidePreTool({cwd: '/p', tool_name: 'Write', tool_input: {file_path: '/p/x'}}, async () => ({block: true, mode: 'warn'})), {});
  assert.equal(calls.length, 1);
});

test('the hook process fails open when the daemon is unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sibyl-hook-'));
  try {
    const run = async (event, payload) => {
      const child = spawn(process.execPath, [hook, '--dir', dir, '--event', event], {stdio: ['pipe', 'pipe', 'pipe']});
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      const code = await new Promise(resolve => {
        child.once('close', resolve);
        child.stdin.end(JSON.stringify(payload));
      });
      return {code, value: JSON.parse(stdout)};
    };
    const stopped = await run('stop', {cwd: process.cwd(), stop_hook_active: false});
    assert.equal(stopped.code, 0);
    assert.deepEqual(stopped.value, {});
    const started = await run('session-start', {cwd: process.cwd(), session_id: 'sid'});
    assert.equal(started.code, 0);
    assert.deepEqual(started.value, {});
    const prompted = await run('user-prompt', {cwd: process.cwd(), prompt: 'do work'});
    assert.equal(prompted.code, 0);
    assert.deepEqual(prompted.value, {});
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('hook-context.json turns context hooks off at the process level', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sibyl-hook-off-'));
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({text: '[AI Bridge] from daemon'}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await writeFile(join(dir, 'native-runtime.json'), JSON.stringify({url: `http://127.0.0.1:${server.address().port}`, token: 'test-token'}));
    const run = async (event, payload) => {
      const child = spawn(process.execPath, [hook, '--dir', dir, '--event', event], {stdio: ['pipe', 'pipe', 'pipe']});
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      const code = await new Promise(resolve => {
        child.once('close', resolve);
        child.stdin.end(JSON.stringify(payload));
      });
      return {code, value: JSON.parse(stdout)};
    };
    await writeFile(join(dir, 'hook-context.json'), JSON.stringify({enabled: false}));
    assert.deepEqual(await run('session-start', {cwd: process.cwd()}), {code: 0, value: {}});
    assert.deepEqual(await run('user-prompt', {cwd: process.cwd()}), {code: 0, value: {}});
    assert.equal(hits, 0);
    await writeFile(join(dir, 'hook-context.json'), JSON.stringify({enabled: true}));
    const enabled = await run('session-start', {cwd: process.cwd()});
    assert.equal(enabled.value.hookSpecificOutput.additionalContext, '[AI Bridge] from daemon');
    assert.equal(hits, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, {recursive: true, force: true});
  }
});

test('session-start injects context and fails open', async () => {
  const calls = [];
  const call = async (path, body, timeoutMs) => { calls.push({path, body, timeoutMs}); return {text: '[AI Bridge] demo'}; };
  assert.deepEqual(await decideSessionStart({cwd: '/p', session_id: 'sid'}, call), {
    hookSpecificOutput: {hookEventName: 'SessionStart', additionalContext: '[AI Bridge] demo'}
  });
  assert.equal(calls[0].path, '/hook/context');
  assert.equal(calls[0].body.protocol, 'hook-context/v1');
  assert.equal(calls[0].body.event, 'session-start');
  assert.equal(calls[0].body.nativeSessionId, 'sid');
  assert.equal(calls[0].timeoutMs, 1500);
  assert.deepEqual(await decideSessionStart({cwd: '/p'}, async () => { throw Error('down'); }), {});
  assert.deepEqual(await decideSessionStart({cwd: '/p'}, call, {enabled: false}), {});
  assert.deepEqual(await decideSessionStart({cwd: '/p'}, async () => ({text: '   '})), {});
});

test('user-prompt injects read-only context without uploading prompt text', async () => {
  const calls = [];
  const call = async (path, body, timeoutMs) => { calls.push({path, body, timeoutMs}); return {text: '[AI Bridge] pending'}; };
  const output = await decideUserPrompt({cwd: '/p', prompt: 'SECRET USER TEXT', session_id: 'sid'}, call);
  assert.deepEqual(output, {hookSpecificOutput: {hookEventName: 'UserPromptSubmit', additionalContext: '[AI Bridge] pending'}});
  assert.equal(calls[0].path, '/hook/context');
  assert.equal(calls[0].body.event, 'user-prompt');
  assert.equal(calls[0].body.nativeSessionId, 'sid');
  assert.equal(calls[0].timeoutMs, 700);
  assert.ok(!JSON.stringify(calls[0].body).includes('SECRET USER TEXT'));
  assert.deepEqual(await decideUserPrompt({cwd: '/p'}, async () => { throw Error('down'); }), {});
  assert.deepEqual(await decideUserPrompt({cwd: '/p'}, async () => ({text: ''})), {});
  assert.deepEqual(await decideUserPrompt({cwd: '/p'}, call, {enabled: false}), {});
});
