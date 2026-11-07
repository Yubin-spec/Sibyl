#!/usr/bin/env node
// A transport for the model already executing in an original conversation.
// This launches only native-mcp.mjs. It never starts, resumes or calls a model.
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdir,open,readFile,rename,rm,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {parseArgs} from 'node:util';
import {defaultDataDir} from '../runtime.mjs';

// A native ask may spend 30s submitting, 25s polling and 30s on its last read.
// Let native-mcp return its recoverable question ID before the wrapper times out.
const MAX_BODY=32768,MAX_IDLE=30*60*1000,RPC_TIMEOUT=95000,HTTP_TIMEOUT=100000;
const actions={open:['title','projectId'],peers:[],sessions:['connectionId'],receive:['waitMs'],ask:['connectionId','targetSessionId','text','waitMs'],result:['questionId','waitMs'],reply:['questionId','peerId','text'],status:[],close:[]};
const names={peers:'bridge_list_peers',sessions:'bridge_list_sessions',receive:'bridge_receive',ask:'bridge_ask',result:'bridge_result',reply:'bridge_reply',close:'bridge_close_session'};
const own=(o,k)=>Object.hasOwn(o,k);
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
const json=value=>process.stdout.write(JSON.stringify(value)+'\n');
function validate(action,args){
 if(!own(actions,action))throw Error('Unknown action');
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!actions[action].includes(k)))throw Error('Invalid action arguments');
}
async function limited(input){let size=0,parts=[];for await(const part of input){size+=part.length;if(size>MAX_BODY){const e=Error('Request too large');e.status=413;throw e;}parts.push(part);}return Buffer.concat(parts).toString('utf8');}
async function argsInput(path){
 if(path){if((await stat(path)).size>MAX_BODY)throw Error('Arguments file too large');return JSON.parse(await readFile(path,'utf8'));}
 if(process.stdin.isTTY)return {};
 const raw=await limited(process.stdin);return raw.trim()?JSON.parse(raw):{};
}
async function getRecord(path){
 // The exclusive initial create reserves ownership before its first write finishes.
 // Give that brief publication window time to finish; never delete an unreadable owner.
 for(let attempt=0;attempt<10;attempt++){
  try{return JSON.parse(await readFile(path,'utf8'));}
  catch(e){if(e.code==='ENOENT')return null;if(e instanceof SyntaxError&&attempt<9){await pause(25);continue;}throw Error('Worker record is unreadable; do not remove it while its worker may be alive');}
 }
}
function checkRecord(r,o){
 if(!r||r.version!==1||r.tool!==o.tool||r.nativeSessionId!==o.session||r.dir!==o.dir||!Number.isInteger(r.pid)||r.pid<1||typeof r.capability!=='string'||!/^[a-f0-9]{64}$/.test(r.capability)||r.port!==null&&(!Number.isInteger(r.port)||r.port<1||r.port>65535))throw Error('Worker record identity mismatch');
}
async function request(r,path,body,timeout=HTTP_TIMEOUT){
 const response=await fetch('http://127.0.0.1:'+r.port+path,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+r.capability,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
 const result=await response.json();if(!response.ok)throw Error(result.error||'Worker request failed');return result;
}
async function healthy(r,o){
 checkRecord(r,o);if(!r.port)throw Error('Worker is starting');
 const h=await request(r,'/health',{},1500);
 if(h.nativeSessionId!==o.session||h.tool!==o.tool||h.workerPid!==r.pid||h.instanceId!==r.instanceId||h.ready!==true)throw Error('Worker health identity mismatch');
 return h;
}
async function ensureWorker(o,path){
 await mkdir(join(o.dir,'live-session-mcp'),{recursive:true,mode:0o700});
 let record=await getRecord(path);
 if(record){
  checkRecord(record,o);
  if(alive(record.pid)){
   const deadline=Date.now()+10000;
   while(Date.now()<deadline){try{await healthy(record,o);return record;}catch{}await pause(100);record=await getRecord(path);if(!record)break;checkRecord(record,o);if(!alive(record.pid))break;}
   if(record&&alive(record.pid))throw Error('Existing worker is alive but unavailable; refusing to replace its conversation');
  }
  // Serialize dead-worker reclamation and recheck its identity under the lock.
  const lock=path+'.reclaim';try{await mkdir(lock,{mode:0o700});}catch{throw Error('Worker recovery in progress; retry open');}
  try{const current=await getRecord(path);if(current){checkRecord(current,o);if(alive(current.pid))throw Error('Worker appeared during recovery; retry open');await rm(path);}}finally{await rm(lock,{recursive:true,force:true});}
 }
 const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--worker','--dir',o.dir,'--tool',o.tool,'--session',o.session,'--idle-ttl-ms',String(o.idleTtlMs)],{detached:true,stdio:'ignore',windowsHide:true});
 let spawnError;child.on('error',e=>{spawnError=e;});child.unref();
 const deadline=Date.now()+12000;
 while(Date.now()<deadline){if(spawnError)throw spawnError;record=await getRecord(path);if(record){checkRecord(record,o);try{await healthy(record,o);return record;}catch{if(!alive(record.pid))throw Error('MCP worker stopped during startup; confirm AI Bridge is running');}}await pause(80);}
 throw Error('MCP worker startup timed out; confirm AI Bridge is running');
}
function mcpClient(o){
 const child=spawn(process.execPath,[fileURLToPath(new URL('../native-mcp.mjs',import.meta.url)),'--dir',o.dir,'--tool',o.tool],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 const pending=new Map();let serial=0,closed=false,childGone=false;
 child.stderr.resume();child.stdin.on('error',()=>{});
 const fail=()=>{
  if(!closed){closed=true;for(const p of pending.values())p.reject(Error('Native MCP connection closed'));pending.clear();}
  if(!childGone){child.stdin.end();const timer=setTimeout(()=>{if(!childGone)child.kill();},2000);timer.unref();}
 };
 child.on('error',fail);child.on('close',()=>{childGone=true;fail();});
 // The fixed local native server can legitimately return many queued messages.
 // Request limits must not turn a valid large MCP result into a broken transport.
 createInterface({input:child.stdout}).on('line',line=>{let m;try{m=JSON.parse(line);}catch{return fail();}const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);});
 return {
  child,get closed(){return closed;},
  call(method,params={}){
   if(closed)return Promise.reject(Error('Native MCP connection closed'));
   const id=++serial;
   return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('Native MCP request timed out; delivery may be uncertain. Do not resubmit an ask automatically.'));},RPC_TIMEOUT);
    pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
   });
  },
  async close(){
   if(childGone)return;
   child.stdin.end();
   await new Promise(resolve=>{const timer=setTimeout(()=>{if(!childGone)child.kill();resolve();},2000);child.once('close',()=>{clearTimeout(timer);resolve();});});
  }
 };
}
async function worker(o,path){
 const capability=randomBytes(32).toString('hex'),instanceId=randomBytes(16).toString('hex');
 const record={version:1,tool:o.tool,nativeSessionId:o.session,dir:o.dir,pid:process.pid,port:null,capability,instanceId};
 const handle=await open(path,'wx',0o600);await handle.writeFile(JSON.stringify(record));await handle.close();
 let mcp,server,opened,sessionId,stopping=false,lastCommandAt=Date.now(),active=0,idle;
 const cleanupRecord=async()=>{const current=await getRecord(path).catch(()=>null);if(current?.capability===capability)await rm(path,{force:true});};
 const stop=async()=>{if(stopping)return;stopping=true;clearInterval(idle);if(sessionId&&mcp&&!mcp.closed)await mcp.call('tools/call',{name:'bridge_close_session',arguments:{sessionId}}).catch(()=>{});await mcp?.close();await cleanupRecord();if(server)server.close();};
 process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
 try{
  mcp=mcpClient(o);
  const init=await mcp.call('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'original-session-adapter',version:'1'}});
  if(init.serverInfo?.name!=='ai-bridge')throw Error('Unexpected native MCP server');
  mcp.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  mcp.child.once('close',()=>void stop());
  const identity=()=>({adapter:'original-session-mcp',ready:!stopping&&!mcp.closed,instanceId,workerPid:process.pid,mcpPid:mcp.child.pid,tool:o.tool,nativeSessionId:o.session,bridgeSessionId:sessionId??null,idleTtlMs:o.idleTtlMs,lastCommandAt});
  let opening;
  const execute=async(action,args)=>{
   validate(action,args);
   if(action==='status')return identity();
   if(action==='open'){
    if(opened){
     const listing=await mcp.call('tools/call',{name:'bridge_list_sessions',arguments:{connectionId:'local'}});
     if(listing.isError)return listing;
     const live=JSON.parse(listing.content[0].text).sessions?.some(s=>s.id===sessionId&&s.nativeSessionId===o.session&&s.tool===o.tool);
     if(!live)throw Error('Original session registration is unavailable; close this adapter and open it again');
     return opened;
    }
    if(!opening)opening=mcp.call('tools/call',{name:'bridge_open_session',arguments:{title:args.title||o.tool+' original '+o.session.slice(0,12),...args,nativeSessionId:o.session}}).then(result=>{if(!result.isError){const s=JSON.parse(result.content[0].text);sessionId=s.id;opened=result;}return result;}).finally(()=>{opening=null;});
    return opening;
   }
   if(!sessionId)throw Error('Open this original conversation first');
   if(action==='close'){
    const result=await mcp.call('tools/call',{name:names.close,arguments:{sessionId}});sessionId=null;
    return result;
   }
   return mcp.call('tools/call',{name:names[action],arguments:{...args,...(['peers','sessions'].includes(action)?{}:{sessionId})}});
  };
  server=http.createServer(async(req,res)=>{
   const send=(code,result)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(result));};
   if(req.headers.origin||req.method!=='POST'||!['/command','/health'].includes(req.url))return send(404,{error:'Unknown endpoint'});
   if(!equal(req.headers.authorization,'Bearer '+capability))return send(401,{error:'Unauthorized'});
   if(req.headers['content-type']!=='application/json')return send(400,{error:'Expected application/json'});
   let accepted=false;
   try{
    const body=JSON.parse(await limited(req));
    if(req.url==='/health'){if(!body||Array.isArray(body)||Object.keys(body).length)throw Error('Invalid health request');return send(200,identity());}
    if(stopping)throw Error('Worker is closing');
    if(!body||Array.isArray(body)||Object.keys(body).some(k=>!['action','args'].includes(k)))throw Error('Invalid command');
    validate(body.action,body.args);active++;accepted=true;lastCommandAt=Date.now();
    const result=await execute(body.action,body.args);
    if(body.action==='close')await stop();
    send(200,result);
   }catch(e){send(e.status||400,{error:e.message});}finally{if(accepted){active--;lastCommandAt=Date.now();}}
  });
  server.requestTimeout=HTTP_TIMEOUT;server.headersTimeout=5000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});record.port=server.address().port;
  const temp=path+'.'+instanceId+'.tmp',updated=await open(temp,'wx',0o600);await updated.writeFile(JSON.stringify(record));await updated.close();await rename(temp,path);
  const startupGraceEnds=Date.now()+1000;
  idle=setInterval(()=>{if(!active&&Date.now()>=startupGraceEnds&&Date.now()-lastCommandAt>=o.idleTtlMs)void stop();},Math.min(10000,o.idleTtlMs));idle.unref();
 }catch(e){await stop();throw e;}
}
async function main(){
 const {values,positionals}=parseArgs({options:{session:{type:'string'},tool:{type:'string'},dir:{type:'string',default:defaultDataDir()},'args-file':{type:'string'},'idle-ttl-ms':{type:'string',default:String(MAX_IDLE)},worker:{type:'boolean',default:false},help:{type:'boolean',default:false}},allowPositionals:true,strict:true});
 if(values.help){console.log('Usage: node scripts/live-session-mcp.mjs --session ORIGINAL_ID --tool claude|codex --dir DATA [--args-file JSON_FILE] open|peers|sessions|receive|ask|result|reply|status|close\nRun from the project directory: automatic peer discovery and routing are scoped to the working directory. Pass action arguments as one JSON object on stdin or in --args-file. Bridge operations return raw MCP result JSON. status returns local connection identity. Open is idempotent; no model is launched. Close explicitly, or the worker closes after 30 minutes without a command. --idle-ttl-ms may shorten that limit (100..1800000).');return;}
 const o={session:values.session,tool:values.tool,dir:resolve(values.dir),idleTtlMs:Number(values['idle-ttl-ms'])};
 if(typeof o.session!=='string'||!o.session.trim()||o.session.length>200||/[\x00-\x1f]/.test(o.session)||!['claude','codex'].includes(o.tool))throw Error('Expected --session ORIGINAL_ID and --tool claude|codex');
 if(!Number.isInteger(o.idleTtlMs)||o.idleTtlMs<100||o.idleTtlMs>MAX_IDLE)throw Error('Idle TTL must be 100..1800000 ms');
 const path=join(o.dir,'live-session-mcp',createHash('sha256').update(o.tool+'\0'+o.session).digest('hex')+'.json');
 if(values.worker){if(positionals.length||values['args-file'])throw Error('Invalid worker arguments');await worker(o,path);return;}
 if(positionals.length!==1)throw Error('Expected exactly one action');
 const action=positionals[0],args=await argsInput(values['args-file']);validate(action,args);
 const r=action==='open'?await ensureWorker(o,path):await getRecord(path);
 if(!r)throw Error('No live adapter for this original conversation; run open first');
 await healthy(r,o);
 const result=await request(r,'/command',{action,args});json(result);if(result.isError)process.exitCode=1;
}
main().catch(e=>{if(!process.argv.includes('--worker'))json({error:e.message});process.exitCode=1;});
