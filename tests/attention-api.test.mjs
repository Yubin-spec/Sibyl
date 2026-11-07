import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createControl} from '../src/app/control.mjs';
import {openWorkspace} from '../src/app/workspace.mjs';

test('attention API exposes failures once and persists dismissal until the record changes', async () => {
  const dir=await mkdtemp(join(tmpdir(),'attention-api-'));
  const seed=await openWorkspace(dir);
  const project=seed.saveProject({name:'Sibyl',path:dir});
  const session=seed.registerSession({projectId:project.id,tool:'codex',title:'Review'});
  const conversation=seed.createConversation({title:'Failed run',projectId:project.id,localSessionId:session.id,connectionId:'local',remoteAgent:'claude',mode:'channel'});
  seed.updateConversation(conversation.id,{status:'failed',stopReason:'execution error'});
  const now=new Date().toISOString();
  seed.saveConsultation({id:'consult-api',threadId:'thread-api',sourceSessionId:'source',sourceProjectId:project.id,targetTool:'claude',targetProjectId:project.id,question:'check',status:'failed',round:1,startedAt:now,lastProgressAt:now,progressEvents:1,outputBytes:1,error:'tool unavailable'});
  seed.close();
  const control=await createControl({dir,detect:async()=>({}),runner:async()=>({result:'unused'})});
  await new Promise(resolve=>control.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${control.server.address().port}`;
  const call=async(path,body)=>{
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin:base,'x-bridge-ui':control.csrf,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
    const value=await response.json();
    assert.ok(response.ok,JSON.stringify(value));
    return value;
  };
  try {
    const first=await call('/api/status');
    assert.equal(first.attention.length,2);
    assert.deepEqual(first.attention.map(item=>item.kind),['consult','conversation']);
    assert.equal(first.attention.every(item=>item.dismissible),true);

    await call('/api/attention/dismiss',{id:first.attention[0].key});
    const second=await call('/api/status');
    assert.equal(second.attention.length,1);
    assert.equal(second.attention[0].kind,'conversation');

    await call('/api/attention/dismiss',{id:first.attention[1].key});
    const third=await call('/api/status');
    assert.deepEqual(third.attention,[]);
  } finally {
    await control.close();
    await rm(dir,{recursive:true,force:true});
  }
});
