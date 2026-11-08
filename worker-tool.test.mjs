import test from 'node:test';
import assert from 'node:assert/strict';
import {workerFixture,mcpClient,wait} from './worker-test-support.mjs';

test('bridge_worker_start dispatches and result returns the git report',async()=>{
  const f=await workerFixture();
  const c=mcpClient(f.dir,'claude',f.project);
  try{
    const started=await c.tool('bridge_worker_start',{tool:'codex',tier:'dispatch',scope:['src'],prompt:'go'});
    assert.equal(started.status,'starting');
    assert.deepEqual(started.leadMustWaitFor,['src']);
    const done=await wait(async()=>{const r=await c.tool('bridge_worker_result',{workerId:started.workerId,waitMs:1000});return r.status==='completed'?r:null;});
    assert.match(done.threadId,/^fake-/);
    assert.deepEqual(done.report.files.modified,['src/a.txt']);
    assert.ok(done.report.patchPath.endsWith(started.workerId+'.patch'));
    assert.ok(!JSON.stringify(done).includes('diff --git'));
  }finally{await c.close();await f.close();}
});

test('overlapping scopes and shared files are refused through the MCP layer',async()=>{
  const f=await workerFixture();
  const c=mcpClient(f.dir,'claude',f.project);
  try{
    const first=await c.tool('bridge_worker_start',{tool:'codex',tier:'parallel',scope:['src']});
    await assert.rejects(c.tool('bridge_worker_start',{tool:'codex',tier:'parallel',scope:['src/a']}),/路径租约冲突/);
    await assert.rejects(c.tool('bridge_worker_start',{tool:'codex',tier:'dispatch',scope:['package.json']}),/共享文件只能由主导方修改/);
    const check=await c.tool('bridge_lease_check',{paths:['src/a.txt','docs/x.md']});
    assert.equal(check.allowed,false);
    assert.deepEqual(check.blocked,[{path:'src/a.txt',workerId:first.workerId}]);
    await c.tool('bridge_worker_close',{workerId:first.workerId});
  }finally{await c.close();await f.close();}
});

test('worker tools reject malformed arguments before contacting the daemon',async()=>{
  const f=await workerFixture();
  const c=mcpClient(f.dir,'claude',f.project);
  try{
    await assert.rejects(c.tool('bridge_worker_start',{tool:'cursor',tier:'dispatch',scope:['src']}),/Invalid tool|tool must be/);
    await assert.rejects(c.tool('bridge_worker_start',{tool:'codex',tier:'meeting',scope:['src']}),/tier must be consult, dispatch or parallel/);
    await assert.rejects(c.tool('bridge_worker_start',{tool:'codex',tier:'dispatch',scope:'src'}),/Invalid scope/);
    await assert.rejects(c.tool('bridge_worker_start',{tool:'codex',tier:'dispatch'}),/scope is required unless tier is consult/);
    await assert.rejects(c.tool('bridge_worker_result',{workerId:'00000000-0000-0000-0000-000000000000',waitMs:10}),/Unknown worker/);
  }finally{await c.close();await f.close();}
});

test('bridge_worker_turn returns before the turn finishes',async()=>{
  const f=await workerFixture('hang');
  const c=mcpClient(f.dir,'claude',f.project);
  try{
    const started=await c.tool('bridge_worker_start',{tool:'codex',tier:'parallel',scope:['src']});
    const running=await wait(async()=>{const r=await c.tool('bridge_worker_result',{workerId:started.workerId,waitMs:100});return r.status==='running'?r:null;});
    assert.match(running.threadId,/^fake-/);
    const before=Date.now();
    const turn=await c.tool('bridge_worker_turn',{workerId:started.workerId,prompt:'work'});
    assert.ok(Date.now()-before<1000,'turn waited for completion');
    assert.equal(turn.accepted,true);
    const state=await c.tool('bridge_worker_result',{workerId:started.workerId,waitMs:50});
    assert.equal(state.lastTurn.status,'running');
    await c.tool('bridge_worker_close',{workerId:started.workerId});
  }finally{await c.close();await f.close();}
});

test('bridge_worker_accept records the lead decision and rejects an unfinished worker',async()=>{
  const f=await workerFixture('hang');
  const c=mcpClient(f.dir,'claude',f.project);
  try{
    const started=await c.tool('bridge_worker_start',{tool:'codex',tier:'dispatch',scope:['src'],prompt:'go'});
    await assert.rejects(c.tool('bridge_worker_accept',{workerId:started.workerId,accepted:true}),/has not finished/);
    await c.tool('bridge_worker_close',{workerId:started.workerId});
    const accepted=await c.tool('bridge_worker_accept',{workerId:started.workerId,accepted:false,note:'please split'});
    assert.equal(accepted.report.acceptance,'rejected');
    assert.equal(accepted.report.acceptanceNote,'please split');
  }finally{await c.close();await f.close();}
});

test('closing the MCP process no longer kills the daemon-owned worker',async()=>{
  const f=await workerFixture('hang');
  const c=mcpClient(f.dir,'claude',f.project);
  try{
    const started=await c.tool('bridge_worker_start',{tool:'codex',tier:'dispatch',scope:['src'],prompt:'hang'});
    await c.close();
    const after=await wait(async()=>{const state=await f.call('/api/status');return state.workers.find(w=>w.workerId===started.workerId&&w.status==='running')||null;});
    assert.equal(after.status,'running');
  }finally{await f.close();}
});
