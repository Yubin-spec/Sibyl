import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createControl} from './control.mjs';

test('managed consultation follows the saved project binding without a target project argument',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'consult-'));const calls=[];
 const control=await createControl({dir,detect:async()=>({claude:'test',codex:'test'}),runner:async(prompt,session,signal,project,agent,options)=>{calls.push({prompt,session,project,agent,options});return {session_id:'consult-session',result:'parser verified'};}});
 await new Promise(resolve=>control.server.listen(0,'127.0.0.1',resolve));
 try{
  const project=control.store.saveProject({name:'project',path:dir});
  await mkdir(join(dir,'target'));const targetProject=control.store.saveProject({name:'target',path:join(dir,'target')});
  control.store.saveBinding({sourceProjectId:project.id,targetTool:'claude',targetProjectId:targetProject.id});
  const runtime=JSON.parse(await readFile(join(dir,'native-runtime.json'),'utf8'));
  const local=async(path,body)=>{const response=await fetch(runtime.url+path,{method:'POST',headers:{authorization:'Bearer '+runtime.token,'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
  const source=await local('/register',{tool:'codex',title:'source',projectPath:dir});
  const started=await local('/consult',{id:source.id,lease:source.lease,tool:'claude',text:'verify parser'});
  assert.equal(started.status,'running');
  let result;
  for(let i=0;i<50;i++){result=await local('/consult/result',{id:source.id,lease:source.lease,consultId:started.consultId,waitMs:100});if(result.status!=='running')break;}
  assert.equal(result.status,'completed');assert.equal(result.text,'parser verified');
  assert.equal(calls.length,1);assert.equal(calls[0].agent,'claude');assert.equal(calls[0].project,targetProject.path);
  assert.equal(calls[0].options.fast,true);assert.equal(calls[0].options.readOnly,true);assert.equal(typeof calls[0].options.onOutput,'function');assert.match(calls[0].prompt,/verify parser/);assert.match(calls[0].prompt,/一次只回答当前核对问题/);assert.match(calls[0].prompt,/最需要来源方确认的一项/);
  const target=control.store.snapshot().sessions.find(s=>s.id.startsWith('consult-'));
  assert.equal(target.projectId,targetProject.id);assert.equal(target.nativeSessionId,'consult-session');
  await assert.rejects(local('/consult',{id:source.id,lease:'wrong',tool:'claude',text:'verify'}),/Session/);
 }finally{await control.close();await rm(dir,{recursive:true,force:true});}
});

test('duplicate consultation reuses its worker and flood budget blocks more starts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'consult-budget-'));
 const control=await createControl({dir,detect:async()=>({claude:'test',codex:'test'}),consultLimits:{maxPerWindow:2,maxParallelPerTarget:2,duplicateWindowMs:60000,noProgressMs:5000,maxDurationMs:10000},runner:async()=>({session_id:'same-session',result:'verified'})});
 await new Promise(resolve=>control.server.listen(0,'127.0.0.1',resolve));
 try{
  const project=control.store.saveProject({name:'source',path:dir});
  control.store.saveBinding({sourceProjectId:project.id,targetTool:'claude',targetProjectId:project.id});
  const runtime=JSON.parse(await readFile(join(dir,'native-runtime.json'),'utf8'));
  const local=async(path,body)=>{const response=await fetch(runtime.url+path,{method:'POST',headers:{authorization:'Bearer '+runtime.token,'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
  const source=await local('/register',{tool:'codex',title:'source',projectPath:dir});
  const first=await local('/consult',{id:source.id,lease:source.lease,tool:'claude',text:'verify parser'});
  const duplicate=await local('/consult',{id:source.id,lease:source.lease,tool:'claude',text:' verify   parser '});
  assert.equal(duplicate.consultId,first.consultId);assert.equal(duplicate.deduplicated,true);
  await local('/consult',{id:source.id,lease:source.lease,tool:'claude',text:'verify lexer'});
  await assert.rejects(local('/consult',{id:source.id,lease:source.lease,tool:'claude',text:'verify formatter'}),/已发起 2 次/);
 }finally{await control.close();await rm(dir,{recursive:true,force:true});}
});

test('parallel consultation cap rejects a third worker on the same target',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'consult-parallel-'));let release;const gate=new Promise(resolve=>{release=resolve;});
 const control=await createControl({dir,detect:async()=>({claude:'test',codex:'test'}),consultLimits:{maxParallelPerTarget:1,noProgressMs:5000,maxDurationMs:10000},runner:async(prompt,session,signal,project,agent,options)=>{options.onOutput('started');await gate;return {session_id:'parallel-session',result:'verified'};}});
 await new Promise(resolve=>control.server.listen(0,'127.0.0.1',resolve));
 try{
  const project=control.store.saveProject({name:'source',path:dir});
  control.store.saveBinding({sourceProjectId:project.id,targetTool:'claude',targetProjectId:project.id});
  const runtime=JSON.parse(await readFile(join(dir,'native-runtime.json'),'utf8'));
  const local=async(path,body)=>{const response=await fetch(runtime.url+path,{method:'POST',headers:{authorization:'Bearer '+runtime.token,'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
  const source=await local('/register',{tool:'codex',title:'source',projectPath:dir});
  const first=await local('/consult',{id:source.id,lease:source.lease,tool:'claude',text:'first'});
  await assert.rejects(local('/consult',{id:source.id,lease:source.lease,tool:'claude',text:'second'}),/并发上限/);
  release();let result;for(let i=0;i<50;i++){result=await local('/consult/result',{id:source.id,lease:source.lease,consultId:first.consultId,waitMs:50});if(result.status!=='running')break;}
  assert.equal(result.status,'completed');
 }finally{release();await control.close();await rm(dir,{recursive:true,force:true});}
});

test('watchdog stops a worker that produces no progress',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'consult-watchdog-'));
 const control=await createControl({dir,detect:async()=>({claude:'test',codex:'test'}),consultLimits:{noProgressMs:60,maxDurationMs:2000},runner:async(prompt,session,signal)=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});})});
 await new Promise(resolve=>control.server.listen(0,'127.0.0.1',resolve));
 try{
  const project=control.store.saveProject({name:'source',path:dir});
  control.store.saveBinding({sourceProjectId:project.id,targetTool:'claude',targetProjectId:project.id});
  const runtime=JSON.parse(await readFile(join(dir,'native-runtime.json'),'utf8'));
  const local=async(path,body)=>{const response=await fetch(runtime.url+path,{method:'POST',headers:{authorization:'Bearer '+runtime.token,'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
  const source=await local('/register',{tool:'codex',title:'source',projectPath:dir});
  const started=await local('/consult',{id:source.id,lease:source.lease,tool:'claude',text:'hang'});
  await new Promise(resolve=>setTimeout(resolve,250));
  const result=await local('/consult/result',{id:source.id,lease:source.lease,consultId:started.consultId,waitMs:0});
  assert.equal(result.status,'stalled');assert.match(result.error,/没有收到 Worker 进展/);
 }finally{await control.close();await rm(dir,{recursive:true,force:true});}
});

test('stopping a consultation aborts only its own read-only worker',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'consult-stop-'));
 const control=await createControl({dir,detect:async()=>({claude:'test',codex:'test'}),consultLimits:{noProgressMs:5000,maxDurationMs:10000},runner:async(prompt,session,signal,project,agent,options)=>new Promise((resolve,reject)=>{options.onOutput('started');signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});})});
 await new Promise(resolve=>control.server.listen(0,'127.0.0.1',resolve));
 try{
  const project=control.store.saveProject({name:'source',path:dir});
  control.store.saveBinding({sourceProjectId:project.id,targetTool:'claude',targetProjectId:project.id});
  const runtime=JSON.parse(await readFile(join(dir,'native-runtime.json'),'utf8'));
  const local=async(path,body)=>{const response=await fetch(runtime.url+path,{method:'POST',headers:{authorization:'Bearer '+runtime.token,'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
  const source=await local('/register',{tool:'codex',title:'source',projectPath:dir});
  const started=await local('/consult',{id:source.id,lease:source.lease,tool:'claude',text:'stop me'});
  const stopped=await local('/consult/stop',{id:source.id,lease:source.lease,consultId:started.consultId});
  assert.equal(stopped.status,'cancelled');
  await new Promise(resolve=>setTimeout(resolve,20));
  const result=await local('/consult/result',{id:source.id,lease:source.lease,consultId:started.consultId,waitMs:0});
  assert.equal(result.status,'cancelled');assert.match(result.error,/人工停止/);
 }finally{await control.close();await rm(dir,{recursive:true,force:true});}
});

test('MCP configuration saves the target project binding before any session is registered',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'consult-config-'));
 const control=await createControl({dir,detect:async()=>({claude:'test',codex:'test'}),runner:async()=>({session_id:'unused',result:'unused'})});
 await new Promise(resolve=>control.server.listen(0,'127.0.0.1',resolve));
 try{
  const base=`http://127.0.0.1:${control.server.address().port}`;
  const call=async(path,body)=>{const response=await fetch(base+path,{method:'POST',headers:{origin:base,'x-bridge-ui':control.csrf,'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
  const source=control.store.saveProject({name:'source',path:dir});
  await mkdir(join(dir,'target'));const target=control.store.saveProject({name:'target',path:join(dir,'target')});
  await call('/api/tools/connect',{projectId:source.id,agent:'claude',targetTool:'codex',targetProjectId:target.id});
  const status=await (await fetch(base+'/api/status',{headers:{'x-bridge-ui':control.csrf}})).json();
  assert.deepEqual(status.bindings,[{sourceProjectId:source.id,targetTool:'codex',targetProjectId:target.id}]);assert.deepEqual(status.nativeSessions,[]);
  await assert.rejects(call('/api/tools/connect',{projectId:source.id,agent:'claude',targetTool:'codex'}),/目标工具和目标项目需要一起选择/);
 }finally{await control.close();await rm(dir,{recursive:true,force:true});}
});
