import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';

test('authenticated HTTP turns resume, deduplicate, reject concurrent work and cancel', async () => {
  const {createBridge} = await import('./bridge.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'bridge-test-'));
  let calls = 0;
  const runner = async (prompt, session, signal) => {
    calls++;
    if (prompt === 'wait') return new Promise((resolve,reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), {once:true}));
    return {session_id: session || 'session-one', result: session ? 'remembered' : 'hello'};
  };
  const bridge = await createBridge({dir, token:'test-secret', project:dir, runner});
  await new Promise(r => bridge.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${bridge.server.address().port}`;
  const call = (path, data, token='test-secret') => fetch(url+path, {method:data ? 'POST':'GET', headers:{authorization:`Bearer ${token}`, 'content-type':'application/json'}, body:data ? JSON.stringify(data):undefined});
  const done = async id => {
    for(let i=0;i<100;i++) {const j=await (await call('/jobs/'+id)).json(); if(j.status!=='running') return j; await new Promise(r=>setTimeout(r,10));}
    throw Error('job did not finish');
  };
  try {
    assert.equal((await call('/health', undefined, 'wrong')).status,401);
    assert.equal((await call('/turn', {id:'bad',prompt:''})).status,400);
    assert.equal((await call('/turn',{id:'a',prompt:'hi'})).status,202);
    assert.equal((await done('a')).result,'hello');
    assert.equal((await call('/turn',{id:'b',prompt:'next'})).status,202);
    assert.equal((await done('b')).result,'remembered');
    await call('/turn',{id:'b',prompt:'next'});
    assert.equal(calls,2);
    assert.equal((await call('/turn',{id:'b',prompt:'different'})).status,409);
    await call('/turn',{id:'c',prompt:'wait'});
    assert.equal((await call('/turn',{id:'d',prompt:'overlap'})).status,409);
    await call('/stop',{});
    assert.equal((await done('c')).status,'cancelled');
  } finally {await new Promise(r=>bridge.server.close(r));}
  const restored = await createBridge({dir, token:'test-secret',project:dir,runner});
  assert.equal(restored.state.session,'session-one');
  assert.equal(restored.state.jobs.b.result,'remembered');
  await rm(dir,{recursive:true,force:true});
});

test('restart marks uncertain running jobs interrupted without rerunning them', async()=>{
  const {createBridge}=await import('./bridge.mjs');
  const dir=await mkdtemp(join(tmpdir(),'bridge-restart-'));
  try {
    await writeFile(join(dir,'state.json'),JSON.stringify({session:'saved-session',jobs:{old:{status:'running',prompt:'do not repeat'}}}));
    const bridge=await createBridge({dir,token:'secret',project:dir,runner:()=>{assert.fail('must not replay');}});
    assert.equal(bridge.state.jobs.old.status,'interrupted');
    assert.equal(bridge.state.session,'saved-session');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('child execution accepts stdin and cancels a running process',async()=>{
  const {runProcess}=await import('./bridge.mjs');
  assert.equal(await runProcess(process.execPath,['-e','process.stdin.pipe(process.stdout)'],{input:'literal $(do-not-execute)'}),'literal $(do-not-execute)');
  const controller=new AbortController();
  const running=runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:controller.signal});
  controller.abort();
  await assert.rejects(running,/cancelled/);
  await assert.rejects(runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:20}),/timed out/);
});

test('coordinator automatically relays Claude reply back into the same Codex session',async()=>{
  const {discuss} = await import('./bridge.mjs');
  const codexInputs=[], claudeInputs=[];
  const result = await discuss({goal:'design auth', rounds:2,
    codex:async(prompt,session)=>{codexInputs.push({prompt,session});return {session_id:session||'codex-one',result:codexInputs.length===1?'Which auth?':'Use sessions.'};},
    claude:async prompt=>{claudeInputs.push(prompt);return {result:claudeInputs.length===1?'Prefer cookies.':'Agreed.'};},
    log:()=>{}});
  assert.equal(claudeInputs.length,2);
  assert.match(claudeInputs[0],/Which auth\?/);
  assert.match(codexInputs[1].prompt,/Prefer cookies\./);
  assert.equal(codexInputs[1].session,'codex-one');
  assert.equal(result.length,5);
  assert.equal(codexInputs[2].session,'codex-one');
  assert.match(codexInputs[2].prompt,/Agreed\./);
  assert.match(codexInputs[2].prompt,/最终答复/);
});

test('paired members choose an agent and keep room sessions and job ownership separate',async()=>{
  const {createBridge}=await import('./bridge.mjs');
  const dir=await mkdtemp(join(tmpdir(),'bridge-team-'));
  const inputs=[];
  const b=await createBridge({dir,project:dir,agents:{claude:'test',codex:'test'},runner:async(prompt,session,signal,project,agent)=>{inputs.push({session,agent});return {session_id:session||'s'+inputs.length,result:'OK'};}});
  await new Promise(r=>b.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${b.server.address().port}`;
  const req=async(token,path,data)=>fetch(base+path,{method:data?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:data?JSON.stringify(data):undefined});
  try{
    const pair=async name=>{const r=await (await req('', '/pair/start',{name,code:b.pairing.code})).json();await b.pairing.approve(r.id,true);return (await (await req('','/pair/result',r)).json()).token;};
    const alice=await pair('alice'),bob=await pair('bob');
    const turn=async(token,id,room,agent)=>{const r=await req(token,'/turn',{id,room,agent,prompt:'hello'});assert.equal(r.status,202);for(let i=0;i<100;i++){const j=await (await req(token,'/jobs/'+id)).json();if(j.status==='completed'){await new Promise(r=>setTimeout(r,10));return;}await new Promise(r=>setTimeout(r,10));}assert.fail('timeout');};
    await turn(alice,'one','task-a','codex');
    await turn(alice,'two','task-a','codex');
    await turn(alice,'three','task-b','codex');
    await turn(bob,'one','task-a','codex');
    assert.equal(inputs[1].session,'s1');
    assert.equal(inputs[2].session,null);
    assert.equal(inputs[3].session,null);
    assert.equal(inputs[0].agent,'codex');
    assert.equal((await req(bob,'/jobs/two')).status,404);
    assert.equal((await req(alice,'/turn',{id:'bad',room:'task',agent:'unknown',prompt:'hi'})).status,400);
  }finally{await new Promise(r=>b.server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('closed network connection reports the actual target and diagnostic code',async()=>{
  const {makeClient}=await import('./bridge.mjs');
  const server=http.createServer(req=>req.socket.destroy());
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}`;
  try{await assert.rejects(makeClient(url)('/pair/start',{code:'12345678',name:'test'}),e=>e.message.includes(url)&&e.message.includes('UND_ERR_SOCKET')&&e.message.includes('未收到'))}
  finally{await new Promise(r=>server.close(r));}
});

test('targeted cancellation never interrupts another job owned by the same peer',async()=>{
 const {createBridge}=await import('./bridge.mjs');const dir=await mkdtemp(join(tmpdir(),'bridge-target-stop-'));
 let started;const ready=new Promise(r=>started=r);
 const b=await createBridge({dir,project:dir,token:'peer',runner:async(p,s,signal)=>{started();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));}});
 await new Promise(r=>b.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+b.server.address().port;
 const post=async(path,data)=>fetch(base+path,{method:'POST',headers:{authorization:'Bearer peer'},body:JSON.stringify(data)});
 try{
  await post('/turn',{id:'job-b',prompt:'wait'});await ready;
  await post('/stop',{id:'job-a'});await new Promise(r=>setTimeout(r,5));assert.equal(b.state.jobs['job-b'].status,'running');
  await post('/stop',{id:'job-b'});for(let i=0;i<100&&b.state.jobs['job-b'].status==='running';i++)await new Promise(r=>setTimeout(r,5));assert.equal(b.state.jobs['job-b'].status,'cancelled');
 }finally{b.cancel();await new Promise(r=>b.server.close(r));await rm(dir,{recursive:true,force:true});}
});
