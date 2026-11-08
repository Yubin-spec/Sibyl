import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {decideStop, decidePreTool} from './scripts/sibyl-hook.mjs';

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
    const child = spawn(process.execPath, [hook, '--dir', dir, '--event', 'stop'], {stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    const code = await new Promise(resolve => {
      child.once('close', resolve);
      child.stdin.end(JSON.stringify({cwd: process.cwd(), stop_hook_active: false}));
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), {});
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
