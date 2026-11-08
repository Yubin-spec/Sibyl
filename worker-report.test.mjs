import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseWorkerReport,collectWorkerReport,writeWorkerReport} from './worker-report.mjs';
import {buildDispatchPrompt,WORKER_POLICY} from './worker-policy.mjs';

const block=value=>'done\n<<<SIBYL_REPORT\n'+JSON.stringify(value)+'\nSIBYL_REPORT>>>';

test('the report block is parsed and the last block wins',()=>{
  const parsed=parseWorkerReport('x\n'+block({summary:'first',verification:[],unfinished:[],blockers:[],changeRequests:[]})+'\n'+block({summary:'second',verification:[{command:'node --test',result:'pass'}],unfinished:['docs'],blockers:['sandbox'],changeRequests:[{path:'package.json',reason:'dep'}]}));
  assert.equal(parsed.reported,true);
  assert.equal(parsed.summary,'second');
  assert.deepEqual(parsed.verification,[{command:'node --test',result:'pass'}]);
  assert.deepEqual(parsed.unfinished,['docs']);
  assert.deepEqual(parsed.changeRequests,[{path:'package.json',reason:'dep'}]);
});

test('missing or malformed reports degrade instead of throwing',()=>{
  const missing=parseWorkerReport('just prose');
  assert.equal(missing.reported,false);
  assert.match(missing.summary,/just prose/);
  const broken=parseWorkerReport('<<<SIBYL_REPORT\n{no json\nSIBYL_REPORT>>>');
  assert.equal(broken.reported,false);
  assert.equal(broken.summary,'');
});

test('oversized self-reported fields are clipped',()=>{
  const parsed=parseWorkerReport(block({summary:'s'.repeat(5000),verification:[],unfinished:Array.from({length:40},()=> 'u'),blockers:[],changeRequests:[]}));
  assert.equal(parsed.summary.length,2000);
  assert.equal(parsed.unfinished.length,20);
});

test('the dispatch prompt carries scope, shared files and the report block',()=>{
  const prompt=buildDispatchPrompt({task:'add endpoint',scope:['src'],worktreePath:'/w',branch:'sibyl/worker/x',sharedFiles:['package.json']});
  assert.match(prompt,/add endpoint/);
  assert.match(prompt,/src/);
  assert.match(prompt,/package\.json/);
  assert.match(prompt,/SIBYL_REPORT/);
  assert.match(WORKER_POLICY,/SIBYL_REPORT/);
});

const git=(cwd,...args)=>execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com',...args],{cwd,encoding:'utf8'});
async function base(){
  const root=await mkdtemp(join(tmpdir(),'worker-report-'));
  git(root,'init','-q');await mkdir(join(root,'src'));await writeFile(join(root,'src','a.txt'),'a\n');await writeFile(join(root,'keep.txt'),'k\n');
  git(root,'add','-A');git(root,'commit','-qm','base');
  return {root,snapshot:git(root,'rev-parse','HEAD').trim()};
}

test('files and diff come from git, not from the worker say-so',async()=>{
  const {root,snapshot}=await base();
  try{
    await writeFile(join(root,'src','a.txt'),'a2\n');
    await writeFile(join(root,'src','new.txt'),'n\n');
    git(root,'add','-A');git(root,'commit','-qm','work');
    const head=git(root,'rev-parse','HEAD').trim();
    const lie=block({summary:'I changed docs',verification:[{command:'node --test',result:'pass'}],unfinished:[],blockers:[],changeRequests:[]});
    const report=await collectWorkerReport({worktreePath:root,projectPath:root,workerId:'w1',snapshotCommit:snapshot,headCommit:head,text:lie,scope:['src']});
    assert.deepEqual(report.files.modified,['src/a.txt']);
    assert.deepEqual(report.files.added,['src/new.txt']);
    assert.equal(report.stats.insertions,2);
    assert.deepEqual(report.scope.outOfScope,[]);
    assert.equal(report.needsReview,false);
    assert.deepEqual(report.reviewReasons,[]);
    assert.equal(report.deliverable.reason,null);
    const paths=await writeWorkerReport({projectPath:root,workerId:'w1',report,patch:'diff --git a/x b/x\n+secret\n',deliverablePatch:'diff --git a/src/a.txt b/src/a.txt\n+ok\n'});
    assert.match(await readFile(paths.patchPath,'utf8'),/\+secret/);
    assert.match(await readFile(paths.deliverablePatchPath,'utf8'),/\+ok/);
    assert.equal(JSON.parse(await readFile(paths.reportPath,'utf8')).workerId,'w1');
    assert.ok(!JSON.stringify(report).includes('diff --git'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('out-of-scope and shared-file edits block the deliverable patch',async()=>{
  const {root,snapshot}=await base();
  try{
    await mkdir(join(root,'docs'));await writeFile(join(root,'docs','evil.txt'),'x\n');await writeFile(join(root,'package.json'),'{}\n');
    git(root,'add','-A');git(root,'commit','-qm','work');
    const head=git(root,'rev-parse','HEAD').trim();
    const report=await collectWorkerReport({worktreePath:root,projectPath:root,workerId:'w2',snapshotCommit:snapshot,headCommit:head,text:'',scope:['src']});
    assert.deepEqual(report.scope.outOfScope,['docs/evil.txt']);
    assert.deepEqual(report.scope.sharedChanged,['package.json']);
    assert.equal(report.needsReview,true);
    assert.ok(report.reviewReasons.length>=2);
    assert.equal(report.deliverable.path,null);
    assert.match(report.deliverable.reason,/越界|共享/);
    const paths=await writeWorkerReport({projectPath:root,workerId:'w2',report,patch:'full',deliverablePatch:'should-not-be-written'});
    assert.equal(paths.deliverablePatchPath,null);
    await assert.rejects(readFile(join(root,'.sibyl','reports','w2.deliverable.patch')),/ENOENT/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('missing verification makes the report need review but stays deliverable',async()=>{
  const {root,snapshot}=await base();
  try{
    await writeFile(join(root,'src','a.txt'),'a2\n');
    git(root,'add','-A');git(root,'commit','-qm','work');
    const head=git(root,'rev-parse','HEAD').trim();
    const report=await collectWorkerReport({worktreePath:root,projectPath:root,workerId:'w5',snapshotCommit:snapshot,headCommit:head,text:block({summary:'no tests',verification:[],unfinished:[],blockers:[],changeRequests:[]}),scope:['src']});
    assert.equal(report.needsReview,true);
    assert.ok(report.reviewReasons.some(r=>/验证/.test(r)));
    assert.equal(report.deliverable.reason,null,'verification gaps do not block the patch');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a rename into an out-of-scope path is not deliverable',async()=>{
  const {root,snapshot}=await base();
  try{
    await mkdir(join(root,'docs'));
    git(root,'mv','src/a.txt','docs/a.txt');
    git(root,'commit','-qm','move');
    const head=git(root,'rev-parse','HEAD').trim();
    const report=await collectWorkerReport({worktreePath:root,projectPath:root,workerId:'w3',snapshotCommit:snapshot,headCommit:head,text:'',scope:['src']});
    assert.deepEqual(report.files.renamed,[{from:'src/a.txt',to:'docs/a.txt'}]);
    assert.ok(report.scope.outOfScope.includes('docs/a.txt'));
    assert.equal(report.deliverable.path,null);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('symlink changes are unsafe and not deliverable',async t=>{
  if(process.platform==='win32')return t.skip('symlink creation needs privileges on Windows');
  const {root,snapshot}=await base();
  try{
    const fs=await import('node:fs/promises');
    await fs.symlink('/etc/passwd',join(root,'src','link.txt'));
    git(root,'add','-A');git(root,'commit','-qm','link');
    const head=git(root,'rev-parse','HEAD').trim();
    const report=await collectWorkerReport({worktreePath:root,projectPath:root,workerId:'w4',snapshotCommit:snapshot,headCommit:head,text:'',scope:['src']});
    assert.ok(report.unsafeChanges.includes('src/link.txt'));
    assert.equal(report.deliverable.path,null);
  }finally{await rm(root,{recursive:true,force:true});}
});
