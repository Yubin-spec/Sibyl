import test from 'node:test';
import assert from 'node:assert/strict';
import {stat,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {workerFixture,mcpClient,wait,git} from './worker-test-support.mjs';
test('问一下 uses a read-only visible worker and creates no worktree',async()=>{
  const f=await workerFixture('read');const c=mcpClient(f.dir,'claude',f.project);
  try{
    const started=await c.tool('bridge_worker_start',{tool:'codex',tier:'consult',prompt:'look at src'});
    const done=await wait(async()=>{const r=await c.tool('bridge_worker_result',{workerId:started.workerId,waitMs:500});return r.status==='completed'?r:null;});
    assert.equal(done.worktreePath,null);
    assert.equal(done.report.patchPath,undefined);
    await assert.rejects(stat(join(f.project,'.sibyl')),/ENOENT/);
  }finally{await c.close();await f.close();}
});

test('派个活 runs one live worker and refuses a second',async()=>{
  const f=await workerFixture('hang');const c=mcpClient(f.dir,'claude',f.project);
  try{
    const one=await c.tool('bridge_worker_start',{tool:'codex',tier:'dispatch',scope:['src'],prompt:'go'});
    await wait(async()=>{const r=await c.tool('bridge_worker_result',{workerId:one.workerId,waitMs:100});return r.status==='running'?r:null;});
    await assert.rejects(c.tool('bridge_worker_start',{tool:'codex',tier:'dispatch',scope:['docs'],prompt:'again'}),/只能有一个工作方/);
    const closed=await c.tool('bridge_worker_close',{workerId:one.workerId});
    assert.equal(closed.status,'stopped');
  }finally{await c.close();await f.close();}
});

test('a deliverable patch applies over dirty files, including the worker file',async()=>{
  const f=await workerFixture();const c=mcpClient(f.dir,'claude',f.project);
  try{
    await mkdir(join(f.project,'docs'),{recursive:true});
    await writeFile(join(f.project,'docs','lead.txt'),'clean\n');
    git(f.project,'add','-A');git(f.project,'commit','-qm','docs');
    await writeFile(join(f.project,'docs','lead.txt'),'lead dirty\n');
    await writeFile(join(f.project,'src','a.txt'),'lead dirty\n');
    const started=await c.tool('bridge_worker_start',{tool:'codex',tier:'dispatch',scope:['src'],prompt:'go'});
    const done=await wait(async()=>{const r=await c.tool('bridge_worker_result',{workerId:started.workerId,waitMs:1000});return r.status==='completed'?r:null;});
    assert.ok(done.report.deliverable.path);
    git(f.project,'apply',done.report.deliverable.path);
    assert.equal((await readFile(join(f.project,'src','a.txt'),'utf8')).replace(/\r\n/g,'\n'),'worker\n');
    assert.equal((await readFile(join(f.project,'docs','lead.txt'),'utf8')).replace(/\r\n/g,'\n'),'lead dirty\n');
  }finally{await c.close();await f.close();}
});

test('分头干 keeps two disjoint workers alive and rejects overlap',async()=>{
  const f=await workerFixture();const c=mcpClient(f.dir,'claude',f.project);
  try{
    const a=await c.tool('bridge_worker_start',{tool:'codex',tier:'parallel',scope:['src']});
    const b=await c.tool('bridge_worker_start',{tool:'codex',tier:'parallel',scope:['docs']});
    const list=await c.tool('bridge_worker_list',{});
    assert.deepEqual(list.workers.map(w=>w.workerId).sort(),[a.workerId,b.workerId].sort());
    await assert.rejects(c.tool('bridge_worker_start',{tool:'codex',tier:'parallel',scope:['src/x']}),/路径租约冲突/);
    await c.tool('bridge_worker_close',{workerId:a.workerId});
    await c.tool('bridge_worker_close',{workerId:b.workerId});
  }finally{await c.close();await f.close();}
});

test('the symmetric Claude worker hands off through the daemon',async()=>{
  const f=await workerFixture();const c=mcpClient(f.dir,'claude',f.project);
  try{
    const started=await c.tool('bridge_worker_start',{tool:'claude',tier:'dispatch',scope:['src'],prompt:'go'});
    const done=await wait(async()=>{const r=await c.tool('bridge_worker_result',{workerId:started.workerId,waitMs:1000});return r.status==='completed'?r:null;});
    assert.deepEqual(done.report.files.modified,['src/a.txt']);
  }finally{await c.close();await f.close();}
});
