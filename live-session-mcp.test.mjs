import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {openNativeInbox} from './native-inbox.mjs';

const entry=fileURLToPath(new URL('./scripts/live-session-mcp.mjs',import.meta.url));
const value=result=>JSON.parse(result.content[0].text);
function invoke(dir,session,action,args={},extra=[]){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[entry,'--dir',dir,'--tool','codex','--session',session,...extra,action],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);
  child.on('close',code=>{try{resolve({code,result:JSON.parse(out),stderr:err});}catch{reject(Error(err||out||'No adapter output'));}});
  child.stdin.end(JSON.stringify(args));
 });
}
async function fixture(run){
 const dir=await mkdtemp(join(tmpdir(),'original-session-adapter-')),inbox=await openNativeInbox({dir});
 try{await run(dir,inbox);}finally{await Promise.allSettled(['original-a','original-b'].map(id=>invoke(dir,id,'close')));await inbox.close();await rm(dir,{recursive:true,force:true});}
}

test('separate CLI invocations reuse the original conversation handle and exchange real MCP answers',async()=>{
 await fixture(async(dir,inbox)=>{
  const opened=await invoke(dir,'original-a','open',{title:'Original A'});
  assert.equal(opened.code,0,JSON.stringify(opened));const a=value(opened.result);
  const repeated=value((await invoke(dir,'original-a','open',{title:'Do not duplicate'})).result);
  assert.equal(a.id,repeated.id);assert.equal(a.nativeSessionId,'original-a');
  const b=value((await invoke(dir,'original-b','open',{title:'Original B'})).result);
  assert.equal(inbox.catalog().length,2);
  const peers=value((await invoke(dir,'original-a','peers')).result);assert.ok(peers.peers.some(p=>p.id==='local'));
  const sessions=value((await invoke(dir,'original-a','sessions',{connectionId:'local'})).result);assert.equal(sessions.sessions.length,2);
  const question=value((await invoke(dir,'original-a','ask',{connectionId:'local',targetSessionId:b.id,text:'Which identifier?',waitMs:0})).result);
  const {messages:[message]}=value((await invoke(dir,'original-b','receive',{waitMs:0})).result);
  assert.equal(message.text,'Which identifier?');
  const argsFile=join(dir,'reply.json');await writeFile(argsFile,JSON.stringify({questionId:message.id,peerId:message.peerId,text:'Use account_id.'}));
  const reply=await invoke(dir,'original-b','reply',{},['--args-file',argsFile]);assert.equal(reply.code,0,JSON.stringify(reply));
  const answer=value((await invoke(dir,'original-a','result',{questionId:question.id,waitMs:0})).result);assert.equal(answer.answer,'Use account_id.');
  const status=(await invoke(dir,'original-a','status')).result;assert.equal(status.nativeSessionId,'original-a');assert.equal(status.bridgeSessionId,a.id);assert.equal(status.idleTtlMs,1800000);
  assert.equal((await invoke(dir,'original-a','close')).code,0);
  assert.deepEqual(inbox.catalog().map(s=>s.id),[b.id]);
  assert.notEqual((await invoke(dir,'original-a','status')).code,0);
 });
});

test('worker authenticates its local interface and rejects arbitrary actions, handles and oversized bodies',async()=>{
 await fixture(async(dir)=>{
  const opened=await invoke(dir,'original-a','open',{title:'Original A'});assert.equal(opened.code,0,JSON.stringify(opened));
  const a=value(opened.result);
  const records=await readdir(join(dir,'live-session-mcp'));assert.equal(records.filter(f=>f.endsWith('.json')).length,1);
  const path=join(dir,'live-session-mcp',records.find(f=>f.endsWith('.json'))),record=JSON.parse(await readFile(path,'utf8'));
  if(process.platform!=='win32')assert.equal((await stat(path)).mode&0o777,0o600);
  assert.equal(Object.hasOwn(record,'lease'),false);assert.equal(record.nativeSessionId,'original-a');
  const url='http://127.0.0.1:'+record.port;
  assert.equal((await fetch(url+'/health',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  const call=body=>fetch(url+'/command',{method:'POST',headers:{authorization:'Bearer '+record.capability,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await call({action:'exec',args:{command:'anything'}})).status,400);
  assert.equal((await call({action:'receive',args:{sessionId:a.id}})).status,400);
  assert.equal((await call({action:'ask',args:{text:'x'.repeat(40000)}})).status,413);
  const health=await fetch(url+'/health',{method:'POST',headers:{authorization:'Bearer '+record.capability,'content-type':'application/json'},body:'{}'});const identity=await health.json();
  assert.equal(identity.nativeSessionId,'original-a');assert.equal(identity.tool,'codex');assert.equal(Object.hasOwn(identity,'capability'),false);
  await invoke(dir,'original-a','close');await assert.rejects(readFile(path),{code:'ENOENT'});
 });
});

test('an idle worker unregisters its original conversation without launching a model',async()=>{
 await fixture(async(dir,inbox)=>{
  assert.equal((await invoke(dir,'original-a','open',{title:'Short lived'},['--idle-ttl-ms','250'])).code,0);
  const deadline=Date.now()+5000;while(inbox.catalog().length&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
  assert.equal(inbox.catalog().length,0);
  assert.notEqual((await invoke(dir,'original-a','status')).code,0);
 });
});

test('reopening after a broker restart reports a lost registration instead of advertising the old handle',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'original-session-restart-'));
 let inbox=await openNativeInbox({dir});
 try{
  const opened=await invoke(dir,'original-a','open',{title:'Original A'});assert.equal(opened.code,0,JSON.stringify(opened));
  await inbox.close();inbox=await openNativeInbox({dir});
  const repeated=await invoke(dir,'original-a','open',{title:'Original A'});
  assert.notEqual(repeated.code,0,'A cached handle must not appear live after the broker lost its registration');
  assert.match(repeated.result.error,/registration.*unavailable/i);assert.equal(inbox.catalog().length,0);
 }finally{await invoke(dir,'original-a','close');await inbox.close();await rm(dir,{recursive:true,force:true});}
});

test('a large legitimate receive result stays readable and its worker can still close',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'original-session-large-')),inbox=await openNativeInbox({dir});let status;
 try{
  const opened=await invoke(dir,'original-a','open',{title:'Original A'});assert.equal(opened.code,0,JSON.stringify(opened));const a=value(opened.result);
  status=(await invoke(dir,'original-a','status')).result;
  for(let i=0;i<11;i++)await inbox.request({id:'paired-test'},{id:'question-'+i,targetSessionId:a.id,source:{id:'peer-a',title:'Peer original',tool:'codex'},text:'x'.repeat(20000)});
  const received=await invoke(dir,'original-a','receive',{waitMs:0});assert.equal(received.code,0,JSON.stringify(received));
  const messages=value(received.result).messages;assert.equal(messages.length,11);assert.equal(messages[10].text.length,20000);
  assert.equal((await invoke(dir,'original-a','close')).code,0);assert.equal(inbox.catalog().length,0);
 }finally{
  await invoke(dir,'original-a','close');
  // Even the pre-fix failure must not leave this test's detached children behind.
  for(const pid of [status?.mcpPid,status?.workerPid])if(pid)try{process.kill(pid);}catch{}
  await inbox.close();await rm(dir,{recursive:true,force:true});
 }
});
