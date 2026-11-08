import test from 'node:test';
import assert from 'node:assert/strict';
import {buildClaudeArgs} from './scripts/spawn-claude-chat.mjs';

const head=maxTurns=>['-p','--output-format','json','--strict-mcp-config',
  '--mcp-config','{"mcpServers":{}}','--max-turns',String(maxTurns)];

test('read-only worker exposes only read tools',()=>{
  const args=buildClaudeArgs({sandbox:'read-only',effort:'high'});
  assert.deepEqual(args.slice(0,8),head(4));
  assert.ok(args.includes('--tools'));
  assert.equal(args[args.indexOf('--tools')+1],'Read,Grep,Glob');
  assert.ok(!args.includes('--permission-mode'));
  assert.ok(!args.includes('--allowedTools'));
});

test('workspace-write worker may edit and run node tests only',()=>{
  const args=buildClaudeArgs({sandbox:'workspace-write',effort:'high'});
  assert.deepEqual(args.slice(0,8),head(40));
  assert.equal(args[args.indexOf('--permission-mode')+1],'acceptEdits');
  assert.equal(args[args.indexOf('--allowedTools')+1],
    'Read,Grep,Glob,Edit,Write,Bash(node --test *)');
  assert.ok(!args.includes('--tools'));
});

test('effort maps ultra to max and resume appends the session',()=>{
  assert.equal(buildClaudeArgs({effort:'ultra'})[buildClaudeArgs({effort:'ultra'}).indexOf('--effort')+1],'max');
  const args=buildClaudeArgs({session:'sess-1'});
  assert.equal(args.at(-1),'sess-1');
  assert.equal(args.at(-2),'--resume');
});

test('rejects unknown sandbox and effort',()=>{
  assert.throws(()=>buildClaudeArgs({sandbox:'danger-full-access'}),/sandbox must be read-only or workspace-write/);
  assert.throws(()=>buildClaudeArgs({effort:'max'}),/effort must be/);
});
