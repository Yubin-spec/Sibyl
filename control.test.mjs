import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';

test('desktop control rejects cross-origin commands and keeps pairing credentials out of status',async()=>{
  const {createControl}=await import('./control.mjs');
  const dir=await mkdtemp(join(tmpdir(),'bridge-control-'));
  const control=await createControl({dir,detect:async()=>({claude:'test'})});
  await new Promise(r=>control.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${control.server.address().port}`;
  const call=(path,data,headers={})=>fetch(base+path,{method:data?'POST':'GET',headers:{origin:base,'content-type':'application/json','x-bridge-ui':control.csrf,...headers},body:data?JSON.stringify(data):undefined});
  try{
    assert.equal((await call('/api/host/start',{project:dir},{origin:'https://evil.example'})).status,403);
    assert.equal((await call('/api/host/start',{project:dir},{'x-bridge-ui':''})).status,403);
    assert.equal((await fetch(base+'/api/status')).status,403);
    const status=await (await call('/api/status')).json();
    assert.equal(status.host,null);
    assert.deepEqual(status.connections,[]);
    assert.deepEqual(status.agents,{claude:'test'});
    assert.equal(status.operation,null);
    const page=await (await fetch(base+'/')).text();assert.match(page,/AI Bridge/);
    assert.ok(!JSON.stringify(status).includes(control.csrf));
    const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
    assert.equal((await call('/api/host/start',{project:dir,port})).status,200);
    const hosted=await (await call('/api/status')).json();assert.match(hosted.host.code,/^\d{8}$/);
    const remote=await fetch(`http://127.0.0.1:${port}/pair/start`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:hosted.host.code,name:'Team Mac'})});
    const request=await remote.json();
    const waiting=await (await call('/api/status')).json();assert.equal(waiting.host.requests[0].name,'Team Mac');
    assert.equal((await call('/api/host/approve',{id:request.id,accept:true})).status,200);
    const approval=await (await fetch(`http://127.0.0.1:${port}/pair/result`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)})).json();
    assert.equal(approval.status,'approved');
    const paired=await (await call('/api/status')).json();assert.equal(paired.host.peers.length,1);
    assert.ok(!JSON.stringify(paired).includes(approval.token));
    assert.equal((await call('/api/host/revoke',{id:approval.peerId})).status,200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`,{headers:{authorization:'Bearer '+approval.token}})).status,401);
  }finally{await control.close();await rm(dir,{recursive:true,force:true});}
});
