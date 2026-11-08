#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

// Everything that reaches the remote shell is quoted here. The message body
// never goes into the command line — it travels on stdin — so file paths and
// task titles in a notification cannot turn into remote commands.
const quote=value=>`'${String(value).replace(/'/g,"'\\''")}'`;

export function buildRemoteCommand({hermes,target,title}){
  if(!hermes||!target) throw Error('notify config needs hermes and target');
  return `${quote(hermes)} send --to ${quote(target)}${title?` --subject ${quote(title)}`:''}`;
}

export function buildSshArgs({host,user,key,command}){
  return ['-i',key,'-o','BatchMode=yes','-o','ConnectTimeout=15','-o','StrictHostKeyChecking=accept-new',`${user}@${host}`,command];
}

function defaultRun({host,user,key,command,input}){
  return new Promise((resolveRun,reject)=>{
    const child=spawn('ssh',buildSshArgs({host,user,key,command}),{stdio:['pipe','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
    child.stdin.on('error',()=>{});
    child.on('error',error=>reject(error.code==='ENOENT'?Error('ssh executable not found'):error));
    child.on('close',code=>{
      if(code!==0) return reject(Error('hermes send failed ('+code+')'+(stderr?': '+stderr.trim():'')));
      resolveRun(stdout.trim());
    });
    child.stdin.end(input??'');
  });
}

export async function notify({title,body,config,run=defaultRun}){
  for(const field of ['host','user','key','hermes','target']) {
    if(!config?.[field]) throw Error('notify config needs '+field);
  }
  const command=buildRemoteCommand({hermes:config.hermes,target:config.target,title});
  return await run({host:config.host,user:config.user,key:config.key,command,input:body??''});
}

export async function loadConfig(path=process.env.SIBYL_NOTIFY_CONFIG??'.notify.json'){
  try{
    return JSON.parse(await readFile(path,'utf8'));
  }catch(error){
    if(error.code==='ENOENT') throw Error('Missing notify config: create '+path+' with host, user, key, hermes and target');
    throw error;
  }
}

export async function main(argv=process.argv.slice(2)){
  const {values,positionals}=parseArgs({args:argv,options:{
    title:{type:'string'},body:{type:'string'},config:{type:'string'},help:{type:'boolean',default:false},
  },allowPositionals:true,strict:true});
  if(values.help){console.log([
    'node scripts/notify-wechat.mjs --title "阶段名" --body "完成了什么 / 还差什么 / 预计多久"',
    '  --config   path to notify JSON (default: .notify.json, or $SIBYL_NOTIFY_CONFIG)',
  ].join('\n'));process.exit(0);}
  const title=values.title??positionals[0];
  const body=values.body??positionals[1]??'';
  if(!title) throw Error('A title is required: --title "<task>"');
  const config=await loadConfig(values.config??undefined);
  const result=await notify({title,body,config});
  console.log(result||'sent');
}

const invoked=process.argv[1]?pathToFileURL(resolve(process.argv[1])).href:null;
if(invoked&&invoked===import.meta.url) await main();
