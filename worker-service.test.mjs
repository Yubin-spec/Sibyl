import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkerService} from './workers.mjs';
import {projectKey} from './project-path.mjs';

const git=(cwd,...args)=>execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com',...args],{cwd,encoding:'utf8'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const fake=`import {spawn} from 'node:child_process';import {writeFileSync,mkdirSync} from 'node:fs';import {join} from 'node:path';import {createInterface} from 'node:readline';
const args=process.argv.slice(2),opt=n=>{const i=args.indexOf('--'+n);return i>=0?args[i+1]:undefined;};
const mode='__MODE__';
if(process.env.FAKE_WORKER_PID)writeFileSync(process.env.FAKE_WORKER_PID,String(process.pid));
if(process.env.FAKE_ARGS_FILE)writeFileSync(process.env.FAKE_ARGS_FILE,JSON.stringify(args));
if(process.env.FAKE_TICK_FILE&&mode==='tree')spawn(process.execPath,['-e',"const fs=require('fs');setInterval(()=>fs.appendFileSync(process.env.FAKE_TICK_FILE,'x'),50)"],{stdio:'ignore',env:process.env});
process.stdout.write(JSON.stringify({type:'thread',threadId:'fake-'+process.pid,sessionId:'fake',cwd:opt('project')})+'\\n');
const report=v=>'done\\n<<<SIBYL_REPORT\\n'+JSON.stringify(v)+'\\nSIBYL_REPORT>>>';
const rl=createInterface({input:process.stdin});
rl.on('line',line=>{const c=JSON.parse(line);
 if(c.op==='close'){if(mode==='tree')return;process.stdout.write(JSON.stringify({id:c.id,type:'closed'})+'\\n');process.exit(0);}
 if(c.op!=='turn')return;
 if(mode==='hang')return;
 if(mode==='fail'){process.stdout.write(JSON.stringify({id:c.id,type:'error',error:'worker exploded'})+'\\n');return;}
 const model=opt('model');
 if(mode==='modelcheck'&&model&&!['gpt-6.1-sol','gpt-6.1-terra','gpt-6-luna','gpt-6-astra'].includes(model)){process.stdout.write(JSON.stringify({id:c.id,type:'error',error:'Unsupported model: '+model})+'\\n');return;}
 if(mode!=='read'){mkdirSync(join(process.cwd(),'src'),{recursive:true});writeFileSync(join(process.cwd(),'src','a.txt'),'worker\\n');}
 if(mode==='evil'){mkdirSync(join(process.cwd(),'docs'),{recursive:true});writeFileSync(join(process.cwd(),'docs','evil.txt'),'x\\n');}
 process.stdout.write(JSON.stringify({id:c.id,type:'turn',text:report({summary:'done',verification:[{command:'none',result:'not-run'}],unfinished:[],blockers:[],changeRequests:[]}),tools:[]})+'\\n');
});
rl.on('close',()=>process.exit(0));`;

async function fixture(mode='write',limits=undefined){
  const root=await mkdtemp(join(tmpdir(),'worker-svc-'));
  const project=join(root,'project'),dataDir=join(root,'data');await mkdir(join(project,'src'),{recursive:true});await mkdir(dataDir);
  git(project,'init','-q');await writeFile(join(project,'.gitignore'),'.sibyl/\n');await writeFile(join(project,'src','a.txt'),'base\n');
  git(project,'add','-A');git(project,'commit','-qm','base');
  const script=join(root,'fake-worker.mjs');await writeFile(script,fake.replace('__MODE__',mode));
  const records=new Map();
  const store={listWorkers:()=>[...records.values()],saveWorker:r=>{records.set(r.id,r);return r;}};
  const service=createWorkerService({dataDir,store,scripts:{codex:script,claude:script},onChange:()=>{},...(limits?{limits}:{})});
  const session={id:'s1',projectPath:project};
  return {root,project,dataDir,script,service,session,store,async cleanup(){service.stop();await service.closeAll();await rm(root,{recursive:true,force:true});}};
}
const wait=async(fn,ms=15000)=>{const end=Date.now()+ms;let last;while(Date.now()<end){last=await fn();if(last)return last;await sleep(50);}throw Error('timed out waiting');};

test('start returns before the first turn and the report is built from git',async()=>{
  const f=await fixture();
  try{
    const head=git(f.project,'rev-parse','HEAD').trim();
    const started=await f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['src'],prompt:'do it'});
    assert.equal(started.status,'starting');
    assert.equal(started.report,undefined);
    assert.ok(started.worktreePath.endsWith(join('.sibyl','worktrees',started.workerId)));
    const done=await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:200});return r.status==='completed'?r:null;});
    assert.match(done.threadId,/^fake-/);
    assert.deepEqual(done.report.files.modified,['src/a.txt']);
    assert.ok(await stat(join(f.project,'.sibyl','reports',started.workerId+'.patch')));
    assert.equal(git(f.project,'rev-parse','HEAD').trim(),head);
    assert.equal((await readFile(join(f.project,'src','a.txt'),'utf8')),'base\n');
  }finally{await f.cleanup();}
});

test('a failed turn still hands back a report',async()=>{
  const f=await fixture('fail');
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src'],prompt:'x'});
    const done=await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:200});return r.status==='failed'?r:null;});
    assert.match(done.error,/worker exploded/);
    assert.equal(done.report.reported,false);
  }finally{await f.cleanup();}
});

test('an explicit close stops a live turn and releases the worker',async()=>{
  const f=await fixture('hang');
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src'],prompt:'x'});
    await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:50});return ['starting','running'].includes(r.status)?r:null;});
    const closed=await f.service.close({session:f.session,workerId:started.workerId});
    assert.equal(closed.status,'stopped');
    assert.equal(f.service.list({session:f.session}).length,1);
  }finally{await f.cleanup();}
});

test('workers from another session are invisible',async()=>{
  const f=await fixture();
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src']});
    await assert.rejects(f.service.result({session:{id:'other'},workerId:started.workerId}),/Unknown worker/);
    await assert.rejects(f.service.close({session:{id:'other'},workerId:started.workerId}),/Unknown worker/);
    assert.equal(f.service.list({session:{id:'other'}}).length,0);
  }finally{await f.cleanup();}
});

test('a non-git project is refused before any worker is recorded',async()=>{
  const root=await mkdtemp(join(tmpdir(),'worker-nogit-'));
  try{
    const store={listWorkers:()=>[],saveWorker:()=>{}};
    const service=createWorkerService({dataDir:root,store,scripts:{codex:'x'}});
    await assert.rejects(service.start({session:{id:'s',projectPath:root},tool:'codex',scope:['src']}),/needs a git repository|needs the repository root/);
    assert.equal(service.list({session:{id:'s'}}).length,0);
    service.stop();
  }finally{await rm(root,{recursive:true,force:true});}
});

test('turn returns immediately and result exposes lastTurn',async()=>{
  const f=await fixture('hang');
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src']});
    await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:50});return r.status==='running'?r:null;});
    const before=Date.now();
    const turn=await f.service.turn({session:f.session,workerId:started.workerId,prompt:'work'});
    assert.ok(Date.now()-before<1000,'turn waited for the turn to finish');
    assert.equal(turn.accepted,true);
    assert.equal(turn.status,'running');
    const state=await f.service.result({session:f.session,workerId:started.workerId,waitMs:50});
    assert.equal(state.lastTurn.status,'running');
    await f.service.close({session:f.session,workerId:started.workerId});
  }finally{await f.cleanup();}
});

test('closing during startup finalizes once and frees the lease',async()=>{
  const f=await fixture('hang');
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src']});
    const closed=await f.service.close({session:f.session,workerId:started.workerId});
    assert.ok(['stopped','completed'].includes(closed.status),closed.status);
    const again=await f.service.start({session:f.session,tool:'codex',scope:['src']});
    assert.ok(again.workerId);
  }finally{await f.cleanup();}
});

test('closing waits for the spawned process to exit',async()=>{
  const f=await fixture('hang');
  const pidFile=join(f.root,'worker.pid');
  process.env.FAKE_WORKER_PID=pidFile;
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src'],prompt:'x'});
    const pid=await wait(async()=>{try{const n=Number(await readFile(pidFile,'utf8'));return n>0?n:null;}catch{return null;}});
    await f.service.close({session:f.session,workerId:started.workerId});
    let dead=false;for(let i=0;i<60;i++){try{process.kill(pid,0);}catch{dead=true;break;}await sleep(50);}
    assert.equal(dead,true,'worker child survived close');
  }finally{delete process.env.FAKE_WORKER_PID;await f.cleanup();}
});

test('closing kills the whole worker process tree',async()=>{
  const f=await fixture('tree');
  const tick=join(f.root,'tick.txt');
  process.env.FAKE_TICK_FILE=tick;
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src'],prompt:'x'});
    await wait(async()=>{try{return (await readFile(tick,'utf8')).length>0;}catch{return null;}});
    await f.service.close({session:f.session,workerId:started.workerId});
    const size=(await readFile(tick,'utf8')).length;
    await sleep(600);
    assert.equal((await readFile(tick,'utf8')).length,size,'grandchild kept writing after close');
  }finally{delete process.env.FAKE_TICK_FILE;await f.cleanup();}
});

test('a completed turn is visible while the worker stays running',async()=>{
  const f=await fixture();
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src']});
    await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:50});return r.status==='running'?r:null;});
    await f.service.turn({session:f.session,workerId:started.workerId,prompt:'work'});
    const state=await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:50});return r.lastTurn?.status==='completed'?r:null;});
    assert.equal(state.status,'running');
  }finally{await f.cleanup();}
});

test('start records the auto-selected model and effort',async()=>{
  const f=await fixture();
  try{
    const cheap=await f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['src'],kind:'mechanical'});
    assert.equal(cheap.model,'gpt-6-luna');
    assert.equal(cheap.effort,'low');
    const review=await f.service.start({session:f.session,tool:'codex',tier:'consult',kind:'review',risk:'high',prompt:'x'});
    assert.equal(review.model,'gpt-6-astra');
    assert.equal(review.effort,'ultra');
  }finally{await f.cleanup();}
});

test('the launcher receives the chosen model and effort',async()=>{
  const f=await fixture();
  const argsFile=join(f.root,'args.json');process.env.FAKE_ARGS_FILE=argsFile;
  try{
    const started=await f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['src'],kind:'mechanical'});
    await wait(async()=>{try{return JSON.parse(await readFile(argsFile,'utf8'));}catch{return null;}});
    const args=JSON.parse(await readFile(argsFile,'utf8'));
    assert.equal(args[args.indexOf('--model')+1],'gpt-6-luna');
    assert.equal(args[args.indexOf('--effort')+1],'low');
    assert.ok(started.workerId);
  }finally{delete process.env.FAKE_ARGS_FILE;await f.cleanup();}
});

test('the review launcher receives Astra and ultra',async()=>{
  const f=await fixture();
  const argsFile=join(f.root,'args.json');process.env.FAKE_ARGS_FILE=argsFile;
  try{
    const started=await f.service.start({session:f.session,tool:'codex',tier:'consult',kind:'review',risk:'high'});
    const args=await wait(async()=>{try{return JSON.parse(await readFile(argsFile,'utf8'));}catch{return null;}});
    assert.equal(args[args.indexOf('--model')+1],'gpt-6-astra');
    assert.equal(args[args.indexOf('--effort')+1],'ultra');
    assert.ok(started.workerId);
  }finally{delete process.env.FAKE_ARGS_FILE;await f.cleanup();}
});

test('explicit effort wins and Claude auto gets no model',async()=>{
  const f=await fixture();
  try{
    const claude=await f.service.start({session:f.session,tool:'claude',tier:'consult',model:'auto'});
    assert.equal(claude.model,null);
    const codex=await f.service.start({session:f.session,tool:'codex',tier:'consult',kind:'review',effort:'low'});
    assert.equal(codex.model,'gpt-6-astra');
    assert.equal(codex.effort,'low');
  }finally{await f.cleanup();}
});

test('an unsupported explicit model fails without falling back',async()=>{
  const f=await fixture('modelcheck');
  try{
    const started=await f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['src'],prompt:'x',model:'not-a-model'});
    const done=await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:200});return r.status==='failed'?r:null;});
    assert.match(done.error,/Unsupported model/);
  }finally{await f.cleanup();}
});

test('consult tier runs read-only without a worktree',async()=>{
  const f=await fixture('read');
  try{
    const started=await f.service.start({session:f.session,tool:'codex',tier:'consult',prompt:'look'});
    const done=await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:200});return r.status==='completed'?r:null;});
    assert.equal(done.worktreePath,null);
    assert.equal(done.report.patchPath,undefined);
    await assert.rejects(stat(join(f.project,'.sibyl')),/ENOENT/);
  }finally{await f.cleanup();}
});

test('dispatch allows only one live worker per session',async()=>{
  const f=await fixture();
  try{
    const first=await f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['src/a']});
    assert.ok(first.workerId);
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['docs']}),/只能有一个工作方/);
  }finally{await f.cleanup();}
});

test('parallel allows disjoint workers up to the session limit',async()=>{
  const f=await fixture();
  try{
    await f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src/a']});
    await f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['docs']});
    await f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src/b']});
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src/c']}),/该会话同时最多 3 个工作方/);
  }finally{await f.cleanup();}
});

test('leadScope reserves paths against every worker',async()=>{
  const f=await fixture();
  try{
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['docs'],leadScope:['docs']}),/路径租约冲突/);
    const first=await f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src/a'],leadScope:['docs','package.json']});
    assert.ok(first.workerId);
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['docs']}),/主导方租约/);
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['package.json']}),/共享文件只能由主导方修改/);
  }finally{await f.cleanup();}
});

test('overlapping scopes are refused and lease checks name the owner',async()=>{
  const f=await fixture();
  try{
    const first=await f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src']});
    const lease=await f.service.checkLease({session:f.session,paths:['src/a.txt','docs/x.md']});
    assert.deepEqual(lease.blocked,[{path:'src/a.txt',workerId:first.workerId}]);
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src/a']}),/路径租约冲突/);
    const docs=await f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['docs']});
    assert.ok(docs.workerId);
  }finally{await f.cleanup();}
});

test('a scope covering a shared file is refused before any worktree exists',async()=>{
  const f=await fixture();
  try{
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['package.json']}),/共享文件只能由主导方修改/);
    await assert.rejects(stat(join(f.project,'.sibyl','worktrees')).then(()=>true),/ENOENT/);
  }finally{await f.cleanup();}
});

test('an out-of-scope edit is flagged in the report',async()=>{
  const f=await fixture('evil');
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src'],prompt:'x'});
    const done=await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:200});return r.status==='completed'?r:null;});
    assert.deepEqual(done.report.scope.outOfScope,['docs/evil.txt']);
    assert.equal(done.report.needsReview,true);
  }finally{await f.cleanup();}
});

test('edits the lead makes inside the lease while a worker runs are reported',async()=>{
  const f=await fixture('hang');
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src']});
    await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:50});return r.status==='running'?r:null;});
    await writeFile(join(f.project,'src','a.txt'),'lead changed\n');
    git(f.project,'branch','lead-side');
    git(f.project,'branch','sibyl/worker/rogue');
    const closed=await f.service.close({session:f.session,workerId:started.workerId});
    assert.deepEqual(closed.report.leadChanges,['src/a.txt']);
    assert.deepEqual(closed.report.refsChanged.sort(),['refs/heads/lead-side','refs/heads/sibyl/worker/rogue']);
  }finally{await f.cleanup();}
});

test('project-level shared overrides are enforced',async()=>{
  const f=await fixture();
  try{
    await mkdir(join(f.project,'.sibyl'),{recursive:true});
    await writeFile(join(f.project,'.sibyl','shared-files.json'),JSON.stringify({add:['config']}));
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['config/x.json']}),/共享文件只能由主导方修改/);
  }finally{await f.cleanup();}
});

test('staged changes inside the worker scope are refused before dispatch',async()=>{
  const f=await fixture();
  try{
    await writeFile(join(f.project,'src','a.txt'),'staged\n');
    git(f.project,'add','src/a.txt');
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['src']}),/已暂存改动/);
  }finally{await f.cleanup();}
});

test('an unconfirmed exit keeps its lease until close confirms the tree is gone',async()=>{
  const f=await fixture();
  try{
    const record={id:'old',sourceSessionId:'s1',status:'orphan',stopReason:'exit-unconfirmed',childPid:process.pid,projectPath:f.project,repositoryKey:projectKey(f.project),scope:['src'],startedAt:new Date().toISOString()};
    const store={listWorkers:()=>[record],saveWorker:()=>{}};
    const service=createWorkerService({dataDir:f.dataDir,store,scripts:{codex:f.script,claude:f.script},isAlive:()=>false,killTree:async()=>true});
    await assert.rejects(service.start({session:{id:'s1',projectPath:f.project},tool:'codex',tier:'parallel',scope:['src']}),/路径租约冲突/);
    const closed=await service.close({session:{id:'s2',projectPath:f.project},workerId:'old'});
    assert.equal(closed.status,'interrupted');
    const allowed=await service.start({session:{id:'s2',projectPath:f.project},tool:'codex',tier:'parallel',scope:['src']});
    assert.ok(allowed.workerId);
    await service.close({session:{id:'s2'},workerId:allowed.workerId});
    service.stop();
  }finally{await f.cleanup();}
});

test('the watchdog uses the tier budget, not the consult numbers',async()=>{
  const limits={dispatch:{maxDurationMs:300,noProgressMs:300,windowMs:60000,maxPerWindow:10,maxLivePerSession:1,maxLivePerProject:2},parallel:{maxDurationMs:300,noProgressMs:300,windowMs:60000,maxPerWindow:10,maxLivePerSession:2,maxLivePerProject:4}};
  const f=await fixture('hang',limits);
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src'],prompt:'hang'});
    const stopped=await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:100});return r.status==='stopped'?r:null;},4000);
    assert.match(stopped.error,/超过最长运行时间|长时间没有收到/);
  }finally{await f.cleanup();}
});

test('a shared lead lease survives until the last worker ends',async()=>{
  const f=await fixture();
  try{
    const a=await f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src/a'],leadScope:['docs']});
    const b=await f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src/b'],leadScope:['docs']});
    await f.service.close({session:f.session,workerId:a.workerId});
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['docs']}),/主导方租约/);
    await f.service.close({session:f.session,workerId:b.workerId});
    const after=await f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['docs']});
    assert.ok(after.workerId);
  }finally{await f.cleanup();}
});

test('leadScope cannot cover a same-session worker scope',async()=>{
  const f=await fixture();
  try{
    await f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src/a']});
    await assert.rejects(f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src/b'],leadScope:['src/a']}),/路径租约冲突/);
  }finally{await f.cleanup();}
});

test('a pre-existing deletion in scope is not reported as a lead change',async()=>{
  const f=await fixture('hang');
  try{
    await writeFile(join(f.project,'src','gone.txt'),'x\n');
    git(f.project,'add','-A');git(f.project,'commit','-qm','gone');
    await rm(join(f.project,'src','gone.txt'));
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src']});
    await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:50});return r.status==='running'?r:null;});
    const closed=await f.service.close({session:f.session,workerId:started.workerId});
    assert.equal(closed.report.leadChanges,undefined);
  }finally{await f.cleanup();}
});

test('a failed handoff commit fails the worker instead of returning an empty patch',async()=>{
  const f=await fixture();
  try{
    const started=await f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['src']});
    await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:50});return r.status==='running'?r:null;});
    const worktree=join(f.project,'.sibyl','worktrees',started.workerId);
    execFileSync('git',['checkout','-q','-b','other'],{cwd:worktree});
    await writeFile(join(worktree,'src','a.txt'),'worker\n');
    const closed=await f.service.close({session:f.session,workerId:started.workerId});
    assert.equal(closed.status,'failed');
    assert.match(closed.error,/提交失败/);
  }finally{await f.cleanup();}
});

test('a manual turn timeout stops the worker',async()=>{
  const f=await fixture('hang');
  try{
    const started=await f.service.start({session:f.session,tool:'codex',scope:['src']});
    await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:50});return r.status==='running'?r:null;});
    await f.service.turn({session:f.session,workerId:started.workerId,prompt:'x',timeoutMs:200});
    const failed=await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:100});return r.status==='failed'?r:null;},4000);
    assert.match(failed.error,/timed out/);
    assert.throws(()=>f.service.turn({session:f.session,workerId:started.workerId,prompt:'again'}),/Worker is not running/);
  }finally{await f.cleanup();}
});

test('a finished sibling branch is not reported as an unexpected ref change',async()=>{
  const f=await fixture();
  try{
    const a=await f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src/a'],prompt:'a'});
    const b=await f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src/b']});
    await wait(async()=>{const r=await f.service.result({session:f.session,workerId:a.workerId,waitMs:200});return r.status==='completed'?r:null;});
    const closed=await f.service.close({session:f.session,workerId:b.workerId});
    assert.equal(closed.report.refsChanged,undefined);
  }finally{await f.cleanup();}
});

test('a consult worker can start without the ai-bridge MCP',async()=>{
  const argsFile=join(tmpdir(),'worker-args-'+Date.now()+'.json');
  process.env.FAKE_ARGS_FILE=argsFile;
  const f=await fixture('read');
  try{
    const started=await f.service.start({session:f.session,tool:'codex',tier:'consult',mcp:'none'});
    const running=await wait(async()=>{const r=await f.service.result({session:f.session,workerId:started.workerId,waitMs:50});return r.status==='running'?r:null;});
    assert.match(running.threadId,/^fake-/);
    const args=JSON.parse(await readFile(argsFile,'utf8'));
    assert.ok(args.includes('--mcp'));
    assert.equal(args[args.indexOf('--mcp')+1],'none');
    assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
    assert.equal(started.worktreePath,null);
    await f.service.close({session:f.session,workerId:started.workerId});
  }finally{delete process.env.FAKE_ARGS_FILE;await f.cleanup();}
});

test('a project policy changes the model the worker actually launches with',async()=>{
  const f=await fixture();
  await mkdir(join(f.project,'.sibyl'),{recursive:true});
  await writeFile(join(f.project,'.sibyl','models.json'),JSON.stringify({version:1,codex:{implement:{normal:{model:'gpt-6-luna',effort:'low'}}}}));
  const argsFile=join(f.root,'args.json');
  process.env.FAKE_ARGS_FILE=argsFile;
  try{
    const started=await f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['src'],kind:'implement'});
    assert.equal(started.model,'gpt-6-luna');
    assert.equal(started.effort,'low');
    assert.equal(started.modelReason,'project:implement');
    const args=await wait(async()=>{try{return JSON.parse(await readFile(argsFile,'utf8'));}catch{return null;}});
    assert.equal(args[args.indexOf('--model')+1],'gpt-6-luna');
  }finally{delete process.env.FAKE_ARGS_FILE;await f.cleanup();}
});

test('an invalid project policy rejects an auto Codex start with the file and field',async()=>{
  const f=await fixture();
  await mkdir(join(f.project,'.sibyl'),{recursive:true});
  await writeFile(join(f.project,'.sibyl','models.json'),JSON.stringify({version:1,codex:{mechanical:{effort:'max'}}}));
  try{
    await assert.rejects(
      ()=>f.service.start({session:f.session,tool:'codex',tier:'dispatch',scope:['src'],kind:'mechanical'}),
      error=>error.message.includes(join(f.project,'.sibyl','models.json'))&&error.message.includes('mechanical.effort'));
  }finally{await f.cleanup();}
});

test('a broken policy does not block an explicit model or Claude auto',async()=>{
  const f=await fixture();
  await mkdir(join(f.project,'.sibyl'),{recursive:true});
  await writeFile(join(f.project,'.sibyl','models.json'),'{not json');
  try{
    const explicit=await f.service.start({session:f.session,tool:'codex',tier:'consult',model:'gpt-6-luna'});
    assert.equal(explicit.model,'gpt-6-luna');
    const claude=await f.service.start({session:f.session,tool:'claude',tier:'consult',model:'auto'});
    assert.equal(claude.model,null);
    assert.equal(claude.modelReason,'claude-default');
  }finally{await f.cleanup();}
});

test('concurrent auto starts cannot both pass the lease check',async()=>{
  const f=await fixture();
  await mkdir(join(f.project,'.sibyl'),{recursive:true});
  await writeFile(join(f.project,'.sibyl','models.json'),JSON.stringify({version:1,codex:{implement:{normal:{model:'gpt-6-luna'}}}}));
  try{
    const results=await Promise.allSettled([
      f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src']}),
      f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src/a.txt']})
    ]);
    const rejected=results.filter(r=>r.status==='rejected');
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(rejected.length,1);
    assert.match(rejected[0].reason.message,/路径租约冲突/);
  }finally{await f.cleanup();}
});

test('concurrent auto starts cannot both pass the per-session capacity check',async()=>{
  const f=await fixture('write',{parallel:{maxLivePerSession:1}});
  await mkdir(join(f.project,'.sibyl'),{recursive:true});
  await writeFile(join(f.project,'.sibyl','models.json'),JSON.stringify({version:1,codex:{implement:{normal:{model:'gpt-6-luna'}}}}));
  try{
    const results=await Promise.allSettled([
      f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['src']}),
      f.service.start({session:f.session,tool:'codex',tier:'parallel',scope:['docs']})
    ]);
    const rejected=results.filter(r=>r.status==='rejected');
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(rejected.length,1);
    assert.match(rejected[0].reason.message,/该会话同时最多 1 个工作方/);
  }finally{await f.cleanup();}
});

test('a worker started with useProjectPolicy false ignores the project policy',async()=>{
  const f=await fixture();
  await mkdir(join(f.project,'.sibyl'),{recursive:true});
  await writeFile(join(f.project,'.sibyl','models.json'),JSON.stringify({version:1,codex:{review:{high:{model:'gpt-6-luna'}}}}));
  try{
    const started=await f.service.start({session:f.session,tool:'codex',tier:'consult',kind:'review',risk:'high',useProjectPolicy:false});
    assert.equal(started.model,'gpt-6-astra');
    assert.equal(started.modelReason,'review-high-risk');
  }finally{await f.cleanup();}
});

test('useProjectPolicy false skips even a broken policy',async()=>{
  const f=await fixture();
  await mkdir(join(f.project,'.sibyl'),{recursive:true});
  await writeFile(join(f.project,'.sibyl','models.json'),'{not json');
  try{
    const started=await f.service.start({session:f.session,tool:'codex',tier:'consult',kind:'review',risk:'high',useProjectPolicy:false});
    assert.equal(started.model,'gpt-6-astra');
  }finally{await f.cleanup();}
});

test('nothing awaits between the lease checks and registering the worker',async()=>{
  const source=await readFile(new URL('./workers.mjs',import.meta.url),'utf8');
  const start=source.indexOf('const repositoryKey = projectKey(projectPath);');
  const end=source.indexOf('records.set(id, record)',start);
  assert.ok(start>0&&end>start);
  assert.doesNotMatch(source.slice(start,end),/\bawait\b/);
});

test('an explicit model and effort win over a valid project policy',async()=>{
  const f=await fixture();
  await mkdir(join(f.project,'.sibyl'),{recursive:true});
  await writeFile(join(f.project,'.sibyl','models.json'),JSON.stringify({version:1,codex:{review:{high:{model:'gpt-6-luna',effort:'low'}}}}));
  const argsFile=join(f.root,'args.json');
  process.env.FAKE_ARGS_FILE=argsFile;
  try{
    const started=await f.service.start({session:f.session,tool:'codex',tier:'consult',kind:'review',risk:'high',model:'gpt-6.1-sol',effort:'high'});
    assert.equal(started.model,'gpt-6.1-sol');
    assert.equal(started.effort,'high');
    assert.equal(started.modelReason,'explicit');
    const args=await wait(async()=>{try{return JSON.parse(await readFile(argsFile,'utf8'));}catch{return null;}});
    assert.equal(args[args.indexOf('--model')+1],'gpt-6.1-sol');
    assert.equal(args[args.indexOf('--effort')+1],'high');
  }finally{delete process.env.FAKE_ARGS_FILE;await f.cleanup();}
});
