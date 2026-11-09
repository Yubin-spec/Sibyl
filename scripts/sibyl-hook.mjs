#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const PROTOCOL = 'plan-review/v1';
const CONTEXT_PROTOCOL = 'hook-context/v1';
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

async function contextEnabled(dir) {
  try {
    const value = JSON.parse(await readFile(join(dir, 'hook-context.json'), 'utf8'));
    return value?.enabled !== false;
  } catch {
    return true;
  }
}

function contextOutput(event, value) {
  const text = typeof value?.text === 'string' ? value.text.trim() : '';
  if (!text) return {};
  return {hookSpecificOutput: {hookEventName: event, additionalContext: text}};
}

function noticeFor(error) {
  return /protocol/i.test(error?.message ?? '')
    ? {notice: 'plan-review 协议不一致，请更新 hooks'}
    : {};
}

async function request(dir, path, body, timeoutMs = 1500) {
  const runtime = JSON.parse(await readFile(join(dir, 'native-runtime.json'), 'utf8'));
  const url = new URL(runtime.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || typeof runtime.token !== 'string') {
    throw Error('Invalid local bridge runtime');
  }
  const response = await fetch(new URL(path, url), {
    method: 'POST',
    headers: {authorization: 'Bearer ' + runtime.token, 'content-type': 'application/json'},
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(value.error || 'Hook request failed');
  return value;
}

export async function decideStop(input = {}, call = request) {
  if (input.stop_hook_active) return {};
  try {
    const value = await call('/plan-review/check', {
      protocol: PROTOCOL,
      projectPath: input.cwd || process.cwd()
    });
    if (value?.block) return {decision: 'block', reason: value.reason || '结构计划未通过评审'};
    return {};
  } catch (error) {
    return noticeFor(error);
  }
}

export async function decidePreTool(input = {}, call = request) {
  if (!EDIT_TOOLS.has(input.tool_name)) return {};
  const filePath = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof filePath !== 'string' || !filePath.trim()) return {};
  try {
    const value = await call('/plan-review/check', {
      protocol: PROTOCOL,
      projectPath: input.cwd || process.cwd(),
      filePath
    });
    if (!value?.block || value.mode === 'warn') return {};
    const permissionDecision = value.mode === 'deny' ? 'deny' : 'ask';
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision,
        permissionDecisionReason: value.reason || '结构计划未通过评审'
      }
    };
  } catch (error) {
    return noticeFor(error);
  }
}

export async function decideSessionStart(input = {}, call = request, {enabled = true} = {}) {
  if (!enabled) return {};
  try {
    const value = await call('/hook/context', {
      protocol: CONTEXT_PROTOCOL,
      event: 'session-start',
      projectPath: input.cwd || process.cwd(),
      ...(typeof input.session_id === 'string' && input.session_id ? {nativeSessionId: input.session_id} : {})
    }, 1500);
    return contextOutput('SessionStart', value);
  } catch {
    return {};
  }
}

export async function decideUserPrompt(input = {}, call = request, {enabled = true} = {}) {
  if (!enabled) return {};
  try {
    const value = await call('/hook/context', {
      protocol: CONTEXT_PROTOCOL,
      event: 'user-prompt',
      projectPath: input.cwd || process.cwd(),
      ...(typeof input.session_id === 'string' && input.session_id ? {nativeSessionId: input.session_id} : {})
    }, 700);
    return contextOutput('UserPromptSubmit', value);
  } catch {
    return {};
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

export async function main(argv = process.argv.slice(2)) {
  const {values} = parseArgs({
    args: argv,
    options: {
      dir: {type: 'string'},
      event: {type: 'string'},
      help: {type: 'boolean', default: false}
    },
    strict: true
  });
  const events = ['stop', 'pre-tool', 'session-start', 'user-prompt'];
  if (values.help) {
    console.log('node scripts/sibyl-hook.mjs --dir <dataDir> --event stop|pre-tool|session-start|user-prompt');
    return;
  }
  if (!values.dir || !events.includes(values.event)) throw Error('--dir and --event stop|pre-tool|session-start|user-prompt are required');
  let input = {};
  try {
    input = JSON.parse(await readStdin() || '{}');
  } catch {
    input = {};
  }
  const call = (path, body, timeoutMs) => request(values.dir, path, body, timeoutMs);
  const enabled = ['stop', 'pre-tool'].includes(values.event) ? true : await contextEnabled(values.dir);
  const output = values.event === 'stop' ? await decideStop(input, call)
    : values.event === 'pre-tool' ? await decidePreTool(input, call)
    : values.event === 'session-start' ? await decideSessionStart(input, call, {enabled})
    : await decideUserPrompt(input, call, {enabled});
  process.stdout.write(JSON.stringify(output));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stdout.write(JSON.stringify({notice: error.message}));
    process.exitCode = 0;
  });
}
