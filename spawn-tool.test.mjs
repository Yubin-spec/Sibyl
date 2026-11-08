import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {openNativeInbox} from './native-inbox.mjs';

const entry=fileURLToPath(new URL('./native-mcp.mjs',import.meta.url));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const fake=`import {writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const args=process.argv.slice(2),opt=name=>{const i=args.indexOf('--'+name);return i>=0?args[i+1]:undefined;};
const sandbox=opt('sandbox'),effort=opt('effort'),project=opt('project');
if(process.env.FAKE_SPAWN_PID_FILE)writeFileSync(process.env.FAKE_SPAWN_PID_FILE,String(process.pid));
let turns=0;
process.stdout.write(JSON.stringify({type:'thread',threadId:'fake-'+process.pid,sessionId:'fake-session',cwd:project,sandbox,effort})+'\\n');
const rl=createInterface({input:process.stdin});
rl.on('line',line=>{let command;try{command=JSON.parse(line);}catch{return;}
 if(command.op==='close'){process.stdout.write(JSON.stringify({id:command.id,type:'closed'})+'\\n');process.exit(0);}
 if(command.op==='turn'){turns++;process.stdout.write(JSON.stringify({id:command.id,type:'turn',text:'echo:'+command.prompt+'|turn:'+turns+'|sandbox:'+sandbox+'|effort:'+effort,tools:[]})+'\\n');}
});
rl.on('close',()=>process.exit(0));
`;

function client(dir,tool,cwd,extra=[],env=process.env){
 const child=spawn(process.execPath,[entry,'--dir',dir,'--tool',tool,...extra],{cwd,stdio:['pipe','pipe','pipe'],windowsHide:true,env});
 const pending=new Map();let serial=0,stderr='',gone=false;
 const exited=new Promise(resolve=>child.once('close',()=>{gone=true;resolve();}));
 child.stderr.on('data',b=>stderr+=b);
 createInterface({input:child.stdout}).on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}const p=pending.get(value.id);if(!p)return;pending.delete(value.id);value.error?p.reject(Error(value.error.message)):p.resolve(value.result);});
 child.once('close',()=>{for(const p of pending.values())p.reject(Error('MCP exited: '+stderr));pending.clear();});
 return {
  child,exited,
  call(method,params={}){const id=++serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('MCP call timeout'));},15000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});},
  async tool(name,args={}){const value=await this.call('tools/call',{name,arguments:args});if(value.isError)throw Error(value.content[0].text);return JSON.parse(value.content[0].text);},
  async close(){if(gone)return;child.stdin.end();await exited;},
  async kill(){if(gone)return;child.kill('SIGKILL');await exited;}
 };
}

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'bridge-spawn-'));
 const dir=join(root,'data'),project=join(root,'project'),fakePath=join(root,'fake-spawn.mjs');
 await mkdir(project);await writeFile(fakePath,fake);
 const inbox=await openNativeInbox({dir});
 return {root,dir,project,fakePath,inbox,cleanup:async()=>{await inbox.close();await rm(root,{recursive:true,force:true});}};
}

test('bridge_spawn runs one turn and closes by default',async()=>{
 const {dir,project,fakePath,inbox,cleanup}=await fixture();
 const c=client(dir,'claude',project,['--spawn-script',fakePath]);
 try{
  const result=await c.tool('bridge_spawn',{prompt:'hello'});
  assert.equal(result.status,'completed');
  assert.equal(result.closed,true);
  assert.equal(result.sandbox,'read-only');
  assert.equal(result.cwd,project);
  assert.match(result.text,/echo:hello\|turn:1\|sandbox:read-only\|effort:high/);
  assert.deepEqual(result.tools,[]);
 }finally{await c.close();await cleanup();}
});

test('bridge_spawn keepAlive supports follow-up turns and an explicit close',async()=>{
 const {dir,project,fakePath,inbox,cleanup}=await fixture();
 const c=client(dir,'claude',project,['--spawn-script',fakePath]);
 try{
  const started=await c.tool('bridge_spawn',{prompt:'first',keepAlive:true});
  assert.equal(started.status,'running');
  assert.match(started.text,/turn:1/);
  const second=await c.tool('bridge_spawn_turn',{spawnId:started.spawnId,prompt:'second'});
  assert.match(second.text,/echo:second\|turn:2/);
  const closed=await c.tool('bridge_spawn_close',{spawnId:started.spawnId});
  assert.equal(closed.status,'closed');
  await assert.rejects(c.tool('bridge_spawn_turn',{spawnId:started.spawnId,prompt:'after close'}),/Unknown or closed spawnId/);
  await assert.rejects(c.tool('bridge_spawn_close',{spawnId:started.spawnId}),/Unknown or closed spawnId/);
 }finally{await c.close();await cleanup();}
});

test('bridge_spawn rejects unsafe or incomplete arguments',async()=>{
 const {dir,project,fakePath,inbox,cleanup}=await fixture();
 const c=client(dir,'claude',project,['--spawn-script',fakePath]);
 try{
  await assert.rejects(c.tool('bridge_spawn',{prompt:'x',sandbox:'danger-full-access'}),/sandbox must be read-only or workspace-write/);
  await assert.rejects(c.tool('bridge_spawn',{prompt:'x',effort:'max'}),/effort must be/);
  await assert.rejects(c.tool('bridge_spawn',{}),/prompt is required unless keepAlive is true/);
  await assert.rejects(c.tool('bridge_spawn',{prompt:'x',keepAlive:'yes'}),/keepAlive must be a boolean/);
  await assert.rejects(c.tool('bridge_spawn',{prompt:'x',timeoutMs:5}),/timeoutMs must be 1000\.\.600000/);
  await assert.rejects(c.tool('bridge_spawn_turn',{spawnId:'missing',prompt:'x'}),/Unknown or closed spawnId/);
  await assert.rejects(c.tool('bridge_spawn_close',{spawnId:'missing'}),/Unknown or closed spawnId/);
  const allowed=await c.tool('bridge_spawn',{prompt:'write ok',sandbox:'workspace-write'});
  assert.equal(allowed.sandbox,'workspace-write');
  assert.match(allowed.text,/sandbox:workspace-write/);
 }finally{await c.close();await cleanup();}
});

test('closing the MCP process closes live spawned chats',async()=>{
 const {root,dir,project,fakePath,inbox,cleanup}=await fixture();
 const pidFile=join(root,'spawn.pid');
 const c=client(dir,'claude',project,['--spawn-script',fakePath],{...process.env,FAKE_SPAWN_PID_FILE:pidFile});
 try{
  const started=await c.tool('bridge_spawn',{keepAlive:true});
  assert.equal(started.status,'running');
  const pid=Number(await readFile(pidFile,'utf8'));
  assert.ok(pid>0);
  assert.doesNotThrow(()=>process.kill(pid,0));
  await c.close();
  let dead=false;for(let i=0;i<60;i++){await sleep(100);try{process.kill(pid,0);}catch{dead=true;break;}}
  assert.equal(dead,true,'spawned child survived the MCP process');
 }finally{await c.close();await cleanup();}
});

test('bridge_spawn routes to the Claude worker when tool is claude',async()=>{
 const {dir,project,fakePath,inbox,cleanup}=await fixture();
 const c=client(dir,'claude',project,['--claude-spawn-script',fakePath]);
 try{
  const result=await c.tool('bridge_spawn',{tool:'claude',prompt:'hello',sandbox:'workspace-write'});
  assert.equal(result.tool,'claude');
  assert.equal(result.sandbox,'workspace-write');
  assert.match(result.text,/echo:hello/);
 }finally{await c.close();await cleanup();}
});

test('bridge_spawn rejects an unknown tool before starting anything',async()=>{
 const {dir,project,fakePath,inbox,cleanup}=await fixture();
 const c=client(dir,'claude',project,['--claude-spawn-script',fakePath]);
 try{
  await assert.rejects(c.tool('bridge_spawn',{tool:'cursor',prompt:'x'}),/tool must be codex or claude/);
 }finally{await c.close();await cleanup();}
});
