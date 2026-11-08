import test from 'node:test';
import assert from 'node:assert/strict';
import {workerFixture,registerNative,wait} from './worker-test-support.mjs';

test('the daemon exposes worker lifecycle over the local API',async()=>{
  const f=await workerFixture();
  try{
    const {call}=await registerNative(f);
    const started=await call('/worker/start',{tool:'codex',tier:'dispatch',scope:['src'],prompt:'go'});
    assert.equal(started.status,'starting');
    const done=await wait(async()=>{const r=await call('/worker/result',{workerId:started.workerId,waitMs:200});return r.status==='completed'?r:null;});
    assert.deepEqual(done.report.files.modified,['src/a.txt']);
    const listed=await call('/worker/list',{});
    assert.equal(listed.workers.length,1);
    assert.equal((await f.call('/api/status')).workers.length,1);
    const mechanical=await call('/worker/start',{tool:'codex',tier:'dispatch',scope:['src'],kind:'mechanical'});
    assert.equal(mechanical.model,'gpt-6-luna');
    assert.equal(mechanical.effort,'low');
    await call('/worker/close',{workerId:mechanical.workerId});
    const lease=await call('/lease/check',{paths:['package.json','src/a.txt']});
    assert.ok(lease.shared.includes('package.json'));
    await assert.rejects(call('/worker/result',{workerId:'00000000-0000-0000-0000-000000000000',waitMs:0}),/Unknown worker/);
  }finally{await f.close();}
});

test('a worker whose lead session disappeared becomes an orphan',async()=>{
  const f=await workerFixture('hang',{sessionAlive:()=>false,workerOrphanGraceMs:200});
  try{
    const {call}=await registerNative(f);
    const started=await call('/worker/start',{tool:'codex',tier:'dispatch',scope:['src'],prompt:'go'});
    const orphan=await wait(async()=>{const r=await call('/worker/result',{workerId:started.workerId,waitMs:100});return r.status==='orphan'?r:null;},4000);
    assert.match(orphan.error,/孤儿/);
  }finally{await f.close();}
});
