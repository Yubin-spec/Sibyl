import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {workerFixture,registerNative,wait} from './worker-test-support.mjs';

const config={host:'203.0.113.9',user:'ubuntu',key:'C:/keys/notify-test',hermes:'/home/ubuntu/.local/bin/hermes',target:'weixin'};

function gatedSender(){
  const sent=[];
  let release=()=>{};
  const gate=new Promise(resolve=>{release=resolve;});
  return {
    sent,
    sender:async message=>{sent.push(message);await gate;return 'ok';},
    release:()=>release()
  };
}

test('a worker completion notifies once without waiting on the sender',async()=>{
  const gate=gatedSender();
  const f=await workerFixture('write',{notify:{enabled:true,config,sender:gate.sender}});
  try{
    const native=await registerNative(f);
    const started=await native.call('/worker/start',{tool:'codex',tier:'dispatch',scope:['src'],prompt:'go'});
    const done=await wait(async()=>{
      const value=await native.call('/worker/result',{workerId:started.workerId,waitMs:200});
      return value.status==='completed'?value:null;
    });
    assert.equal(done.status,'completed');
    await wait(async()=>gate.sent.length===1?true:null);
    const message=gate.sent[0];
    for(const part of ['项目：','任务：工作方','模型：','完成了什么：','还差什么：','预计多久：']) assert.ok(message.body.includes(part),part+' missing');
    await native.call('/worker/accept',{workerId:started.workerId,accepted:true,note:''});
    assert.equal(gate.sent.length,1);
    gate.release();
    await f.control.notifications.flush();
    assert.equal(f.control.notifications.status().sent,1);
  }finally{
    gate.release();
    await f.close();
  }
});

test('a plan review advances while a notification is still pending',async()=>{
  const gate=gatedSender();
  const f=await workerFixture('review',{focusThread:async()=>'opened',notify:{enabled:true,config,sender:gate.sender}});
  try{
    const planPath='docs/superpowers/plans/demo.md';
    await mkdir(join(f.project,'docs','superpowers','plans'),{recursive:true});
    await writeFile(join(f.project,planPath),`---
review: required
change:
  scope: [api]
---
# Demo

body
`);
    const native=await registerNative(f);
    const started=await native.call('/plan-review/start',{protocol:'plan-review/v1',planPath});
    const done=await wait(async()=>{
      const value=await native.call('/plan-review/result',{protocol:'plan-review/v1',reviewId:started.reviewId,waitMs:100});
      return value.status==='approved'?value:null;
    });
    assert.equal(done.status,'approved');
    await wait(async()=>gate.sent.some(message=>/计划评审已通过/.test(message.title))?true:null);
    assert.equal(gate.sent.length,1);
    gate.release();
    await f.control.notifications.flush();
  }finally{
    gate.release();
    await f.close();
  }
});
