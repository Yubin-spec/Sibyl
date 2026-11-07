import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {openNativeInbox} from './native-inbox.mjs';
import {openWorkspace} from './workspace.mjs';
import {canonicalProjectPath,projectKey} from './project-path.mjs';
import {createControl} from './control.mjs';

const entry=fileURLToPath(new URL('./native-mcp.mjs',import.meta.url));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function client(dir,tool,cwd){
 const child=spawn(process.execPath,[entry,'--dir',dir,'--tool',tool],{cwd,stdio:['pipe','pipe','pipe'],windowsHide:true});
 const pending=new Map();let serial=0,stderr='',gone=false;
 const exited=new Promise(resolve=>child.once('close',()=>{gone=true;resolve();}));
 child.stderr.on('data',b=>stderr+=b);
 createInterface({input:child.stdout}).on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}const p=pending.get(value.id);if(!p)return;pending.delete(value.id);value.error?p.reject(Error(value.error.message)):p.resolve(value.result);});
 child.once('close',()=>{for(const p of pending.values())p.reject(Error('MCP exited: '+stderr));pending.clear();});
 return {
  child,exited,
  call(method,params={}){const id=++serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('MCP call timeout'));},8000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});},
  async tool(name,args={}){const value=await this.call('tools/call',{name,arguments:args});if(value.isError)throw Error(value.content[0].text);return JSON.parse(value.content[0].text);},
  async close(){if(gone)return;child.stdin.end();await exited;},
  async kill(){if(gone)return;child.kill('SIGKILL');await exited;}
 };
}

async function projects(){
 const root=await mkdtemp(join(tmpdir(),'bridge-autobind-'));
 const a=join(root,'alpha'),b=join(root,'beta');
 await mkdir(a);await mkdir(b);
 return {root,a,b};
}

test('project keys normalize separators, trailing separators, dot segments and Windows case',async()=>{
 const cwd=process.cwd();
 assert.equal(projectKey(cwd),projectKey(cwd+sep));
 assert.equal(projectKey(cwd),projectKey(join(cwd,'.','..',cwd.split(sep).at(-1))));
 assert.equal(projectKey(cwd),canonicalProjectPath(cwd)&&projectKey(canonicalProjectPath(cwd)));
 if(process.platform==='win32')assert.equal(projectKey(cwd),projectKey(cwd.toUpperCase()));
 assert.equal(projectKey(join(tmpdir(),'missing-'+Date.now())),null);
 assert.throws(()=>canonicalProjectPath(join(tmpdir(),'missing-'+Date.now())));
});

test('workspace finds or creates projects by canonical path and can disable auto binding',async()=>{
 const {root,a}=await projects();
 const w=await openWorkspace(join(root,'data'));
 try{
  const saved=w.ensureProjectByPath(a);
  assert.equal(saved.name,'alpha');
  assert.equal(saved.path,resolve(a));
  assert.equal(w.ensureProjectByPath(a+sep).id,saved.id);
  assert.equal(w.ensureProjectByPath(join(a,'.')).id,saved.id);
  if(process.platform==='win32')assert.equal(w.ensureProjectByPath(a.toUpperCase()).id,saved.id);
  assert.equal(w.snapshot().projects.length,1);
  assert.equal(w.snapshot().settings.autoBindProjects,true);
  assert.equal(w.updateSettings({autoBindProjects:false}).autoBindProjects,false);
  assert.throws(()=>w.updateSettings({autoBindProjects:'yes'}));
  assert.throws(()=>w.ensureProjectByPath(join(root,'missing')));
 }finally{w.close();await rm(root,{recursive:true,force:true});}
});

test('same-project MCP processes register automatically and never list another project',async()=>{
 const {root,a,b}=await projects();
 const dir=join(root,'data'),inbox=await openNativeInbox({dir});
 const claude=client(dir,'claude',a),codex=client(dir,'codex',a),outsider=client(dir,'codex',b);
 try{
  await Promise.all([claude.tool('bridge_list_sessions',{}),codex.tool('bridge_list_sessions',{})]);
  const first=await claude.tool('bridge_list_sessions',{});
  assert.deepEqual(first.sessions.map(s=>s.tool).sort(),['claude','codex']);
  assert.equal(first.sessions.find(s=>s.tool==='claude').status,'available');
  assert.equal(first.scope,'project');
  assert.equal(first.project,canonicalProjectPath(a));
  const both=await codex.tool('bridge_list_sessions',{});
  assert.deepEqual(both.sessions.map(s=>s.tool).sort(),['claude','codex']);
  const other=await outsider.tool('bridge_list_sessions',{});
  assert.deepEqual(other.sessions.map(s=>s.tool),['codex']);
  const all=await outsider.tool('bridge_list_sessions',{all:true});
  assert.equal(all.sessions.length,3);
  await assert.rejects(outsider.tool('bridge_ask',{text:'who owns the parser?',waitMs:0}),/No other AI tool/);
 }finally{await claude.close();await codex.close();await outsider.close();await inbox.close();await rm(root,{recursive:true,force:true});}
});

test('bridge_ask without a target routes to the only peer in the same project',async()=>{
 const {root,a}=await projects();
 const dir=join(root,'data'),inbox=await openNativeInbox({dir});
 const claude=client(dir,'claude',a),codex=client(dir,'codex',a);
 try{
  await claude.tool('bridge_list_sessions',{});
  const asking=codex.tool('bridge_ask',{text:'Which field should I use?',waitMs:4000});
  const {messages:[question]}=await claude.tool('bridge_receive',{waitMs:4000});
  assert.equal(question.text,'Which field should I use?');
  await claude.tool('bridge_reply',{questionId:question.id,peerId:question.peerId,text:'Use account_id.'});
  const answer=await asking;
  assert.equal(answer.answer,'Use account_id.');
  assert.equal(answer.source.tool,'codex');
  const [{id:target}]=inbox.catalog().filter(s=>s.tool==='claude');
  assert.equal(answer.targetSessionId,target);
 }finally{await claude.close();await codex.close();await inbox.close();await rm(root,{recursive:true,force:true});}
});

test('multiple peers return a most-recent-first candidate list instead of a guess',async()=>{
 const {root,a}=await projects();
 const dir=join(root,'data'),inbox=await openNativeInbox({dir});
 const first=client(dir,'claude',a),second=client(dir,'claude',a),codex=client(dir,'codex',a);
 try{
  const one=await first.tool('bridge_open_session',{title:'Claude one'});
  await sleep(20);
  const two=await second.tool('bridge_open_session',{title:'Claude two'});
  const routed=await codex.tool('bridge_ask',{text:'Which module owns retries?',waitMs:0});
  assert.equal(routed.status,'ambiguous');
  assert.deepEqual(routed.candidates.map(c=>c.id),[two.id,one.id]);
  assert.deepEqual(routed.candidates.map(c=>c.title),['Claude two','Claude one']);
  assert.match(routed.notice,/targetSessionId/);
  assert.equal(inbox.snapshot().questions.length,0);
 }finally{await first.close();await second.close();await codex.close();await inbox.close();await rm(root,{recursive:true,force:true});}
});

test('heartbeats keep a session alive and an expired one stops blocking auto routing',async()=>{
 const {root,a}=await projects();
 let clock=Date.now();
 const dir=join(root,'data'),inbox=await openNativeInbox({dir,now:()=>clock});
 try{
  const runtime=JSON.parse(await readFile(join(dir,'native-runtime.json'),'utf8'));
  const post=async(path,body)=>{const r=await fetch(runtime.url+path,{method:'POST',headers:{authorization:'Bearer '+runtime.token,'content-type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error);return data;};
  const session=await post('/register',{tool:'claude',title:'stale peer',projectPath:a,pid:process.pid,auto:true});
  clock+=60000;await post('/touch',{id:session.id,lease:session.lease});
  clock+=30000;assert.equal(inbox.catalog().length,1);
  clock+=61000;assert.equal(inbox.catalog().length,0);
  const codex=client(dir,'codex',a);
  try{await assert.rejects(codex.tool('bridge_ask',{text:'still blocked?',waitMs:0}),/No other AI tool/);}
  finally{await codex.close();}
 }finally{await inbox.close();await rm(root,{recursive:true,force:true});}
});

test('a killed MCP process is dropped by pid instead of waiting for TTL',async()=>{
 const {root,a}=await projects();
 const dir=join(root,'data'),inbox=await openNativeInbox({dir});
 const codex=client(dir,'codex',a);
 try{
  await codex.tool('bridge_list_sessions',{});
  assert.equal(inbox.catalog().length,1);
  await codex.kill();
  await sleep(30);
  assert.equal(inbox.catalog().length,0);
  const claude=client(dir,'claude',a);
  try{await assert.rejects(claude.tool('bridge_ask',{text:'anyone?',waitMs:0}),/No other AI tool/);}
  finally{await claude.close();}
 }finally{await codex.close();await inbox.close();await rm(root,{recursive:true,force:true});}
});

test('automatic routing can be switched off and explicit targets still work',async()=>{
 const {root,a}=await projects();
 const dir=join(root,'data'),inbox=await openNativeInbox({dir,autoBind:()=>false});
 const claude=client(dir,'claude',a),codex=client(dir,'codex',a);
 try{
  await claude.tool('bridge_list_sessions',{});
  const listing=await codex.tool('bridge_list_sessions',{});
  const peer=listing.sessions.find(s=>s.tool==='claude');
  assert.ok(peer);
  await assert.rejects(codex.tool('bridge_ask',{text:'auto?',waitMs:0}),/Automatic project routing is off/);
  const asking=codex.tool('bridge_ask',{targetSessionId:peer.id,text:'explicit?',waitMs:4000});
  const {messages:[question]}=await claude.tool('bridge_receive',{waitMs:4000});
  await claude.tool('bridge_reply',{questionId:question.id,peerId:question.peerId,text:'explicit works'});
  assert.equal((await asking).answer,'explicit works');
 }finally{await claude.close();await codex.close();await inbox.close();await rm(root,{recursive:true,force:true});}
});

test('closing the automatic handle stops sharing until bridge_open_session reopens it',async()=>{
 const {root,a}=await projects();
 const dir=join(root,'data'),inbox=await openNativeInbox({dir});
 const codex=client(dir,'codex',a);
 try{
  await codex.tool('bridge_list_sessions',{});
  assert.equal(inbox.catalog().length,1);
  await codex.tool('bridge_close_session',{});
  assert.equal(inbox.catalog().length,0);
  await assert.rejects(codex.tool('bridge_receive',{}),/Sharing is off/);
  const reopened=await codex.tool('bridge_open_session',{title:'Reopened'});
  assert.equal(reopened.title,'Reopened');
  assert.deepEqual((await codex.tool('bridge_receive',{waitMs:0})).messages,[]);
 }finally{await codex.close();await inbox.close();await rm(root,{recursive:true,force:true});}
});

test('control registers the project from the MCP working directory and honors its setting',async()=>{
 const {root,a}=await projects();
 const dir=join(root,'data');
 const control=await createControl({dir,detect:async()=>({claude:'test',codex:'test'})});
 const base=await new Promise(resolve=>control.server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+control.server.address().port)));
 const status=async()=>{const r=await fetch(base+'/api/status',{headers:{'x-bridge-ui':control.csrf}});assert.equal(r.status,200);return r.json();};
 const claude=client(dir,'claude',a),codex=client(dir,'codex',a);
 try{
  await claude.tool('bridge_list_sessions',{});
  await codex.tool('bridge_list_sessions',{});
  const state=await status();
  assert.deepEqual(state.nativeSessions.map(s=>s.tool).sort(),['claude','codex']);
  const project=state.projects.find(p=>projectKey(p.path)===projectKey(a));
  assert.ok(project,'the MCP working directory becomes a saved project');
  assert.equal(project.name,'alpha');
  assert.ok(state.nativeSessions.every(s=>s.lastActiveAt));
  control.store.updateSettings({autoBindProjects:false});
  await assert.rejects(codex.tool('bridge_ask',{text:'off?',waitMs:0}),/Automatic project routing is off/);
  control.store.updateSettings({autoBindProjects:true});
  const asking=codex.tool('bridge_ask',{text:'on?',waitMs:4000});
  const {messages:[question]}=await claude.tool('bridge_receive',{waitMs:4000});
  await claude.tool('bridge_reply',{questionId:question.id,peerId:question.peerId,text:'on'});
  assert.equal((await asking).answer,'on');
 }finally{await claude.close();await codex.close();await control.close();await rm(root,{recursive:true,force:true});}
});
