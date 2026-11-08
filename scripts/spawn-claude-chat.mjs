#!/usr/bin/env node

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
