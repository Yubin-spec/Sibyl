import {execFileSync,spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createControl} from './control.mjs';

export const git=(cwd,...args)=>execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.com',...args],{cwd,encoding:'utf8'});
const fake=`import {writeFileSync,mkdirSync} from 'node:fs';import {join} from 'node:path';import {createInterface} from 'node:readline';
const mode='__MODE__';
process.stdout.write(JSON.stringify({type:'thread',threadId:'fake-'+process.pid,sessionId:'fake'})+'\\n');
const rl=createInterface({input:process.stdin});
rl.on('line',l=>{const c=JSON.parse(l);
 if(c.op==='close'){if(mode==='tree')return;process.stdout.write(JSON.stringify({id:c.id,type:'closed'})+'\\n');process.exit(0);}
 if(c.op!=='turn')return;
 if(mode==='hang')return;
 if(mode!=='read'){mkdirSync(join(process.cwd(),'src'),{recursive:true});writeFileSync(join(process.cwd(),'src','a.txt'),'worker\\n');}
 process.stdout.write(JSON.stringify({id:c.id,type:'turn',text:'done\\n<<<SIBYL_REPORT\\n{"summary":"done","verification":[],"unfinished":[],"blockers":[],"changeRequests":[]}\\nSIBYL_REPORT>>>',tools:[]})+'\\n');
});
rl.on('close',()=>process.exit(0));`;

export const wait=async(fn,ms=8000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,50));}throw Error('timed out');};

export async function workerFixture(mode='write',extras={}){
  const root=await mkdtemp(join(tmpdir(),'worker-daemon-'));
  const project=join(root,'project'),dir=join(root,'data'),script=join(root,'fake.mjs');
  await mkdir(join(project,'src'),{recursive:true});await writeFile(script,fake.replace('__MODE__',mode));
  git(project,'init','-q');await writeFile(join(project,'.gitignore'),'.sibyl/\n');await writeFile(join(project,'src','a.txt'),'base\n');
  git(project,'add','-A');git(project,'commit','-qm','base');
  const control=await createControl({dir,detect:async()=>({claude:'test',codex:'test'}),workerScripts:{codex:script,claude:script},runner:async()=>({session_id:'c',result:'consult ok'}),...extras});
  await new Promise(r=>control.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${control.server.address().port}`;
  const call=async(path,body)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{origin:base,'x-bridge-ui':control.csrf,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const v=await r.json();assert.equal(r.status,200,JSON.stringify(v));return v;};
  return {root,project,dir,control,call,close:async()=>{await control.close();await rm(root,{recursive:true,force:true});}};
}

export async function registerNative(f){
  const runtime=JSON.parse(await readFile(join(f.dir,'native-runtime.json'),'utf8'));
  const post=async(path,body)=>{const r=await fetch(new URL(path,runtime.url),{method:'POST',headers:{authorization:'Bearer '+runtime.token,'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();assert.ok(r.ok,JSON.stringify(v)+' (status '+r.status+')');return v;};
  const registered=await post('/register',{tool:'claude',title:'t',projectPath:f.project});
  const identity={id:registered.id,lease:registered.lease};
  return {runtime,post,call:async(path,body)=>post(path,{...identity,...body})};
}

export function mcpClient(dir,tool,cwd){
 const entry=fileURLToPath(new URL('./native-mcp.mjs',import.meta.url));
 const child=spawn(process.execPath,[entry,'--dir',dir,'--tool',tool],{cwd,stdio:['pipe','pipe','pipe'],windowsHide:true});
 const pending=new Map();let serial=0,stderr='',gone=false;
 const exited=new Promise(resolve=>child.once('close',()=>{gone=true;resolve();}));
 child.stderr.on('data',b=>stderr+=b);
 createInterface({input:child.stdout}).on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}const p=pending.get(value.id);if(!p)return;pending.delete(value.id);value.error?p.reject(Error(value.error.message)):p.resolve(value.result);});
 child.once('close',()=>{for(const p of pending.values())p.reject(Error('MCP exited: '+stderr));pending.clear();});
 return {child,exited,
  call(method,params={}){const id=++serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('MCP call timeout'));},15000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});},
  async tool(name,args={}){const value=await this.call('tools/call',{name,arguments:args});if(value.isError)throw Error(value.content[0].text);return JSON.parse(value.content[0].text);},
  async close(){if(gone)return;child.stdin.end();await exited;}};
}
