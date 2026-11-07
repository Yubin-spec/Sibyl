#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {defaultDataDir,resolveAgentExecutable} from '../runtime.mjs';

const {values}=parseArgs({options:{
  dir:{type:'string',default:defaultDataDir()},
  project:{type:'string',default:process.cwd()},
  prompt:{type:'string'},
  effort:{type:'string',default:'high'},
  sandbox:{type:'string',default:'workspace-write'},
  'approval-policy':{type:'string',default:'never'},
  codex:{type:'string'},
  instructions:{type:'string'},
  'one-shot':{type:'boolean',default:false},
  hold:{type:'boolean',default:false},
  'timeout-ms':{type:'string',default:'180000'},
  help:{type:'boolean',default:false},
},strict:true});
if(values.help){console.log([
  'node scripts/spawn-codex-chat.mjs --project <dir> [--prompt "..."] [--one-shot] [--hold]',
  '  --project   working directory for the new Codex thread (default: cwd)',
  '  --prompt    first user turn; omit to create an idle thread',
  '  --one-shot  close the host after the first turn; omit to stay interactive',
  '  --hold      keep the host alive after the prompt even when stdin is not a TTY',
  '  --sandbox   read-only | workspace-write | danger-full-access (default: workspace-write)',
  '  --effort    low | medium | high | ultra (default: high)',
  '  --codex     explicit codex executable path',
  '  --dir       AI Bridge data dir (default: user data dir)',
].join('\n'));process.exit(0);}

const dir=resolve(values.dir),project=resolve(values.project),nativeMcp=fileURLToPath(new URL('../native-mcp.mjs',import.meta.url));
const timeout=Number(values['timeout-ms']);
if(!Number.isInteger(timeout)||timeout<1000||timeout>600000)throw Error('timeout-ms must be 1000..600000');

const runtime=JSON.parse(await readFile(resolve(dir,'native-runtime.json'),'utf8').catch(()=>{throw Error('AI Bridge is not running. Start it first.');}));
const runtimeUrl=new URL(runtime.url);
if(runtimeUrl.protocol!=='http:'||runtimeUrl.hostname!=='127.0.0.1'||!runtimeUrl.port)throw Error('Invalid local bridge runtime');
const preflight=await fetch(new URL('/sessions',runtimeUrl),{method:'POST',headers:{authorization:'Bearer '+runtime.token,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
if(!preflight.ok)throw Error('Local inbox authentication failed');
await preflight.body?.cancel();

const executable=await resolveAgentExecutable('codex',{executables:values.codex?{codex:values.codex}:undefined});
const mcp={'ai-bridge':{
  command:process.execPath,
  args:[nativeMcp,'--dir',dir,'--tool','codex'],
  required:true,
  startup_timeout_sec:15,
  tool_timeout_sec:35,
  default_tools_approval_mode:'approve',
}};
const overrides={mcp_servers:mcp,sandbox_mode:values.sandbox,approval_policy:values['approval-policy'],model_reasoning_effort:values.effort,web_search:'disabled'};
const toml=v=>typeof v==='object'&&!Array.isArray(v)?'{'+Object.entries(v).map(([k,x])=>JSON.stringify(k)+'='+toml(x)).join(',')+'}':Array.isArray(v)?'['+v.map(toml).join(',')+']':JSON.stringify(v);

function decode(value){
  if(typeof value==='string'){try{return decode(JSON.parse(value));}catch{return value;}}
  if(Array.isArray(value)){const text=value.filter(v=>v?.type==='text').map(v=>v.text);return text.length===1?decode(text[0]):text.map(decode);}
  if(value&&typeof value==='object'){
    if(value.structuredContent)return decode(value.structuredContent);
    if(value.content!==undefined)return decode(value.content);
  }
  return value;
}
const toolName=name=>typeof name==='string'?(name.match(/(?:^|__)bridge_[a-z_]+$/)?.[0]||'').replace(/^__/,''):'';

let channel;
const pending=new Map();let serial=0,active=null,threadId=null,closed=false;
function fail(error){const e=error||Error('Codex host exited');for(const p of pending.values())p.reject(e);pending.clear();if(active){active.reject(e);active=null;}}
function onMessage(message){
  if(message.id!==undefined&&!message.method){const p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(Error('Codex request failed ('+String(message.error.code)+')')):p.resolve(message.result);}return;}
  if(message.id!==undefined&&message.method){channel.send({id:message.id,error:{code:-32601,message:'No interactive approvals in this spawned chat'}});return;}
  const params=message.params;
  if(!active||params?.threadId!==threadId)return;
  if(message.method==='item/completed'){
    const item=params.item;
    if(item.type==='mcpToolCall'&&item.server==='ai-bridge')active.calls.push({name:toolName(item.tool),arguments:item.arguments,value:decode(item.result),error:item.error||item.status!=='completed'||item.result?.isError});
    if(item.type==='agentMessage')active.text.push(item.text);
  }
  if(message.method==='turn/completed'){
    const turn=active;active=null;
    params.turn.status==='completed'?turn.resolve({calls:turn.calls,text:turn.text.join('\n')}):turn.reject(Error('Codex turn did not complete: '+params.turn.status));
  }
}
function childChannel(){
  const child=spawn(executable.command,[...executable.args,'app-server',...Object.entries(overrides).flatMap(([k,v])=>['-c',k+'='+toml(v)])],{cwd:project,stdio:['pipe','pipe','pipe'],windowsHide:true});
  const ended=new Promise(resolveEnd=>child.once('close',(code,signal)=>{closed=true;fail(Error('Codex host exited (code '+code+', signal '+signal+')'));resolveEnd();}));
  child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});child.on('error',fail);
  createInterface({input:child.stdout}).on('line',line=>{try{onMessage(JSON.parse(line));}catch{}});
  return {send(value){if(closed)throw Error('Codex host exited');child.stdin.write(JSON.stringify(value)+'\n');},async close(){if(closed)return;child.stdin.end();let timer;await Promise.race([ended,new Promise(r=>{timer=setTimeout(r,5000);})]);clearTimeout(timer);if(!closed){child.kill('SIGTERM');await ended;}}};
}
function request(method,params){return new Promise((resolveRequest,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('Codex protocol timeout'));},timeout);pending.set(id,{resolve:v=>{clearTimeout(timer);resolveRequest(v);},reject:e=>{clearTimeout(timer);reject(e);}});channel.send({id,method,params});});}
async function turn(prompt){
  if(active)throw Error('Overlapping Codex turns');
  let timer;
  const done=new Promise((resolveTurn,reject)=>{active={calls:[],text:[],resolve:resolveTurn,reject};timer=setTimeout(()=>{active=null;reject(Error('Codex turn timeout'));},timeout);});
  try{await request('turn/start',{threadId,input:[{type:'text',text:prompt}],effort:values.effort});return await done;}finally{clearTimeout(timer);}
}
const output=turn=>console.log(JSON.stringify({type:'turn',text:turn.text,tools:turn.calls.map(c=>({name:c.name,succeeded:!c.error}))}));

let exitCode=0;
try{
  channel=childChannel();
  await request('initialize',{clientInfo:{name:'sibyl_spawn_codex_chat',title:'Sibyl spawn Codex chat',version:'0.1.0'}});
  channel.send({method:'initialized',params:{}});
  const result=await request('thread/start',{cwd:project,sandbox:values.sandbox,approvalPolicy:values['approval-policy'],...(values.instructions?{developerInstructions:values.instructions}:{}),config:overrides});
  threadId=result.thread.id;
  console.log(JSON.stringify({type:'thread',threadId,sessionId:result.thread.sessionId||threadId,cwd:project,hostPid:process.pid}));
  if(values.prompt)output(await turn(values.prompt));
  if(values['one-shot']){await channel.close();process.exit(exitCode);}
  if(process.stdin.isTTY){
    const rl=createInterface({input:process.stdin,output:process.stderr});
    process.stderr.write('Codex chat is live. Enter a prompt per line; Ctrl-D/Ctrl-C to exit.\n');
    for await(const line of rl){const prompt=line.trim();if(prompt)output(await turn(prompt));}
    await channel.close();
  }else if(values.hold){
    process.stderr.write('Codex chat is live. Send SIGINT to close.\n');
    await new Promise(r=>{process.once('SIGINT',r);process.once('SIGTERM',r);});
    await channel.close();
  }else{
    await channel.close();
  }
}catch(error){
  exitCode=1;console.error(JSON.stringify({type:'error',error:error?.message||String(error)}));
  await channel?.close().catch(()=>{});
  process.exitCode=exitCode;
}
