import {access,readFile,readdir,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {basename,dirname,extname,isAbsolute,join,posix,relative,resolve,sep,win32} from 'node:path';

export function defaultDataDir({platform=process.platform,env=process.env,home=homedir()}={}) {
  if(platform==='win32') return win32.join(env.LOCALAPPDATA||win32.join(home,'AppData','Local'),'AI Bridge');
  if(platform==='darwin') return posix.join(home,'Library','Application Support','AI Bridge');
  return posix.join(env.XDG_DATA_HOME||posix.join(home,'.local','share'),'ai-bridge');
}

function environmentValue(env,key,platform) {
  const name=platform==='win32'?Object.keys(env).find(name=>name.toUpperCase()===key.toUpperCase()):key;
  return env[name]||'';
}

async function isFile(path,{platform}) {
  try {
    if(!(await stat(path)).isFile()) return false;
    if(platform!=='win32') await access(path,constants.X_OK);
    return true;
  }catch{return false;}
}

function notFound(command) {
  const error=Error('Executable not found: '+command);error.code='ENOENT';return error;
}

async function npmPackages(root) {
  const packages=[];
  for(const item of await readdir(root,{withFileTypes:true}).catch(()=>[])) {
    if(!item.isDirectory()&&!item.isSymbolicLink()) continue;
    if(item.name.startsWith('@')) {
      for(const child of await readdir(join(root,item.name),{withFileTypes:true}).catch(()=>[])) {
        if(child.isDirectory()||child.isSymbolicLink()) packages.push(join(root,item.name,child.name));
      }
    }else if(!item.name.startsWith('.')) packages.push(join(root,item.name));
  }
  return packages;
}

function windowsNative(path) {
  return typeof path==='string'&&isAbsolute(path)&&['.exe','.com'].includes(extname(path).toLowerCase())?{command:path,args:[]}:null;
}

// Installers point at a native executable through a one-line wrapper. Read the
// file and launch that executable directly; the wrapper itself never runs.
async function windowsBatchTarget(path) {
  const text=await readFile(path,'utf8').catch(()=>null);
  if(!text||text.length>4096) return null;
  const lines=text.split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!/^@?echo\s+off$/i.test(line));
  if(lines.length!==1) return null;
  const match=/^"([^"%]+\.(?:exe|com))"\s+%\*$/i.exec(lines[0]);
  const target=match&&windowsNative(match[1]);
  return target&&await isFile(target.command,{platform:'win32'})?target:null;
}

function windowsPath(value) {
  const drive=/^\/([a-zA-Z])\/(.+)$/.exec(value);
  return drive?drive[1].toUpperCase()+':\\'+drive[2].replaceAll('/','\\'):value;
}

async function windowsShellShim(path) {
  const text=await readFile(path,'utf8').catch(()=>null);
  if(!text||text.length>4096) return null;
  const lines=text.split(/\r?\n/);
  if(!/^#![^\r\n]*\b(?:bash|sh)\b/.test(lines[0]||'')) return null;
  // A forwarded exec is only trustworthy when it is the script's sole statement;
  // anything else (exit, conditions, a second exec) means real control flow.
  const body=lines.slice(1).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
  if(body.length!==1) return null;
  const match=/^exec\s+(?:"([^"]+)"|(\S+))\s+"\$@"$/.exec(body[0]);
  if(!match) return null;
  const target=windowsNative(windowsPath(match[1]||match[2]));
  return target&&await isFile(target.command,{platform:'win32'})?target:null;
}

async function executableEntry(path,{platform,nodePath}) {
  if(!(await isFile(path,{platform:'win32'}))) throw notFound(path);
  const extension=extname(path).toLowerCase();
  if(['.cmd','.bat','.ps1'].includes(extension)) throw Error('Unsupported batch entry; configure a native executable or Node entry file');
  if(['.js','.cjs','.mjs'].includes(extension)) return {command:nodePath,args:[path]};
  if(platform==='win32'&&!['.exe','.com'].includes(extension)) {
    // Node scripts have no extension in many npm packages. Never evaluate their
    // Windows batch wrappers; invoke the Node entry with a separate argv item.
    const firstLine=(await readFile(path,'utf8')).split(/\r?\n/,1)[0];
    if(/^#![^\r\n]*\bnode(?:\s|$)/.test(firstLine)) return {command:nodePath,args:[path]};
    const shim=await windowsShellShim(path);
    if(shim) return shim;
    throw Error('Unsupported executable; configure a native executable or Node entry file');
  }
  if(!(await isFile(path,{platform}))) throw notFound(path);
  return {command:path,args:[]};
}

async function npmShim(shim,options) {
  const command=basename(shim,extname(shim));
  const directory=dirname(shim),root=basename(directory)==='.bin'?dirname(directory):join(directory,'node_modules');
  for(const packageDir of await npmPackages(root)) {
    let metadata;try{metadata=JSON.parse(await readFile(join(packageDir,'package.json'),'utf8'));}catch{continue;}
    const entry=typeof metadata.bin==='string'&&metadata.name?.split('/').at(-1)===command?metadata.bin:metadata.bin?.[command];
    if(typeof entry!=='string'||!entry) continue;
    const target=resolve(packageDir,entry),inside=relative(packageDir,target);
    if(!inside||inside==='..'||inside.startsWith('..'+sep)||resolve(inside)===inside) throw Error('npm bin entry escapes its package directory');
    return executableEntry(target,options);
  }
  throw Error('Unsupported batch wrapper: no matching npm package bin entry for '+command);
}

export async function resolveExecutable(command,{platform=process.platform,env=process.env,cwd=process.cwd(),nodePath=process.execPath}={}) {
  if(typeof command!=='string'||!command||/[\x00\r\n]/.test(command)) throw Error('Expected an executable name or path');
  const options={platform,nodePath},hasPath=/[\\/]/.test(command);
  const extensions=platform==='win32'&&!extname(command)?['.exe','.com','.cmd','.ps1','']:[''];
  const directories=hasPath?['']:environmentValue(env,'PATH',platform).split(platform==='win32'?';':':').filter(Boolean).map(path=>path.replace(/^"(.*)"$/,'$1'));
  let unsupported;
  for(const directory of directories) {
    for(const extension of extensions) {
      const path=resolve(cwd,directory,command+extension);
      if(!(await isFile(path,{platform:'win32'}))) continue;
      try {
        if(['.cmd','.bat'].includes(extname(path).toLowerCase())) {const direct=await windowsBatchTarget(path);if(direct) return direct;return await npmShim(path,options);}
        if(extname(path).toLowerCase()==='.ps1') return await npmShim(path,options);
        return await executableEntry(path,options);
      }catch(error){if(hasPath) throw error;unsupported=error;}
    }
  }
  throw unsupported||notFound(command);
}

const agentCommands={claude:['claude'],codex:['codex'],cursor:['cursor-agent','agent']};
export async function resolveAgentExecutable(agent,options={}) {
  if(!Object.hasOwn(agentCommands,agent)) throw Error('Unknown agent');
  const env=options.env||process.env,explicit=options.executables?.[agent]||environmentValue(env,'SIBYL_'+agent.toUpperCase()+'_PATH',options.platform||process.platform);
  if(explicit) return resolveExecutable(explicit,{...options,env});
  let failure;
  for(const command of agentCommands[agent]) {
    try{return await resolveExecutable(command,options);}catch(error){if(error.code!=='ENOENT') throw error;failure=error;}
  }
  throw failure;
}

// Claude Code keeps provider switches (base URL, token, model aliases) in
// settings.json. Long-running hosts do not inherit that file's env, so merge it
// under whatever the process already has.
export async function claudeSettingsEnv({env=process.env,home=homedir(),platform=process.platform}={}) {
  const file=environmentValue(env,'SIBYL_CLAUDE_SETTINGS',platform)||join(environmentValue(env,'CLAUDE_CONFIG_DIR',platform)||join(home,'.claude'),'settings.json');
  try {
    const data=JSON.parse(await readFile(file,'utf8'));
    const values=data?.env;
    if(!values||typeof values!=='object'||Array.isArray(values)) return {};
    return Object.fromEntries(Object.entries(values).filter(([key,value])=>typeof value==='string'&&/^[A-Z][A-Z0-9_]*$/.test(key)));
  }catch{return {};}
}

function mergeEnvironment(base,settings,platform) {
  if(platform!=='win32') return {...base,...settings};
  const merged={...base},index=new Map();
  for(const key of Object.keys(merged)) index.set(key.toUpperCase(),key);
  for(const [key,value] of Object.entries(settings)) {
    const existing=index.get(key.toUpperCase());
    if(existing&&existing!==key) delete merged[existing];
    merged[key]=value;index.set(key.toUpperCase(),key);
  }
  return merged;
}

// Claude Code applies settings.json env over the launching environment, so a
// provider switch in the file wins over a stale base URL or model alias.
export async function agentEnv(agent,base=process.env,overrides={},platform=process.platform) {
  if(agent!=='claude') return base;
  const settings=await claudeSettingsEnv({env:{...base,...overrides},platform});
  return mergeEnvironment(base,settings,platform);
}

// WHATWG Fetch blocks these ports; undici refuses a request before it is sent.
const FETCH_BLOCKED_PORTS=new Set([1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080]);

// Bind an ephemeral loopback port that fetch is allowed to call. OS-assigned
// ports can land on a blocked one (for example 6000), which would break every
// native MCP request even though the server is healthy.
export const DEFAULT_UI_PORT = 47830;

export async function listenLoopback(server, preferredPort = 0){
  if(server.listening)return server.address().port;
  const usable=Number.isInteger(preferredPort)&&preferredPort>=1024&&preferredPort<=65535&&!FETCH_BLOCKED_PORTS.has(preferredPort);
  if(usable){
    try{
      await new Promise((resolve,reject)=>{
        const onError=error=>{server.off('listening',onListening);reject(error);};
        const onListening=()=>{server.off('error',onError);resolve();};
        server.once('error',onError);server.once('listening',onListening);
        server.listen(preferredPort,'127.0.0.1');
      });
      return server.address().port;
    }catch(error){
      if(error.code!=='EADDRINUSE'&&error.code!=='EACCES')throw error;
      if(server.listening)await new Promise(resolve=>server.close(()=>resolve()));
    }
  }
  for(let attempt=0;attempt<20;attempt++){
    await new Promise((resolve,reject)=>{
      const onError=error=>{server.off('listening',onListening);reject(error);};
      const onListening=()=>{server.off('error',onError);resolve();};
      server.once('error',onError);server.once('listening',onListening);server.listen(0,'127.0.0.1');
    });
    const port=server.address()?.port;
    if(Number.isInteger(port)&&!FETCH_BLOCKED_PORTS.has(port))return port;
    await new Promise(resolve=>server.close(()=>resolve()));
  }
  throw Error('Could not bind a fetch-compatible loopback port');
}
