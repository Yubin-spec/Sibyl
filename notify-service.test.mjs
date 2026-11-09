import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createNotifyService,notificationEvents,formatNotification,attentionKey} from './notify-service.mjs';

const config={host:'203.0.113.9',user:'ubuntu',key:'C:/keys/notify-test',hermes:'/home/ubuntu/.local/bin/hermes',target:'weixin'};
const projects=[{path:'D:/proj/Sibyl',name:'Sibyl'}];
const snap=({workers=[],planReviews=[],attention=[]}={})=>({projects,workers,planReviews,attention});
const worker=(over={})=>({workerId:'w-1',status:'completed',tool:'codex',tier:'dispatch',model:'gpt-6-astra',effort:'high',projectPath:'D:/proj/Sibyl',report:{summary:'done',stats:{files:2},needsReview:false},...over});
const review=(over={})=>({reviewId:'r-1',status:'changes-required',round:1,planPath:'docs/plan.md',projectPath:'D:/proj/Sibyl',workerId:'rw-1',issues:[{severity:'major'},{severity:'minor'}],questions:[{id:'Q1'}],...over});
const consultItem=stamp=>({key:`consult:c-1:${stamp}`,kind:'consult',consultId:'c-1',title:'只读核对已停止',detail:'Sibyl → Parser · timeout',at:stamp});

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'notify-svc-'));
  return {dir,statePath:join(dir,'state.json'),cleanup:()=>rm(dir,{recursive:true,force:true})};
}

test('a worker completion sends one message with the fixed sections and model',async()=>{
  const f=await fixture();
  try{
    const sent=[];
    const service=createNotifyService({enabled:true,config,statePath:f.statePath,sender:async message=>{sent.push(message);return 'ok';}});
    service.seed(snap({workers:[worker({status:'running'})]}));
    service.observe(snap({workers:[worker()]}));
    await service.flush();
    assert.equal(sent.length,1);
    assert.equal(sent[0].title,'Sibyl · 工作方完成');
    for(const part of ['项目：Sibyl','任务：工作方 w-1 · codex/dispatch','模型：gpt-6-astra / high','完成了什么：','还差什么：','预计多久：','工作方已交工']) assert.ok(sent[0].body.includes(part),part+' missing in '+sent[0].body);
    service.close();
  }finally{await f.cleanup();}
});

test('repeating the same snapshot does not send again',async()=>{
  const f=await fixture();
  try{
    const sent=[];
    const service=createNotifyService({enabled:true,config,statePath:f.statePath,sender:async message=>{sent.push(message);return 'ok';}});
    service.seed(snap({workers:[worker({status:'running'})]}));
    service.observe(snap({workers:[worker()]}));
    await service.flush();
    service.observe(snap({workers:[worker()]}));
    service.observe(snap({workers:[worker()]}));
    await service.flush();
    assert.equal(sent.length,1);
    service.close();
  }finally{await f.cleanup();}
});

test('attention metadata updates do not create a second notification',async()=>{
  const f=await fixture();
  try{
    const sent=[];
    const service=createNotifyService({enabled:true,config,statePath:f.statePath,sender:async message=>{sent.push(message);return 'ok';}});
    service.seed(snap());
    service.observe(snap({attention:[consultItem('2026-11-09T01:00:00.000Z')]}));
    await service.flush();
    service.observe(snap({attention:[consultItem('2026-11-09T01:00:05.000Z')]}));
    await service.flush();
    assert.equal(sent.length,1);
    assert.equal(attentionKey(consultItem('a')),attentionKey(consultItem('b')));
    assert.equal(attentionKey({kind:'pair',pairId:'p1'}),'pair:p1');
    assert.equal(attentionKey({kind:'conversation',conversationId:'c1'}),'conversation:c1');
    service.close();
  }finally{await f.cleanup();}
});

test('a new attention item sends once',async()=>{
  const f=await fixture();
  try{
    const sent=[];
    const service=createNotifyService({enabled:true,config,statePath:f.statePath,sender:async message=>{sent.push(message);return 'ok';}});
    service.seed(snap());
    service.observe(snap({attention:[{key:'pair:p1',kind:'pair',pairId:'p1',title:'Studio 请求配对',detail:'192.168.1.20'}]}));
    await service.flush();
    assert.equal(sent.length,1);
    assert.match(sent[0].title,/待处理/);
    assert.match(sent[0].body,/Studio 请求配对/);
    service.close();
  }finally{await f.cleanup();}
});

test('plan review workers are filtered across replacement while ordinary consult workers still notify',async()=>{
  const f=await fixture();
  try{
    const sent=[];
    const service=createNotifyService({enabled:true,config,statePath:f.statePath,sender:async message=>{sent.push(message);return 'ok';}});
    service.seed(snap({planReviews:[review({status:'interrupted',workerId:'W1'})],workers:[worker({workerId:'W1',status:'orphan'})]}));
    service.observe(snap({planReviews:[review({status:'starting',round:2,workerId:'W2'})],workers:[worker({workerId:'W1',status:'orphan'}),worker({workerId:'W2',status:'running'})]}));
    assert.equal(sent.length,0);
    service.observe(snap({planReviews:[review({status:'starting',round:2,workerId:'W2'})],workers:[worker({workerId:'W1',status:'interrupted'}),worker({workerId:'W2',status:'completed'}),worker({workerId:'W3',status:'completed',tier:'consult'})]}));
    await service.flush();
    assert.equal(sent.length,1);
    assert.match(sent[0].body,/工作方 W3/);
    service.close();
  }finally{await f.cleanup();}
});

test('persisted dedupe survives a restart and a recover back to the same round',async()=>{
  const f=await fixture();
  try{
    const first=[];
    const a=createNotifyService({enabled:true,config,statePath:f.statePath,sender:async message=>{first.push(message);return 'ok';}});
    a.seed(snap({planReviews:[review({status:'reviewing'})],workers:[worker({workerId:'rw-1',status:'running'})]}));
    a.observe(snap({planReviews:[review({status:'changes-required'})],workers:[worker({workerId:'rw-1',status:'completed'})]}));
    await a.flush();
    a.close();
    assert.equal(first.length,1);
    assert.match(first[0].body,/模型：gpt-6-astra \/ high/);
    assert.match(first[0].body,/第 1 轮评审完成：1 个 blocker\/major、1 个问题待回应/);

    const second=[];
    const b=createNotifyService({enabled:true,config,statePath:f.statePath,sender:async message=>{second.push(message);return 'ok';}});
    b.seed(snap({planReviews:[review({status:'interrupted'})]}));
    b.observe(snap({planReviews:[review({status:'changes-required'})]}));
    await b.flush();
    assert.equal(second.length,0);
    b.close();
  }finally{await f.cleanup();}
});

test('the dedupe key is written before the sender is called',async()=>{
  const f=await fixture();
  try{
    let keysAtSend=null;
    const service=createNotifyService({enabled:true,config,statePath:f.statePath,sender:async()=>{
      keysAtSend=Object.keys(JSON.parse(readFileSync(f.statePath,'utf8')).keys);
      return 'ok';
    }});
    service.seed(snap({workers:[worker({status:'running'})]}));
    service.observe(snap({workers:[worker()]}));
    await service.flush();
    assert.deepEqual(keysAtSend,['worker:w-1:completed']);
    service.close();
  }finally{await f.cleanup();}
});

test('an unwritable state file stops delivery without breaking the caller',async()=>{
  const f=await fixture();
  try{
    const blocker=join(f.dir,'blocker');
    await writeFile(blocker,'not a directory');
    const sent=[];
    const service=createNotifyService({enabled:true,config,statePath:join(blocker,'state.json'),sender:async message=>{sent.push(message);return 'ok';}});
    service.seed(snap({workers:[worker({status:'running'})]}));
    service.observe(snap({workers:[worker()]}));
    await service.flush();
    assert.equal(sent.length,0);
    assert.equal(service.status().state,'broken');
    assert.equal(service.status().failed,1);
    service.close();
  }finally{await f.cleanup();}
});

test('a corrupted state file stops delivery',async()=>{
  const f=await fixture();
  try{
    await writeFile(f.statePath,'{not json');
    const sent=[];
    const service=createNotifyService({enabled:true,config,statePath:f.statePath,sender:async message=>{sent.push(message);return 'ok';}});
    assert.equal(service.status().state,'broken');
    service.observe(snap({workers:[worker()]}));
    await service.flush();
    assert.equal(sent.length,0);
    service.close();
  }finally{await f.cleanup();}
});

test('missing or damaged configuration disables notifications silently',async()=>{
  const f=await fixture();
  try{
    const cases=[
      {name:'missing',path:join(f.dir,'missing.json')},
      {name:'invalid json',path:join(f.dir,'bad.json'),content:'{bad'},
      {name:'null',path:join(f.dir,'null.json'),content:'null'},
      {name:'missing fields',path:join(f.dir,'partial.json'),content:JSON.stringify({host:'h'})},
      {name:'unreadable',path:f.dir}
    ];
    for(const item of cases){
      if(item.content!==undefined) await writeFile(item.path,item.content);
      let calls=0;
      const service=createNotifyService({enabled:true,configPath:item.path,statePath:join(f.dir,item.name.replace(/\s/g,'-')+'-state.json'),sender:async()=>{calls++;return 'ok';}});
      service.seed(snap({workers:[worker({status:'running'})]}));
      service.observe(snap({workers:[worker()]}));
      await service.flush();
      assert.equal(service.status().enabled,false,item.name);
      assert.equal(calls,0,item.name);
      service.close();
    }
  }finally{await f.cleanup();}
});

test('configured secrets are redacted from messages, lastError and onError',async()=>{
  const f=await fixture();
  try{
    const secret={host:'secret-host.example',user:'secret-user',key:'/secret/key.pem',hermes:'/secret/hermes',target:'secret-target'};
    const sent=[];
    const service=createNotifyService({enabled:true,config:secret,statePath:f.statePath,sender:async message=>{sent.push(message);return 'ok';}});
    service.seed(snap({workers:[worker({status:'running'})]}));
    service.observe(snap({workers:[worker({report:{summary:`${secret.host} ${secret.key}`,stats:{files:1},needsReview:true,reviewReasons:[secret.user]}})]}));
    await service.flush();
    assert.equal(sent.length,1);
    for(const value of Object.values(secret)) assert.ok(!sent[0].title.includes(value)&&!sent[0].body.includes(value),value);
    assert.ok(sent[0].body.includes('[redacted]'));

    const errors=[];
    const failing=createNotifyService({enabled:true,config:secret,statePath:join(f.dir,'failing.json'),onError:error=>errors.push(error.message),sender:async()=>{throw Error('boom '+secret.host+' '+secret.key);}});
    failing.seed(snap({workers:[worker({workerId:'w-2',status:'running'})]}));
    failing.observe(snap({workers:[worker({workerId:'w-2',status:'failed',error:'worker exploded'})]}));
    await failing.flush();
    assert.ok(!failing.status().lastError.includes(secret.host));
    assert.ok(!failing.status().lastError.includes(secret.key));
    assert.equal(errors.length,1);
    assert.ok(!errors[0].includes(secret.host));
    service.close();failing.close();
  }finally{await f.cleanup();}
});

test('retries only errors the sender marks as retryable',async()=>{
  const f=await fixture();
  try{
    let retryableCalls=0;
    const retryable=createNotifyService({enabled:true,config,statePath:join(f.dir,'retry.json'),retryDelayMs:5,sender:async()=>{
      retryableCalls++;
      if(retryableCalls===1) throw Object.assign(Error('no route'),{retryable:true});
      return 'ok';
    }});
    retryable.seed(snap({workers:[worker({status:'running'})]}));
    retryable.observe(snap({workers:[worker()]}));
    await retryable.flush();
    assert.equal(retryableCalls,2);
    assert.equal(retryable.status().sent,1);

    let plainCalls=0;
    const plain=createNotifyService({enabled:true,config,statePath:join(f.dir,'plain.json'),sender:async()=>{plainCalls++;throw Error('remote failed after send');}});
    plain.seed(snap({workers:[worker({workerId:'w-2',status:'running'})]}));
    plain.observe(snap({workers:[worker({workerId:'w-2',status:'completed'})]}));
    await plain.flush();
    assert.equal(plainCalls,1);
    assert.equal(plain.status().failed,1);
    retryable.close();plain.close();
  }finally{await f.cleanup();}
});

test('a hung sender times out, later events continue, and close is bounded',async()=>{
  const f=await fixture();
  try{
    let calls=0;
    const service=createNotifyService({enabled:true,config,statePath:f.statePath,sendTimeoutMs:50,retryDelayMs:5,sender:async({signal})=>{
      calls++;
      if(calls>1) return 'ok';
      return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true}));
    }});
    service.seed(snap({workers:[worker({workerId:'w-1',status:'running'}),worker({workerId:'w-2',status:'running'})]}));
    service.observe(snap({workers:[worker({workerId:'w-1'}),worker({workerId:'w-2'})]}));
    await service.flush();
    assert.equal(service.status().sent,1);
    assert.equal(service.status().failed,1);
    service.close();

    const hanging=createNotifyService({enabled:true,config,statePath:join(f.dir,'hang.json'),sendTimeoutMs:60000,sender:()=>new Promise(()=>{})});
    hanging.seed(snap({workers:[worker({workerId:'w-3',status:'running'})]}));
    hanging.observe(snap({workers:[worker({workerId:'w-3'})]}));
    await new Promise(resolve=>setTimeout(resolve,20));
    hanging.close();
    const result=await Promise.race([hanging.flush().then(()=>'done'),new Promise(resolve=>setTimeout(()=>resolve('timeout'),1000))]);
    assert.equal(result,'done');
  }finally{await f.cleanup();}
});

test('ledger eviction keeps internal workers that can still change',async()=>{
  const f=await fixture();
  try{
    await writeFile(f.statePath,JSON.stringify({version:1,keys:{},internalWorkers:['W1',...Array.from({length:1000},(_,index)=>'x'+index)]}));
    const sent=[];
    const service=createNotifyService({enabled:true,config,statePath:f.statePath,sender:async message=>{sent.push(message);return 'ok';}});
    service.seed(snap({planReviews:[review({status:'interrupted',workerId:'W1'})],workers:[worker({workerId:'W1',status:'orphan'})]}));
    service.observe(snap({planReviews:[review({status:'interrupted',workerId:'W1'})],workers:[worker({workerId:'W1',status:'interrupted'})]}));
    await service.flush();
    assert.equal(sent.length,0);
    service.close();
  }finally{await f.cleanup();}
});

test('notificationEvents and formatNotification are pure and independent',()=>{
  const previous={workers:[{workerId:'w-9',status:'running'}],planReviews:[],attention:[]};
  const events=notificationEvents(previous,snap({workers:[worker({workerId:'w-9'})]}));
  assert.equal(events.length,1);
  assert.equal(events[0].key,'worker:w-9:completed');
  const message=formatNotification(events[0]);
  assert.match(message.body,/完成了什么：/);
});
