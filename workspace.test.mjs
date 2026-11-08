import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, symlink, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspace } from './workspace.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-'));
  const {openWorkspace} = await import('./workspace.mjs');
  const dir = join(root,'data');
  const handles = [];
  const open = async () => {const w=await openWorkspace(dir);handles.push(w);return w;};
  t.after(async () => {
    // Windows cannot remove an open SQLite file. Keep close and removal in one
    // hook so later reopens are also closed before deleting the fixture.
    for (const w of handles) {try {w.close();} catch(error) {if(error.code!=='ERR_INVALID_STATE') throw error;}}
    await rm(root, {recursive:true,force:true});
  });
  const w = await open();
  await mkdir(join(root,'a')); await mkdir(join(root,'b'));
  return {root,dir,w,open};
}

test('persists defaults, stable identity, private database and interrupted recovery', async t => {
  const {w,dir,root,open}=await fixture(t); const id=w.snapshot().device.id;
  assert.equal(w.snapshot().settings.networkPort,47831);
  w.setDevice({name:"Bob's device",owner:'Me'});
  w.updateSettings({page:'projects',closeToTray:false,networkPort:50000});
  const p=w.saveProject({name:"quoted ' project",path:join(root,'a')});
  const s=w.registerSession({projectId:p.id,tool:'codex',title:'test'});
  const c=w.createConversation({title:'work',projectId:p.id,localSessionId:s.id,connectionId:'local',remoteAgent:'claude'});
  w.updateConversation(c.id,{status:'running'});w.close();
  const reopened=await open();
  assert.equal(reopened.snapshot().device.id,id); assert.equal(reopened.snapshot().device.name,"Bob's device");
  assert.equal(reopened.getConversation(c.id).status,'failed');
  assert.equal(reopened.getProject(p.id).name,"quoted ' project");
  const file=join(dir,'workspace.sqlite'),metadata=await stat(file);
  if(process.platform==='win32') {
    // Windows chmod exposes the writable attribute, not POSIX ACL privacy.
    // Verify an actual readable/writable SQLite file while persistence remains
    // covered above; owner-only mode is checked on platforms that support it.
    assert.ok(metadata.isFile());
    assert.equal(metadata.mode & 0o600,0o600);
    await access(file,constants.R_OK | constants.W_OK);
    assert.equal((await readFile(file)).subarray(0,16).toString(),'SQLite format 3\0');
  } else assert.equal(metadata.mode & 0o777,0o600);
  assert.equal('messages' in reopened.snapshot(),false);
});

test('canonical projects and session/conversation references stay isolated',async t=>{
  const {root,w}=await fixture(t);const p=w.saveProject({name:'A',path:join(root,'a')});
  await symlink(join(root,'a'),join(root,'alias'),process.platform==='win32'?'junction':'dir');
  assert.equal(w.saveProject({name:'alias',path:join(root,'alias')}).id,p.id);
  const q=w.saveProject({name:'B',path:join(root,'b')});
  assert.throws(()=>w.saveProject({name:'missing',path:join(root,'missing')}));
  const s=w.registerSession({projectId:p.id,tool:'claude',title:'A',mode:'native-inbox',capability:'inbox'});
  assert.equal(s.capability,'unregistered');
  const r=w.registerSession({projectId:q.id,tool:'codex',title:'B'});
  assert.throws(()=>w.registerSession({projectId:p.id,tool:'evil',title:'bad'}));
  assert.throws(()=>w.createConversation({title:'bad',projectId:p.id,localSessionId:r.id,connectionId:'local',remoteAgent:'codex'}));
  const c=w.createConversation({title:'A',projectId:p.id,localSessionId:s.id,connectionId:'local',remoteAgent:'codex'});
  assert.throws(()=>w.deleteProject(p.id));assert.throws(()=>w.deleteProject(q.id));
  assert.throws(()=>w.updateConversation(c.id,{projectId:q.id}));
  assert.equal(w.updateSession(s.id,{nativeSessionId:'native',capability:'inbox'}).capability,'inbox');
  assert.equal(w.getSession(r.id).projectId,q.id);
  for (const fn of ['getProject','getSession','getConversation']) assert.throws(()=>w[fn]('missing'));
});

test('project tool bindings replace by source and tool, validate projects, and clean up with projects',async t=>{
  const {root,w}=await fixture(t);const a=w.saveProject({name:'A',path:join(root,'a')}),b=w.saveProject({name:'B',path:join(root,'b')});
  assert.deepEqual(w.saveBinding({sourceProjectId:a.id,targetTool:'claude',targetProjectId:b.id}),{sourceProjectId:a.id,targetTool:'claude',targetProjectId:b.id});
  assert.equal(w.snapshot().bindings.length,1);
  assert.throws(()=>w.saveBinding({sourceProjectId:a.id,targetTool:'unknown',targetProjectId:b.id}));
  assert.throws(()=>w.saveBinding({sourceProjectId:'missing',targetTool:'claude',targetProjectId:b.id}));
  w.deleteProject(b.id);assert.deepEqual(w.snapshot().bindings,[]);
});

test('messages are idempotent, conflict checked and bounded by conversation',async t=>{
  const {root,w}=await fixture(t);const p=w.saveProject({name:'A',path:join(root,'a')});
  const s=w.registerSession({projectId:p.id,tool:'cursor',title:'S'});
  const create=()=>w.createConversation({title:'C',projectId:p.id,localSessionId:s.id,connectionId:'local',remoteAgent:'workbuddy'});
  const c=create(), other=create();const input={id:'same',side:'human',agent:'me',text:"quote ' ; DROP TABLE projects;"};
  const m=w.appendMessage(c.id,input);assert.equal(m.offset,0);assert.deepEqual(w.appendMessage(c.id,input),m);
  assert.throws(()=>w.appendMessage(c.id,{...input,text:'changed'}));
  w.appendMessage(other.id,input);
  for(let i=1;i<205;i++)w.appendMessage(c.id,{side:'local',agent:'cursor',text:String(i)});
  const page=w.messages(c.id,{after:1,limit:200});assert.equal(page.total,205);assert.equal(page.messages.length,200);assert.equal(page.nextOffset,201);
  assert.equal(w.messages(c.id,{after:201,limit:100}).messages.length,4);
  assert.equal(w.messages(other.id,{}).total,1);
  for(const options of [{after:-1},{limit:0},{limit:201}]) assert.throws(()=>w.messages(c.id,options));
});

test('settings, session patches and conversation fields reject unsafe input atomically',async t=>{
  const {root,w}=await fixture(t);const before=w.snapshot().settings;
  for(const patch of [{networkPort:0},{networkPort:65536},{closeToTray:'yes'},{autoStartHost:1},{page:{}},{unknown:true},{selectedProjectId:2}]) assert.throws(()=>w.updateSettings(patch));
  assert.deepEqual(w.snapshot().settings,before);
  const p=w.saveProject({name:'A',path:join(root,'a')});const s=w.registerSession({projectId:p.id,tool:'codex',title:'S'});
  assert.equal(w.updateSession(s.id,{nativeSessionId:'abc',shared:true}).nativeSessionId,'abc');
  assert.throws(()=>w.updateSession(s.id,{projectId:'other'}));
  const c=w.createConversation({title:'C',projectId:p.id,localSessionId:s.id,connectionId:'local',remoteAgent:'claude',rounds:5});
  assert.equal(w.updateConversation(c.id,{title:'new',status:'completed',rounds:2}).rounds,2);
  for(const patch of [{rounds:0},{rounds:6},{status:'unknown'},{title:''}])assert.throws(()=>w.updateConversation(c.id,patch));
  const unused=w.saveProject({name:'unused',path:join(root,'b')});w.deleteProject(unused.id);assert.throws(()=>w.getProject(unused.id));
});

test('explicit project ID renames the same canonical path and persists on reopen', async t => {
  const {root,w,open}=await fixture(t);
  const before=w.saveProject({name:'before',path:join(root,'a')});
  const renamed=w.saveProject({id:before.id,name:'after',path:before.path});
  assert.deepEqual(renamed,{...before,name:'after'});
  w.close();
  const reopened=await open();
  assert.deepEqual(reopened.getProject(before.id),renamed);
  assert.equal(reopened.snapshot().projects.length,1);
});

test('consultation threads persist and unfinished workers become interrupted after restart', async t => {
  const {w,open}=await fixture(t);
  const record={id:'consult-one',threadId:'thread-one',sourceSessionId:'source',sourceProjectId:'source-project',targetTool:'claude',targetProjectId:'target-project',targetProjectName:'Target',question:'verify parser',status:'running',round:2,startedAt:new Date().toISOString(),lastProgressAt:new Date().toISOString(),progressEvents:1,outputBytes:12};
  assert.equal(w.saveConsultation(record).id,'consult-one');
  assert.equal(w.listConsultations().length,1);
  w.close();
  const reopened=await open();
  const [stored]=reopened.listConsultations();
  assert.equal(stored.status,'interrupted');assert.match(stored.error,/后台已重启/);assert.equal(stored.round,2);
});

test('attention dismissals persist and reject unsafe keys', async t => {
  const {w,open}=await fixture(t);
  const key='consult:c-1:2026-11-03T10:00:00.000Z';
  assert.deepEqual(w.dismissAttention(key),[key]);
  assert.deepEqual(w.dismissAttention(key),[key]);
  assert.throws(()=>w.dismissAttention('pair:secret'));
  w.close();
  const reopened=await open();
  assert.deepEqual(reopened.snapshot().settings.dismissedAttention,[key]);
});

test('worker records persist and running ones become interrupted after a restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'workspace-workers-'));
  try{
    const first=await openWorkspace(dir);
    first.saveWorker({id:'w1',status:'running',startedAt:new Date().toISOString(),scope:['src'],projectPath:'/p'});
    first.saveWorker({id:'w2',status:'completed',startedAt:new Date().toISOString(),scope:['src'],projectPath:'/p'});
    assert.equal(first.listWorkers().length,2);
    first.close();
    const second=await openWorkspace(dir);
    try{
      const byId=Object.fromEntries(second.listWorkers().map(w=>[w.id,w]));
      assert.equal(byId.w1.status,'orphan');
      assert.equal(byId.w1.stopReason,'exit-unconfirmed');
      assert.match(byId.w1.error,/后台已重启/);
      assert.equal(byId.w2.status,'completed');
    }finally{second.close();}
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('saving many ended workers never evicts a live one',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'workspace-workers-live-'));
  try{
    const ws=await openWorkspace(dir);
    ws.saveWorker({id:'live',status:'running',startedAt:new Date(0).toISOString(),scope:['src'],projectPath:'/p'});
    ws.saveWorker({id:'orphan',status:'orphan',stopReason:'exit-unconfirmed',startedAt:new Date(1).toISOString(),scope:['src'],projectPath:'/p'});
    for(let i=0;i<120;i++)ws.saveWorker({id:'done-'+i,status:'completed',startedAt:new Date(1000+i).toISOString(),scope:['src'],projectPath:'/p'});
    const workers=ws.listWorkers();
    assert.ok(workers.some(w=>w.id==='live'));
    assert.ok(workers.some(w=>w.id==='orphan'));
    assert.ok(workers.length<=122);
    ws.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});
