#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {resolveAgentExecutable,agentEnv} from '../runtime.mjs';

export const WORKER_POLICY = `你是 Agents Calling 启动的工作方，不是与人对话的会话。只完成被派的任务，不扩大范围。
不安装依赖、不联网；需要确认的操作直接放弃，并在结果里说明哪一步被挡住。
结束时用中文写清：改了哪些文件、跑了什么、还剩什么没做。`;

const EFFORTS={low:'low',medium:'medium',high:'high',ultra:'max'};

const SANDBOXES={
  'read-only':['--tools','Read,Grep,Glob'],
  'workspace-write':['--permission-mode','acceptEdits','--allowedTools','Read,Grep,Glob,Edit,Write,Bash(node --test *)'],
};

// Args only: the prompt travels on stdin, so it never lands in a process list.
export function buildClaudeArgs({sandbox='read-only',effort='high',session=null}={}){
  if(!Object.hasOwn(SANDBOXES,sandbox)) throw Error('sandbox must be read-only or workspace-write');
  if(!Object.hasOwn(EFFORTS,effort)) throw Error('effort must be low, medium, high or ultra');
  const args=['-p','--output-format','json','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--max-turns',sandbox==='workspace-write'?'40':'4',...SANDBOXES[sandbox],'--effort',EFFORTS[effort],'--append-system-prompt',WORKER_POLICY];
  if(session) args.push('--resume',session);
  return args;
}

export async function runClaudeTurn({prompt,session=null,sandbox='read-only',effort='high',timeoutMs=180000,cwd=process.cwd(),executable=null,env=process.env,signal}={}){
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000) throw Error('timeoutMs must be 1000..600000');
  const runnable=executable??await resolveAgentExecutable('claude',{env});
  const childEnv=await agentEnv('claude',env);
  const args=[...runnable.args,...buildClaudeArgs({sandbox,effort,session})];
  return await new Promise((resolve,reject)=>{
    const child=spawn(runnable.command,args,{cwd,env:childEnv,stdio:['pipe','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='',settled=false;
    const fail=error=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(error);};
    const done=value=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve(value);};
    const stop=()=>{try{child.kill('SIGKILL');}catch{}};
    const abort=()=>{stop();fail(Error('Claude cancelled'));};
    const timer=setTimeout(()=>{stop();fail(Error('Claude turn timed out after '+timeoutMs+' ms'));},timeoutMs);
    if(signal?.aborted) return abort();
    signal?.addEventListener('abort',abort,{once:true});
    child.on('error',error=>fail(error.code==='ENOENT'?Error('Claude executable not found; set SIBYL_CLAUDE_PATH or install Claude Code'):error));
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
    child.stdin.on('error',()=>{});
    child.on('close',code=>{
      if(settled)return;
      if(code!==0)return fail(Error('Claude exited '+code+(stderr?': '+stderr.trim():'')));
      let value;try{value=JSON.parse(stdout);}catch{return fail(Error('Claude returned an unsuccessful or invalid result'));}
      if(value?.is_error||typeof value?.result!=='string'||typeof value?.session_id!=='string') return fail(Error('Claude returned an unsuccessful or invalid result'));
      done({text:value.result,sessionId:value.session_id});
    });
    child.stdin.end(prompt);
  });
}
