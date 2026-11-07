import {readFile,writeFile,mkdir,rename,copyFile,constants,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const backupOnce=async path=>{await copyFile(path,path+'.ai-bridge-backup',constants.COPYFILE_EXCL).catch(e=>{if(e.code!=='EEXIST')throw e;});};
const writeAtomic=async(path,data)=>{const temp=path+'.'+randomUUID()+'.tmp';try{await writeFile(temp,data,{mode:0o600,flag:'wx'});await rename(temp,path);}finally{await rm(temp,{force:true});}};
const instructions={
 claude:'配置已写入。请在 Claude Code 原会话里用 /mcp 检查或重连 ai-bridge；若当前版本不能动态加载，续接原会话后再检查。该会话的 MCP 进程会按当前工作目录自动登记，同目录的其他 AI 工具会话可直接被发现；需要更清楚的主题时再调用 bridge_open_session 覆盖标题。用 bridge_receive 接收问题。跨工具目标已在配置 MCP 时一并保存；发现另一个 AI 工具负责的模块需要核对时，调用 bridge_consult 只传工具名，它会按绑定启动只读托管咨询，未绑定才使用当前项目。收到原会话问题后用 bridge_reply 回答，询问方用 bridge_ask/bridge_result 或 bridge_consult/bridge_consult_result 继续任务。',
 cursor:'配置已写入。请在 Cursor 的 MCP 设置启用 ai-bridge，回到原会话确认工具可见；必要时重新加载窗口并保留原聊天。如果使用 Cursor CLI，先在项目目录执行 cursor-agent mcp enable ai-bridge；无界面运行还要按 Cursor 的审批策略允许 ai-bridge 工具调用。MCP 进程会按当前工作目录自动登记，同目录的其他 AI 工具会话可直接被发现；需要明确主题时再调用 bridge_open_session 覆盖标题。用 bridge_receive 接收并用 bridge_reply 回答。跨工具目标已在配置 MCP 时一并保存；跨工具核对时 bridge_consult 只传工具名。',
 codex:'配置已写入。Codex 重新打开会话后确认 ai-bridge MCP 可见；该服务已设置 default_tools_approval_mode="approve"，只自动批准 ai-bridge 的工具调用，不改 Codex 其他审批设置。MCP 进程会按当前工作目录自动登记，同目录的其他 AI 工具会话可直接被发现；需要明确主题时再调用 bridge_open_session 覆盖标题。用 bridge_receive/bridge_reply 收发；跨工具核对时 bridge_consult 只传工具名，目标项目由保存的绑定决定。'
};

async function configureCodex({dir,nodePath,scriptPath,codexConfigPath}){
 const configPath=codexConfigPath||join(process.env.CODEX_HOME||join(homedir(),'.codex'),'config.toml');
 await mkdir(dirname(configPath),{recursive:true,mode:0o700});
 let raw='';try{raw=await readFile(configPath,'utf8');}catch(e){if(e.code!=='ENOENT')throw Error('Cannot read Codex config: '+e.message);}
 if(/^\s*mcp_servers\s*=\s*\{/m.test(raw))throw Error('Codex config uses an inline mcp_servers table; add ai-bridge manually');
 const block=`[mcp_servers.ai-bridge]\ncommand = ${JSON.stringify(nodePath)}\nargs = [${[scriptPath,'--dir',resolve(dir),'--tool','codex'].map(JSON.stringify).join(', ')}]\ndefault_tools_approval_mode = "approve"\ntool_timeout_sec = 120\n`;
 const header=/^\[\s*mcp_servers\.ai-bridge\s*\]\s*$/m.exec(raw);
 let next;
 if(header){
  const after=header.index+header[0].length,rest=raw.slice(after),following=/^\[[^\n]+\]\s*$/m.exec(rest),end=following?after+following.index:raw.length;
  next=raw.slice(0,header.index)+block+(following?raw.slice(end):'');
 }else{
  const prefix=raw&&!raw.endsWith('\n')?raw+'\n':raw;
  next=prefix+(prefix.trim()?'\n':'')+block;
 }
 if(next!==raw){if(raw)await backupOnce(configPath);await writeAtomic(configPath,next);}
 return {configPath,tool:'codex',instructions:instructions.codex,notice:'Codex 使用用户级配置；首次修改会留下 .ai-bridge-backup。自动审批只覆盖 ai-bridge 的 MCP 工具，只读 Worker 的权限仍由桥接层限制。'};
}

export async function configureNativeTool({project,tool,dir,nodePath=process.execPath,scriptPath=fileURLToPath(new URL('./native-mcp.mjs',import.meta.url)),codexConfigPath}={}){
 if(!['claude','cursor','codex'].includes(tool))throw Error('Unsupported native tool');
 if(tool==='codex')return configureCodex({dir,nodePath,scriptPath,codexConfigPath});
 const configPath=join(resolve(project),tool==='claude'?'.mcp.json':'.cursor/mcp.json');
 await mkdir(dirname(configPath),{recursive:true});
 let raw=null,config={};try{raw=await readFile(configPath,'utf8');config=JSON.parse(raw);}catch(e){if(e.code!=='ENOENT')throw Error('Cannot update MCP JSON: '+e.message);}
 if(!config||Array.isArray(config)||typeof config!=='object'||config.mcpServers!==undefined&&(!config.mcpServers||typeof config.mcpServers!=='object'||Array.isArray(config.mcpServers)))throw Error('Invalid MCP JSON structure; original file preserved');
 const entry={command:nodePath,args:[scriptPath,'--dir',resolve(dir),'--tool',tool]};
 if(tool==='claude')entry.type='stdio';
 const previous=config.mcpServers?.['ai-bridge'];
 if(JSON.stringify(previous)!==JSON.stringify(entry)){
  if(raw!==null)await backupOnce(configPath);
  config.mcpServers={...config.mcpServers,'ai-bridge':entry};
  await writeAtomic(configPath,JSON.stringify(config,null,2)+'\n');
 }
 return {configPath,tool,instructions:instructions[tool],notice:'进程启动即按工作目录自动登记并与同目录会话互相发现；接收问题仍需原会话实际调用 bridge_receive。bridge_consult 按预绑定项目启动只读托管咨询，但不会接管或唤醒目标原聊天。'};
}
