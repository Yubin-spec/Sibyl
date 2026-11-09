#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {defaultDataDir} from '../runtime.mjs';

const REPO_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');

export function repoRootFromScript(url=import.meta.url){
  return resolve(dirname(fileURLToPath(url)),'..');
}

export function hookDirFromSettings(settingsPath){
  try{
    const config=JSON.parse(readFileSync(settingsPath,'utf8'));
    const hooks=config?.hooks;
    if(!hooks||typeof hooks!=='object'||Array.isArray(hooks)) return null;
    const found=new Set();
    for(const groups of Object.values(hooks)){
      if(!Array.isArray(groups)) continue;
      for(const group of groups){
        for(const hook of group?.hooks??[]){
          const command=String(hook?.command??'');
          if(!command.includes('sibyl-hook.mjs')) continue;
          const match=/--dir\s+"([^"]+)"/.exec(command);
          if(match) found.add(match[1]);
        }
      }
    }
    return found.size===1?[...found][0]:null;
  }catch{return null;}
}

export function resolveDataDir({dir,env=process.env,repoRoot=REPO_ROOT,settingsPath,platform=process.platform,home=homedir()}={}){
  if(typeof dir==='string'&&dir.trim()) return resolve(dir);
  if(typeof env.SIBYL_DATA_DIR==='string'&&env.SIBYL_DATA_DIR.trim()) return resolve(env.SIBYL_DATA_DIR);
  const root=repoRoot===undefined?REPO_ROOT:repoRoot;
  const fromSettings=hookDirFromSettings(settingsPath??join(root,'.claude','settings.local.json'));
  if(fromSettings) return resolve(fromSettings);
  if(root) return resolve(join(dirname(root),'data'));
  return defaultDataDir({platform,env,home});
}

export function parseCsrf(html){
  const match=/<meta\s+name="bridge-session"\s+content="([^"]+)"/.exec(String(html??''));
  return match?match[1]:null;
}

export function summarizeStatus(status={}){
  const workers=Array.isArray(status?.workers)?status.workers:[];
  const active=workers.filter(worker=>['starting','running','orphan'].includes(worker?.status));
  const reviews=Array.isArray(status?.planReviews)?status.planReviews:[];
  const needing=reviews.filter(review=>['awaiting-visibility','changes-required','deadlock','interrupted'].includes(review?.status));
  const attention=Array.isArray(status?.attention)?status.attention.length:0;
  const pending=Number.isInteger(status?.nativeInbox?.pendingCount)?status.nativeInbox.pendingCount:0;
  const sessions=Array.isArray(status?.nativeSessions)?status.nativeSessions.length:0;
  return [
    'AI Bridge 状态',
    `工作方：${active.length} 个进行中（共 ${workers.length} 条记录）`,
    `计划评审：${reviews.length} 个（${needing.length} 个待处理）`,
    `待你处理：${attention} 项`,
    `待答问题：${pending} 条`,
    `在线会话：${sessions} 个`
  ].join('\n');
}

export function compactStatus(status={}){
  const workers=Array.isArray(status?.workers)?status.workers:[];
  const reviews=Array.isArray(status?.planReviews)?status.planReviews:[];
  return {
    workers:{active:workers.filter(worker=>['starting','running','orphan'].includes(worker?.status)).length,total:workers.length},
    planReviews:{total:reviews.length,needing:reviews.filter(review=>['awaiting-visibility','changes-required','deadlock','interrupted'].includes(review?.status)).length},
    attention:Array.isArray(status?.attention)?status.attention.length:0,
    pendingCount:Number.isInteger(status?.nativeInbox?.pendingCount)?status.nativeInbox.pendingCount:0,
    sessions:Array.isArray(status?.nativeSessions)?status.nativeSessions.length:0
  };
}

export async function setHooksEnabled({dir,enabled}){
  const target=resolve(dir);
  await mkdir(target,{recursive:true,mode:0o700});
  const file=join(target,'hook-context.json'),temp=file+'.'+randomUUID()+'.tmp';
  try{
    await writeFile(temp,JSON.stringify({enabled:enabled!==false},null,2)+'\n',{mode:0o600,flag:'wx'});
    await rename(temp,file);
  }finally{
    await rm(temp,{force:true});
  }
  return file;
}

export async function readHooksEnabled(dir){
  try{
    const value=JSON.parse(await readFile(join(resolve(dir),'hook-context.json'),'utf8'));
    return value?.enabled!==false;
  }catch{
    return true;
  }
}

export async function readBrowserRuntime(dir){
  const value=JSON.parse(await readFile(join(resolve(dir),'browser-runtime.json'),'utf8'));
  const url=new URL(value?.url);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.pathname!=='/') throw Error('Invalid browser runtime');
  return url;
}

export async function readStatus(url){
  const base=url instanceof URL?url:new URL(url);
  const page=await fetch(new URL('/',base));
  if(!page.ok) throw Error('无法读取观测页 HTTP '+page.status);
  const csrf=parseCsrf(await page.text());
  if(!csrf) throw Error('无法读取本地会话令牌');
  const response=await fetch(new URL('/api/status',base),{headers:{'x-bridge-ui':csrf}});
  if(!response.ok) throw Error('无法读取桥接状态 HTTP '+response.status);
  return response.json();
}

export function observerUrl(url){
  return new URL('/?page=observer',url).toString();
}

export function openUrl(url,{platform=process.platform,spawnFn=spawn}={}){
  const [command,args]=platform==='win32'
    ?['cmd',['/c','start','',url]]
    :platform==='darwin'?['open',[url]]:['xdg-open',[url]];
  const child=spawnFn(command,args,{detached:true,stdio:'ignore'});
  child.unref?.();
  return command;
}

function usage(){
  return [
    'node scripts/sibyl.mjs <open|status|hooks> [选项]',
    '',
    '  open [--no-open]     打印并打开当前观测页',
    '  status [--json]      打印工作方 / 评审 / 待办 / 待答摘要',
    '  hooks on|off|status  开启、关闭或查看上下文 hook',
    '',
    '  --dir <数据目录>     覆盖自动解析的数据目录'
  ].join('\n');
}

export async function main(argv=process.argv.slice(2)){
  const {values,positionals}=parseArgs({
    args:argv,
    options:{dir:{type:'string'},json:{type:'boolean',default:false},'no-open':{type:'boolean',default:false},help:{type:'boolean',default:false}},
    allowPositionals:true,
    strict:true
  });
  const command=positionals[0]??'status';
  if(values.help||command==='help'){console.log(usage());return;}
  const dir=resolveDataDir({dir:values.dir});
  if(command==='hooks'){
    const action=positionals[1]??'status';
    if(action==='on'||action==='off'){
      const file=await setHooksEnabled({dir,enabled:action==='on'});
      console.log(`上下文 hook 已${action==='on'?'开启':'关闭'}：${file}`);
      return;
    }
    if(action==='status'){
      const enabled=await readHooksEnabled(dir);
      console.log(`上下文 hook：${enabled?'开启':'关闭'}（${join(dir,'hook-context.json')}）`);
      return;
    }
    throw Error('hooks 只支持 on / off / status');
  }
  if(command==='open'||command==='status'){
    let url;
    try{url=await readBrowserRuntime(dir);}
    catch{throw Error(`桥接未运行或数据目录不对；先运行 start-observer.cmd（数据目录：${dir}）`);}
    if(command==='open'){
      const target=observerUrl(url);
      console.log(target);
      if(!values['no-open']) openUrl(target);
      return;
    }
    const status=await readStatus(url);
    if(values.json) console.log(JSON.stringify({url:url.toString(),...compactStatus(status)},null,2));
    else console.log(`${url}\n${summarizeStatus(status)}`);
    return;
  }
  throw Error('未知命令：'+command+'\n\n'+usage());
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
