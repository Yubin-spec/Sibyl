import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runProcess} from './bridge.mjs';
import {fileURLToPath} from 'node:url';

test('browser launcher starts once, configures Codex and shuts down cleanly',{timeout:20000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sibyl browser 中文 '));
 const codexHome=join(dir,'codex-home');
 const script=fileURLToPath(new URL('./browser.mjs',import.meta.url));
 const run=(extra=[])=>runProcess(process.execPath,[script,'--dir',dir,'--no-open',...extra],{timeout:12000,env:{...process.env,CODEX_HOME:codexHome}});
 let base,token;
 try{
  const first=JSON.parse((await run()).trim());base=first.url;
  const html=await(await fetch(base)).text();token=html.match(/name="bridge-session" content="([a-f0-9]+)"/)[1];
  const second=JSON.parse((await run()).trim());assert.equal(first.pid,second.pid);assert.equal(first.url,second.url);
  const post=async(path,body)=>(await fetch(base+'/api/'+path,{method:'POST',headers:{'content-type':'application/json',origin:base,'x-bridge-ui':token},body:JSON.stringify(body)}));
  const p=await(await post('projects/save',{name:'test',path:dir})).json();
  const response=await post('tools/connect',{agent:'codex',projectId:p.id});
  assert.equal(response.status,200);assert.match((await response.json()).configPath,/config.toml$/);
  assert.match(await readFile(join(codexHome,'config.toml'),'utf8'),/mcp_servers.ai-bridge/);
  const stopped=JSON.parse((await run(['--stop'])).trim());assert.equal(stopped.stopped,true);
  await assert.rejects(readFile(join(dir,'browser-runtime.json')),{code:'ENOENT'});
 }finally{
  if(base&&token)await fetch(base+'/api/shutdown',{method:'POST',headers:{origin:base,'x-bridge-ui':token,'content-type':'application/json'},body:'{}'}).catch(()=>{});
  await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
});
