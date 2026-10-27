import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPairing} from './pairing.mjs';
import {createBridge} from './bridge.mjs';
const device={id:randomUUID(),name:'Laptop',owner:'Alice'};
const reverse={url:'http://192.168.1.2:47831',token:'a'.repeat(64),peerId:randomUUID()};
test('reverse pairing validates source, hides secrets, saves metadata and rolls back callback failure',async()=>{
 const peers={};let notice,callback;
 const p=createPairing({peers,save:async()=>{},metadata:device,notify:r=>notice=r,onApproved:async v=>callback=v});
 for(const url of ['http://8.8.8.8:47831','http://192.168.1.3:47831','http://192.168.1.2','http://192.168.1.2:47831/a','http://u@192.168.1.2:47831']) assert.throws(()=>p.start({code:p.code,name:'Bob',device,reverse:{...reverse,url}},'::ffff:192.168.1.2'),/reverse/i);
 const r=p.start({code:p.code,name:'Bob',device,reverse},'::ffff:192.168.1.2');
 assert.equal(notice.ip,'192.168.1.2');assert.ok(!JSON.stringify(notice).includes(reverse.token));
 await p.approve(r.id,true);assert.equal(callback.request.reverse.token,reverse.token);
 const result=p.result(r.id,r.secret);assert.deepEqual(result.device,device);assert.equal(peers[result.peerId].deviceId,device.id);assert.equal(peers[result.peerId].owner,'Alice');
 const fail=createPairing({peers,save:async()=>{},onApproved:async()=>{throw Error('callback failed');}});
 const q=fail.start({code:fail.code,name:'Bob'},'ip');const before=Object.keys(peers).length;
 await assert.rejects(fail.approve(q.id,true),/callback failed/);assert.equal(Object.keys(peers).length,before);assert.equal(fail.result(q.id,q.secret).status,'pending');
});
test('reverse grant cannot authenticate until activated',async()=>{
 const p=createPairing({peers:{},save:async()=>{}});const grant=await p.grant({name:'Bob',deviceId:device.id,owner:'Bob',enabled:false});
 assert.equal(p.authenticate(grant.token),null);await p.activate(grant.peerId);assert.equal(p.authenticate(grant.token).deviceId,device.id);await p.revoke(grant.peerId);assert.equal(p.authenticate(grant.token),null);
});
test('bridge exposes safe catalog and binds authorized project, completion and change hooks',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-v3-'));let selected,complete;const changes=[];
 const b=await createBridge({dir,project:null,token:'secret',device,onChange:e=>changes.push(e),onComplete:p=>complete=p.id,catalog:p=>({projects:[{id:'shared',name:'Shared',path:dir,secret:'no'}],sessions:[{id:'one',title:'Hello',path:dir,token:'no',projectId:'shared'}]}),resolveProject:(id,p)=>id==='shared'?dir:null,runner:async(p,s,a,path)=>{selected=path;return {session_id:'s',result:'ok'};}});
 await new Promise(r=>b.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+b.server.address().port;
 const call=(path,data,token='secret')=>fetch(base+path,{method:data?'POST':'GET',headers:{authorization:'Bearer '+token},body:data?JSON.stringify(data):undefined});
 try{
 assert.equal((await call('/catalog',undefined,'bad')).status,401);const cat=await (await call('/catalog')).json();assert.deepEqual(cat.projects,[{id:'shared',name:'Shared'}]);assert.ok(!JSON.stringify(cat).includes(dir));assert.ok(!JSON.stringify(cat).includes('token'));
 const health=await (await call('/health')).json();assert.deepEqual(health.device,device);assert.equal(health.capabilities.duplexPairing,1);
 assert.equal((await call('/pair/complete',{})).status,200);assert.equal(complete,'legacy');assert.equal((await call('/pair/complete',{peerId:'other'})).status,400);
 assert.equal((await call('/turn',{id:'none',prompt:'hi'})).status,400);assert.equal((await call('/turn',{id:'bad',prompt:'hi',projectId:'private'})).status,400);
 assert.equal((await call('/turn',{id:'one',prompt:'hi',projectId:'shared'})).status,202);
 for(let i=0;i<50;i++){if((await (await call('/jobs/one')).json()).status!=='running')break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(selected,dir);assert.ok(changes.length>=2);await b.setProject(dir);await assert.rejects(b.setProject(join(dir,'missing')));
 }finally{await new Promise(r=>b.server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('validated conversation callbacks scope ids to peer and report received and completed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-conv-'));const events=[];let release;
 const b=await createBridge({dir,project:dir,token:'secret',onConversation:async e=>events.push(e),runner:async()=>new Promise(r=>release=()=>r({session_id:'s',result:'answer'}))});
 await new Promise(r=>b.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+b.server.address().port;
 const post=data=>fetch(url+'/turn',{method:'POST',headers:{authorization:'Bearer secret'},body:JSON.stringify(data)});
 try{
 assert.equal((await post({id:'bad',prompt:'hi',conversation:{id:'x',title:'x'.repeat(201)}})).status,400);
 const conversation={id:'room',title:'Topic',projectName:'Project',sourceDevice:'Laptop',sourceAgent:'codex',token:'must not leak'};
 assert.equal((await post({id:'ok',prompt:'hi',conversation})).status,202);
 for(let i=0;i<50&&!release;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(events[0].phase,'received');assert.equal(events[0].peer.id,'legacy');assert.ok(!JSON.stringify(events[0]).includes('must not leak'));await assert.rejects(b.setProject(dir),/busy/i);release();
 for(let i=0;i<50&&events.length<2;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(events[1].phase,'completed');assert.equal(events[1].job.result,'answer');
 }finally{release?.();await new Promise(r=>b.server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('approval is single flight while callback awaits and polling stays pending',async()=>{
 const releases=[];const peers={};const p=createPairing({peers,save:async()=>{},onApproved:()=>new Promise(r=>releases.push(r))});
 const r=p.start({code:p.code,name:'Bob'},'ip');const approved=p.approve(r.id,true);await new Promise(r=>setImmediate(r));
 const second=p.approve(r.id,true);const outcome=await Promise.race([second.then(()=>false,()=>true),new Promise(r=>setTimeout(()=>r(false),20))]);
 try{assert.equal(outcome,true);assert.equal(p.result(r.id,r.secret).status,'pending');}finally{releases.forEach(r=>r());await approved;await second.catch(()=>{});}
});

test('authenticated self revocation cancels only its own access and native questions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-self-revoke-'));const drops=[];
 const b=await createBridge({dir,project:null,nativeInbox:{dropPeer:async id=>drops.push(id)},onChange:()=>{}});
 const one=await b.pairing.grant({name:'one',enabled:true}),two=await b.pairing.grant({name:'two',enabled:true});
 await new Promise(r=>b.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+b.server.address().port;
 const post=data=>fetch(base+'/pair/revoke',{method:'POST',headers:{authorization:'Bearer '+one.token},body:JSON.stringify(data)});
 try{
  assert.equal((await post({peerId:two.peerId})).status,400);
  assert.equal((await post({})).status,200);
  assert.equal(b.pairing.authenticate(one.token),null);assert.ok(b.pairing.authenticate(two.token));assert.deepEqual(drops,[one.peerId]);
 }finally{await new Promise(r=>b.server.close(r));await rm(dir,{recursive:true,force:true});}
});
