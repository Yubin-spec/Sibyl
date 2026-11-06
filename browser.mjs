import {spawn} from 'node:child_process';
import {open,mkdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {defaultDataDir,agentEnv} from './runtime.mjs';

const {values}=parseArgs({options:{dir:{type:'string',default:defaultDataDir()},'no-open':{type:'boolean'},stop:{type:'boolean'}}});
if(Number(process.versions.node.split('.')[0])<26)throw Error('Node.js 26 or newer is required. Use start-browser.cmd on Windows.');
const dir=resolve(values.dir),recordFile=join(dir,'browser-runtime.json');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function running(){
 try{
  const r=JSON.parse(await readFile(recordFile,'utf8'));
  if(!Number.isInteger(r.pid)||r.pid<1||!/^http:\/\/127\.0\.0\.1:\d+$/.test(r.url))return null;
  process.kill(r.pid,0);
  const response=await fetch(r.url,{signal:AbortSignal.timeout(2000)}),html=await response.text();
  const csrf=html.match(/name="bridge-session" content="([a-f0-9]{64})"/)?.[1];
  return response.ok&&csrf?{...r,csrf}:null;
 }catch{return null;}
}
let r=await running();
if(values.stop){
 if(r){
  const response=await fetch(r.url+'/api/shutdown',{method:'POST',headers:{origin:r.url,'x-bridge-ui':r.csrf,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw Error('Could not stop bridge');
  for(let i=0;i<150;i++){if(!(await running())){r=null;break;}await pause(100);}
  if(r)throw Error('Bridge is still shutting down; inspect server.log');
 }
 console.log(JSON.stringify({stopped:true}));
}else{
 if(!r){
  await mkdir(dir,{recursive:true,mode:0o700});
  const log=await open(join(dir,'server.log'),'a',0o600);
  const child=spawn(process.execPath,[fileURLToPath(new URL('./control.mjs',import.meta.url)),dir],{cwd:dir,detached:true,windowsHide:true,stdio:['ignore',log.fd,log.fd],env:await agentEnv('claude',process.env)});
  let failure;child.once('error',e=>failure=e);child.unref();await log.close();
  for(let i=0;i<150;i++){if(failure)throw failure;r=await running();if(r)break;await pause(100);}
  if(!r)throw Error('Bridge did not start. Inspect '+join(dir,'server.log'));
 }
 if(!values['no-open']){
  const command=process.platform==='win32'?'rundll32.exe':process.platform==='darwin'?'open':'xdg-open';
  const args=process.platform==='win32'?['url.dll,FileProtocolHandler',r.url]:[r.url];
  const browser=spawn(command,args,{detached:true,windowsHide:true,stdio:'ignore'});browser.on('error',e=>console.error('Open this URL manually: '+r.url+' ('+e.message+')'));browser.unref();
 }
 console.log(JSON.stringify({url:r.url,pid:r.pid,dataDir:dir}));
}
