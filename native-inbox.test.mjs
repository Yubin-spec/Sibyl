import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBridge,makeClient} from './bridge.mjs';

test('native question reaches only the registered receiver and its answer returns to its owner',async()=>{
  const module=await import('./native-inbox.mjs').catch(()=>({}));
  assert.equal(typeof module.openNativeInbox,'function','native-session inbox must exist');
  const dir=await mkdtemp(join(tmpdir(),'bridge-native-'));
  const inbox=await module.openNativeInbox({dir});
  const runtime=JSON.parse(await readFile(join(dir,'native-runtime.json'),'utf8'));
  const local=async(path,body,token=runtime.token)=>{
    const r=await fetch(runtime.url+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
    const data=await r.json();if(!r.ok)throw Error(data.error);return data;
  };
  const bridge=await createBridge({dir:join(dir,'host'),project:null,token:'paired',nativeInbox:inbox,runner:()=>assert.fail('native messages must never spawn another CLI session')});
  await new Promise(r=>bridge.server.listen(0,'127.0.0.1',r));
  const peer=makeClient('http://127.0.0.1:'+bridge.server.address().port,'paired');
  try{
    await assert.rejects(local('/register',{tool:'claude',title:'receiver'},'wrong'),/Unauthorized/);
    const a=await local('/register',{tool:'claude',title:'Existing CC task',nativeSessionId:'native-cc-one'});
    const b=await local('/register',{tool:'cursor',title:'Different task'});
    const catalog=await peer('/native/sessions');assert.equal(catalog.sessions.length,2);
    assert.ok(!JSON.stringify(catalog).includes(a.lease));
    assert.equal((await peer('/health')).capabilities.nativeInbox,1);
    const request={id:'question-one',targetSessionId:a.id,source:{id:'source-session',title:'Existing source task',tool:'codex'},text:'What is the API field?'};
    const pending=await peer('/native/questions',request);assert.equal(pending.status,'queued');
    assert.deepEqual((await local('/receive',{id:b.id,lease:b.lease,waitMs:0})).messages,[]);
    await assert.rejects(local('/receive',{id:a.id,lease:b.lease,waitMs:0}),/Session/);
    const received=await local('/receive',{id:a.id,lease:a.lease,waitMs:0});
    assert.equal(received.messages[0].text,'What is the API field?');
    assert.equal(received.messages[0].source.title,'Existing source task');
    const foreign=makeClient('http://127.0.0.1:'+bridge.server.address().port,'wrong');
    await assert.rejects(foreign('/native/questions/question-one'),/Unauthorized/);
    await local('/reply',{id:a.id,lease:a.lease,questionId:'question-one',text:'Use account_id.'});
    const answer=await peer('/native/questions/question-one');
    assert.equal(answer.status,'answered');assert.equal(answer.answer,'Use account_id.');
    assert.equal(answer.targetSessionId,a.id);
    await peer('/native/questions',request);
    await assert.rejects(peer('/native/questions',{...request,text:'different'}),/different/);
    await assert.rejects(local('/reply',{id:b.id,lease:b.lease,questionId:'question-one',text:'wrong answer'}),/Question/);
    await local('/close',{id:a.id,lease:a.lease});
    await assert.rejects(peer('/native/questions',{...request,id:'question-two'}),/offline/);
  }finally{await new Promise(r=>bridge.server.close(r));await inbox.close();await rm(dir,{recursive:true,force:true});}
});

test('restarting inbox never advertises dead sessions or replays pending questions',async()=>{
  const {openNativeInbox}=await import('./native-inbox.mjs');
  const dir=await mkdtemp(join(tmpdir(),'bridge-native-restart-'));
  let inbox=await openNativeInbox({dir});
  try{
    const runtime=JSON.parse(await readFile(join(dir,'native-runtime.json'),'utf8'));
    const register=await fetch(runtime.url+'/register',{method:'POST',headers:{authorization:'Bearer '+runtime.token},body:JSON.stringify({title:'task',tool:'claude'})});
    const session=await register.json();
    await inbox.request({id:'alice'},{id:'pending',targetSessionId:session.id,source:{id:'source',title:'sender',tool:'codex'},text:'Question'});
    await assert.rejects(inbox.result({id:'bob'},'pending'),/Unknown/);
    await inbox.close();inbox=await openNativeInbox({dir});
    assert.deepEqual(inbox.catalog(),[]);
    assert.equal((await inbox.result({id:'alice'},'pending')).status,'interrupted');
  }finally{await inbox.close();await rm(dir,{recursive:true,force:true});}
});

test('expired crashed sessions release capacity and terminate their pending questions',async()=>{
  const {openNativeInbox}=await import('./native-inbox.mjs');let clock=Date.now();
  const dir=await mkdtemp(join(tmpdir(),'bridge-native-expiry-'));
  const inbox=await openNativeInbox({dir,now:()=>clock});
  try{
    const runtime=JSON.parse(await readFile(join(dir,'native-runtime.json'),'utf8'));
    const register=async()=>{const r=await fetch(runtime.url+'/register',{method:'POST',headers:{authorization:'Bearer '+runtime.token},body:JSON.stringify({title:'task',tool:'claude'})});assert.equal(r.status,200);return r.json();};
    const first=await register();for(let i=1;i<100;i++)await register();
    await inbox.request({id:'peer'},{id:'expiry',targetSessionId:first.id,source:{id:'sender',title:'sender',tool:'codex'},text:'Question'});
    clock+=91000;assert.deepEqual(inbox.catalog(),[]);
    assert.equal((await inbox.result({id:'peer'},'expiry')).status,'recipient-offline');
    await register();assert.equal(inbox.catalog().length,1);
  }finally{await inbox.close();await rm(dir,{recursive:true,force:true});}
});

test('a second broker cannot overwrite a live data directory',async()=>{
  const {openNativeInbox}=await import('./native-inbox.mjs');
  const dir=await mkdtemp(join(tmpdir(),'bridge-native-lock-'));const first=await openNativeInbox({dir});
  try{const before=await readFile(join(dir,'native-runtime.json'),'utf8');await assert.rejects(openNativeInbox({dir}).then(async unexpected=>{await unexpected.close();}),/already running/);assert.equal(await readFile(join(dir,'native-runtime.json'),'utf8'),before);}
  finally{await first.close();await rm(dir,{recursive:true,force:true});}
});

test('simultaneous stale-lock recovery elects exactly one live broker',async()=>{
 const {openNativeInbox}=await import('./native-inbox.mjs');const {writeFile}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'bridge-stale-lock-'));await writeFile(join(dir,'native-inbox.lock'),JSON.stringify({pid:1000000000,nonce:'dead'}));
 const settled=await Promise.allSettled([openNativeInbox({dir}),openNativeInbox({dir})]);
 const winners=settled.filter(r=>r.status==='fulfilled');
 try{assert.equal(winners.length,1);assert.equal(settled.filter(r=>r.status==='rejected').length,1);}
 finally{await Promise.allSettled(winners.map(r=>r.value.close()));await rm(dir,{recursive:true,force:true});}
});
