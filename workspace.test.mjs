import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const {openWorkspace} = await import('./workspace.mjs');
  const dir = join(root,'data');
  const w = await openWorkspace(dir);
  t.after(() => {try {w.close();} catch {}});
  await mkdir(join(root,'a')); await mkdir(join(root,'b'));
  return {root,dir,w};
}

test('persists defaults, stable identity, private database and interrupted recovery', async t => {
  const {w,dir,root}=await fixture(t); const id=w.snapshot().device.id;
  assert.equal(w.snapshot().settings.networkPort,47831);
  w.setDevice({name:"Bob's device",owner:'Me'});
  w.updateSettings({page:'projects',closeToTray:false,networkPort:50000});
  const p=w.saveProject({name:"quoted ' project",path:join(root,'a')});
  const s=w.registerSession({projectId:p.id,tool:'codex',title:'test'});
  const c=w.createConversation({title:'work',projectId:p.id,localSessionId:s.id,connectionId:'local',remoteAgent:'claude'});
  w.updateConversation(c.id,{status:'running'});w.close();
  const {openWorkspace}=await import('./workspace.mjs'); const reopened=await openWorkspace(dir);t.after(()=>reopened.close());
  assert.equal(reopened.snapshot().device.id,id); assert.equal(reopened.snapshot().device.name,"Bob's device");
  assert.equal(reopened.getConversation(c.id).status,'failed');
  assert.equal(reopened.getProject(p.id).name,"quoted ' project");
  assert.equal((await stat(join(dir,'workspace.sqlite'))).mode & 0o777,0o600);
  assert.equal('messages' in reopened.snapshot(),false);
});

test('canonical projects and session/conversation references stay isolated',async t=>{
  const {root,w}=await fixture(t);const p=w.saveProject({name:'A',path:join(root,'a')});
  await symlink(join(root,'a'),join(root,'alias'));
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
  const {root,dir,w}=await fixture(t);
  const before=w.saveProject({name:'before',path:join(root,'a')});
  const renamed=w.saveProject({id:before.id,name:'after',path:before.path});
  assert.deepEqual(renamed,{...before,name:'after'});
  w.close();
  const {openWorkspace}=await import('./workspace.mjs');
  const reopened=await openWorkspace(dir);t.after(()=>reopened.close());
  assert.deepEqual(reopened.getProject(before.id),renamed);
  assert.equal(reopened.snapshot().projects.length,1);
});
