import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildClaudeArgs,runClaudeTurn} from './scripts/spawn-claude-chat.mjs';

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

const fakeBody=`import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG,JSON.stringify(args)+'\\n');
const i=args.indexOf('--resume');
const scope=i>=0?args[i+1]:'first';
process.stdout.write(JSON.stringify({result:'done:'+scope,session_id:'sess-'+scope,is_error:false}));`;

async function fakeClaude(){
  const root=await mkdtemp(join(tmpdir(),'fake-claude-'));
  const script=join(root,'fake.mjs'),log=join(root,'argv.log');
  await writeFile(script,fakeBody);await writeFile(log,'');
  return {root,executable:{command:process.execPath,args:[script]},log,
    env:{...process.env,FAKE_LOG:log}};
}

test('first turn has no resume and returns a session id',async()=>{
  const f=await fakeClaude();
  const r=await runClaudeTurn({prompt:'hi',...f});
  assert.deepEqual(r,{text:'done:first',sessionId:'sess-first'});
});

test('second turn resumes the captured session',async()=>{
  const f=await fakeClaude();
  const r=await runClaudeTurn({prompt:'again',session:'sess-first',...f});
  assert.equal(r.text,'done:sess-first');
  const logged=JSON.parse((await readFile(f.log,'utf8')).trim().split('\n').at(-1));
  assert.equal(logged[logged.indexOf('--resume')+1],'sess-first');
});

test('a result without session_id is an error',async()=>{
  const f=await fakeClaude();
  const script=join(f.root,'bad.mjs');
  await writeFile(script,`process.stdout.write('{"result":"x","is_error":false}')`);
  await assert.rejects(
    runClaudeTurn({prompt:'hi',executable:{command:process.execPath,args:[script]},env:f.env}),
    /invalid result/);
});

test('a missing executable is reported in plain language',async()=>{
  await assert.rejects(
    runClaudeTurn({prompt:'hi',executable:{command:'sibyl-no-such-binary-xyz',args:[]}}),
    /Claude executable not found/);
});

test('a turn that exceeds its timeout is killed and reported',async()=>{
  const f=await fakeClaude();
  const script=join(f.root,'slow.mjs');
  await writeFile(script,`setTimeout(()=>{},10000)`);
  await assert.rejects(
    runClaudeTurn({prompt:'hi',timeoutMs:1000,
      executable:{command:process.execPath,args:[script]},env:f.env}),
    /timed out after 1000 ms/);
});
