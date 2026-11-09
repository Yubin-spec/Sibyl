import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {
  hookDirFromSettings,resolveDataDir,parseCsrf,summarizeStatus,compactStatus,
  setHooksEnabled,readHooksEnabled,readStatus
} from './scripts/sibyl.mjs';

const REPO_ROOT=resolve(dirname(fileURLToPath(import.meta.url)));

test('data directory follows explicit, environment, installed hook and checkout defaults',async()=>{
  const root=await mkdtemp(join(tmpdir(),'sibyl-cli-dir-'));
  try{
    const repo=join(root,'checkout');
    await mkdir(join(repo,'.claude'),{recursive:true});
    await mkdir(join(root,'data'),{recursive:true});
    assert.equal(resolveDataDir({dir:join(root,'explicit'),repoRoot:repo}),resolve(join(root,'explicit')));
    assert.equal(resolveDataDir({env:{SIBYL_DATA_DIR:join(root,'env')},repoRoot:repo}),resolve(join(root,'env')));

    const hooked=join(root,'hooked data');
    await writeFile(join(repo,'.claude','settings.local.json'),JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:`"/node" "/app/sibyl-hook.mjs" --dir "${hooked}" --event stop`}]}]}}));
    assert.equal(hookDirFromSettings(join(repo,'.claude','settings.local.json')),hooked);
    assert.equal(resolveDataDir({env:{},repoRoot:repo}),resolve(hooked));

    await writeFile(join(repo,'.claude','settings.local.json'),JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:`"/node" "sibyl-hook.mjs" --dir "${join(root,'one')}" --event stop`},{type:'command',command:`"/node" "sibyl-hook.mjs" --dir "${join(root,'two')}" --event stop`}]}]}}));
    assert.equal(hookDirFromSettings(join(repo,'.claude','settings.local.json')),null);
    assert.equal(resolveDataDir({env:{},repoRoot:repo}),resolve(join(root,'data')));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('hooks off writes one directory and fails instead of falling through',async()=>{
  const root=await mkdtemp(join(tmpdir(),'sibyl-cli-hooks-'));
  try{
    const selected=join(root,'selected');
    const file=await setHooksEnabled({dir:selected,enabled:false});
    assert.equal(file,join(selected,'hook-context.json'));
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{enabled:false});
    assert.equal(await readHooksEnabled(selected),false);
    await setHooksEnabled({dir:selected,enabled:true});
    assert.equal(await readHooksEnabled(selected),true);

    const blocked=join(root,'blocked');
    await writeFile(blocked,'not a directory');
    const fallback=join(root,'fallback');
    await mkdir(fallback,{recursive:true});
    await assert.rejects(setHooksEnabled({dir:blocked,enabled:false}));
    await assert.rejects(stat(join(fallback,'hook-context.json')));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('status parsing uses the full pending count and reads csrf from the page',async()=>{
  assert.equal(parseCsrf('<meta name="bridge-session" content="token-1">'),'token-1');
  assert.equal(parseCsrf('<html></html>'),null);
  const summary=summarizeStatus({
    workers:[{status:'running'},{status:'completed'}],
    planReviews:[{status:'changes-required'},{status:'approved'}],
    attention:[{kind:'pair'}],
    nativeInbox:{pendingCount:1,questions:Array.from({length:100},()=>({status:'answered'}))},
    nativeSessions:[{status:'available'}]
  });
  assert.match(summary,/待答问题：1 条/);
  assert.match(summary,/待你处理：1 项/);
  assert.deepEqual(compactStatus({workers:[{status:'running'}],nativeInbox:{pendingCount:3}}).pendingCount,3);

  const server=http.createServer((req,res)=>{
    if(req.url==='/'){res.writeHead(200,{'content-type':'text/html'});res.end('<meta name="bridge-session" content="abc">');return;}
    if(req.url==='/api/status'&&req.headers['x-bridge-ui']==='abc'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({nativeInbox:{pendingCount:2},workers:[],planReviews:[],attention:[],nativeSessions:[]}));return;}
    res.writeHead(403);res.end('{}');
  });
  await new Promise(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));
  try{
    const status=await readStatus(new URL('http://127.0.0.1:'+server.address().port));
    assert.equal(status.nativeInbox.pendingCount,2);
  }finally{await new Promise(resolveClose=>server.close(resolveClose));}
});

test('the launcher derives its data directory from the checkout instead of a hardcoded path',async()=>{
  const script=await readFile(join(REPO_ROOT,'start-browser.ps1'),'utf8');
  assert.doesNotMatch(script,/D:\\LXY_workspace\\AI Bridge\\data/);
  assert.match(script,/Split-Path -Parent \$PSScriptRoot/);
  assert.equal(resolve(REPO_ROOT,'..','data'),resolve(join(dirname(REPO_ROOT),'data')));
});
