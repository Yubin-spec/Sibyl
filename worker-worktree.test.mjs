import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkerWorktree,isGitRepository,commitWorktree,removeWorkerWorktree} from './worker-worktree.mjs';

const git=(cwd,...args)=>execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com',...args],{cwd,encoding:'utf8'});
async function repo(){
  const root=await mkdtemp(join(tmpdir(),'worker-wt-'));
  git(root,'init','-q');await writeFile(join(root,'.gitignore'),'.sibyl/\n.env\nnode_modules/\n');
  await mkdir(join(root,'src'));await writeFile(join(root,'src','a.txt'),'base\n');await writeFile(join(root,'src','b.txt'),'b\n');
  git(root,'add','-A');git(root,'commit','-qm','base');
  return root;
}

test('snapshot carries uncommitted and untracked files without touching the lead branch',async()=>{
  const root=await repo();
  try{
    const head=git(root,'rev-parse','HEAD').trim();
    await writeFile(join(root,'src','a.txt'),'edited\n');
    await writeFile(join(root,'src','new.txt'),'new\n');
    await writeFile(join(root,'.env'),'SECRET=1\n');
    await rm(join(root,'src','b.txt'));
    const before=git(root,'status','--porcelain');

    const wt=await createWorkerWorktree({projectPath:root,workerId:'w1',branchPrefix:'sibyl/worker'});
    assert.equal(wt.branch,'sibyl/worker/w1');
    assert.equal(wt.baseCommit,head);
    assert.equal(await readFile(join(wt.worktreePath,'src','a.txt'),'utf8'),'edited\n');
    assert.equal(await readFile(join(wt.worktreePath,'src','new.txt'),'utf8'),'new\n');
    await assert.rejects(readFile(join(wt.worktreePath,'src','b.txt')),/ENOENT/);
    await assert.rejects(readFile(join(wt.worktreePath,'.env')),/ENOENT/);
    assert.equal(git(wt.worktreePath,'show','HEAD:src/new.txt').trim(),'new');
    assert.equal(git(root,'rev-parse','HEAD').trim(),head);
    assert.equal(git(root,'status','--porcelain'),before);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a clean lead workspace still yields a usable worker branch',async()=>{
  const root=await repo();
  try{
    const wt=await createWorkerWorktree({projectPath:root,workerId:'w2'});
    assert.equal(git(wt.worktreePath,'rev-parse','HEAD').trim(),git(root,'rev-parse','HEAD').trim());
    await writeFile(join(wt.worktreePath,'src','a.txt'),'worker\n');
    assert.match(await commitWorktree(wt.worktreePath,'sibyl: worker handoff',{branch:wt.branch,snapshotCommit:wt.snapshotCommit}),/^[a-f0-9]{40}$/);
    assert.equal(await commitWorktree(wt.worktreePath,'again',{branch:wt.branch,snapshotCommit:wt.snapshotCommit}),null);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('non-git, nested and empty repositories are refused in plain language',async()=>{
  const plain=await mkdtemp(join(tmpdir(),'worker-plain-'));
  const outer=await repo();const nested=join(outer,'src');
  const empty=await mkdtemp(join(tmpdir(),'worker-empty-'));git(empty,'init','-q');
  try{
    assert.equal(await isGitRepository(plain),false);
    await assert.rejects(createWorkerWorktree({projectPath:plain,workerId:'x'}),/needs a git repository|needs the repository root/);
    await assert.rejects(createWorkerWorktree({projectPath:nested,workerId:'x'}),/needs the repository root/);
    await assert.rejects(createWorkerWorktree({projectPath:empty,workerId:'x'}),/no commits yet/);
  }finally{for(const p of [plain,outer,empty])await rm(p,{recursive:true,force:true});}
});

test('a worktree can be removed together with its branch',async()=>{
  const root=await repo();
  try{
    const wt=await createWorkerWorktree({projectPath:root,workerId:'w3'});
    await removeWorkerWorktree({projectPath:root,worktreePath:wt.worktreePath,branch:wt.branch});
    await assert.rejects(stat(wt.worktreePath),/ENOENT/);
    assert.throws(()=>git(root,'rev-parse','--verify','sibyl/worker/w3'),/Command failed/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('ref changes outside the worker branch are reported',async()=>{
  const root=await repo();
  try{
    const {listRefs,refChanges}=await import('./worker-worktree.mjs');
    const before=await listRefs(root);
    git(root,'branch','lead-side');
    const after=await listRefs(root);
    assert.deepEqual(refChanges(before,after),['refs/heads/lead-side']);
    assert.deepEqual(refChanges(before,after,{ignore:['refs/heads/lead-side']}),[]);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('ignored tracked files and staged deletions do not leak into the snapshot',async()=>{
  const root=await repo();
  try{
    await writeFile(join(root,'.env'),'SECRET=1\n');
    git(root,'add','-f','.env');git(root,'commit','-qm','tracked ignored');
    git(root,'rm','-q','src/b.txt');
    const wt=await createWorkerWorktree({projectPath:root,workerId:'w4'});
    await assert.rejects(readFile(join(wt.worktreePath,'.env')),/ENOENT/);
    await assert.rejects(readFile(join(wt.worktreePath,'src','b.txt')),/ENOENT/);
    assert.ok(wt.skipped.ignoredTracked.includes('.env'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('creating .sibyl leaves the lead status clean without a project gitignore',async()=>{
  const root=await mkdtemp(join(tmpdir(),'worker-nogignore-'));
  try{
    git(root,'init','-q');await writeFile(join(root,'a.txt'),'a\n');git(root,'add','-A');git(root,'commit','-qm','base');
    const before=git(root,'status','--porcelain');
    await createWorkerWorktree({projectPath:root,workerId:'w5'});
    assert.equal(git(root,'status','--porcelain'),before);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('submodules are refused before a worktree is created',async()=>{
  const root=await repo();
  try{
    await writeFile(join(root,'.gitmodules'),'[submodule "x"]\n\tpath = x\n\turl = https://example.invalid/x\n');
    git(root,'add','.gitmodules');git(root,'commit','-qm','submodule');
    await assert.rejects(createWorkerWorktree({projectPath:root,workerId:'w6'}),/does not support submodules/);
    await assert.rejects(stat(join(root,'.sibyl','worktrees')),/ENOENT/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('staged paths are listable for lease checks',async()=>{
  const root=await repo();
  try{
    const {stagedPaths}=await import('./worker-worktree.mjs');
    await writeFile(join(root,'src','a.txt'),'staged\n');git(root,'add','src/a.txt');
    assert.deepEqual(await stagedPaths(root),['src/a.txt']);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('snapshot fingerprint detects content changes without status changes',async()=>{
  const root=await repo();
  try{
    const {snapshotFingerprint}=await import('./worker-worktree.mjs');
    await writeFile(join(root,'src','a.txt'),'A\n');
    const first=await snapshotFingerprint(root,['src/a.txt']);
    await writeFile(join(root,'src','a.txt'),'B\n');
    const second=await snapshotFingerprint(root,['src/a.txt']);
    assert.notEqual(first.digest,second.digest);
    assert.equal(git(root,'status','--porcelain').trim(),'M src/a.txt');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a change during copy is retried and the snapshot uses the new content',async()=>{
  const root=await repo();
  try{
    await writeFile(join(root,'src','a.txt'),'A\n');
    let once=false;
    const wt=await createWorkerWorktree({projectPath:root,workerId:'w8',scope:['src'],onBeforeCopy:async()=>{if(!once){once=true;await writeFile(join(root,'src','a.txt'),'B\n');}}});
    assert.equal(await readFile(join(wt.worktreePath,'src','a.txt'),'utf8'),'B\n');
    assert.ok(wt.leadDigest.files['src/a.txt']);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('commitWorktree refuses a worktree on the wrong branch',async()=>{
  const root=await repo();
  try{
    const wt=await createWorkerWorktree({projectPath:root,workerId:'w9'});
    git(wt.worktreePath,'checkout','-q','-b','other');
    await writeFile(join(wt.worktreePath,'src','a.txt'),'x\n');
    await assert.rejects(commitWorktree(wt.worktreePath,'m',{branch:wt.branch,snapshotCommit:wt.snapshotCommit}),/not on the expected branch/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('in-repo symlinks are copied as links, not expanded',async t=>{
  if(process.platform==='win32')return t.skip('creating symlinks needs privileges on Windows');
  const root=await repo();
  try{
    const fs=await import('node:fs/promises');
    await writeFile(join(root,'src','target.txt'),'t\n');await fs.symlink('target.txt',join(root,'src','link.txt'));
    git(root,'add','-A');git(root,'commit','-qm','link');
    const wt=await createWorkerWorktree({projectPath:root,workerId:'w7'});
    assert.equal((await fs.lstat(join(wt.worktreePath,'src','link.txt'))).isSymbolicLink(),true);
  }finally{await rm(root,{recursive:true,force:true});}
});
