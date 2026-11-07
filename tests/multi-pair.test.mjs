import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {createControl} from '../src/app/control.mjs';

async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'multi-pair-'));
 const c=await createControl({dir,detect:async()=>({claude:'test',codex:'test'})});
 await new Promise(r=>c.server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${c.server.address().port}`;
 return {dir,c,call:async(path,body)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{origin:base,'x-bridge-ui':c.csrf,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;},close:async()=>{await c.close();await rm(dir,{recursive:true,force:true});}};
}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function waitFor(f,predicate,label){let state;for(let i=0;i<200;i++){state=await f.call('/api/status');if(predicate(state))return state;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out waiting for '+label+' '+JSON.stringify(state));}

test('one receiver authorizes two peer computers independently',async()=>{
 const host=await fixture(),b=await fixture(),c=await fixture();
 try{
  const project=await host.call('/api/projects/save',{name:'Host project',path:host.dir});
  const port=await freePort();
  await host.call('/api/host/start',{projectId:project.id,port});
  const first=await host.call('/api/status');
  const url=`http://127.0.0.1:${port}`;
  await b.call('/api/pair',{url,code:first.host.code,name:'Alice laptop'});
  await c.call('/api/pair',{url,code:first.host.code,name:'Bob laptop'});
  const pending=await waitFor(host,s=>s.host?.requests.length===2,'two pairing requests');
  for(const request of pending.host.requests)await host.call('/api/host/approve',{id:request.id,accept:true});
  const bs=await waitFor(b,s=>s.connections.length===1&&s.connections[0].status==='online','Alice connection');
  const cs=await waitFor(c,s=>s.connections.length===1&&s.connections[0].status==='online','Bob connection');
  const hs=await host.call('/api/status');
  assert.equal(hs.host.peers.length,2);
  assert.deepEqual(new Set(hs.host.peers.map(p=>p.name)),new Set(['Alice laptop','Bob laptop']));
  assert.equal(bs.connections[0].url,url+'/');
  assert.equal(cs.connections[0].url,url+'/');
 }finally{await host.close();await b.close();await c.close();}
});
