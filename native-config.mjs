import {readFile,writeFile,mkdir,rename,copyFile,constants,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

export async function configureNativeTool({project,tool,dir,nodePath=process.execPath,scriptPath=fileURLToPath(new URL('./native-mcp.mjs',import.meta.url))}){
 if(!['claude','cursor'].includes(tool))throw Error('Unsupported native tool');
 const configPath=join(resolve(project),tool==='claude'?'.mcp.json':'.cursor/mcp.json');
 await mkdir(dirname(configPath),{recursive:true});
 let raw=null,config={};try{raw=await readFile(configPath,'utf8');config=JSON.parse(raw);}catch(e){if(e.code!=='ENOENT')throw Error('Cannot update MCP JSON: '+e.message);}
 if(!config||Array.isArray(config)||typeof config!=='object'||config.mcpServers!==undefined&&(!config.mcpServers||typeof config.mcpServers!=='object'||Array.isArray(config.mcpServers)))throw Error('Invalid MCP JSON structure; original file preserved');
 const entry={command:nodePath,args:[scriptPath,'--dir',resolve(dir),'--tool',tool]};
 if(tool==='claude')entry.type='stdio';
 const previous=config.mcpServers?.['ai-bridge'];
 if(JSON.stringify(previous)!==JSON.stringify(entry)){
  if(raw!==null)await copyFile(configPath,configPath+'.ai-bridge-backup',constants.COPYFILE_EXCL).catch(e=>{if(e.code!=='EEXIST')throw e;});
  config.mcpServers={...config.mcpServers,'ai-bridge':entry};
  const temp=configPath+'.'+randomUUID()+'.tmp';
  try{await writeFile(temp,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(temp,configPath);}finally{await rm(temp,{force:true});}
 }
 return {configPath,tool,instructions:tool==='claude'?'配置已写入。请在 Claude Code 原会话里用 /mcp 检查或重连 ai-bridge；若当前版本不能动态加载，续接原会话后再检查。然后让该会话调用 bridge_open_session 登记，并用 bridge_receive 接收问题。收到问题后在原会话分析、调用 bridge_reply；询问方用 bridge_ask 或 bridge_result 收到答复继续任务。':'配置已写入。请在 Cursor 的 MCP 设置启用 ai-bridge，回到原会话确认工具可见；必要时重新加载窗口并保留原聊天。让该会话调用 bridge_open_session 登记，再用 bridge_receive 接收并用 bridge_reply 回答。询问方用 bridge_ask 或 bridge_result 收到答复继续任务。',notice:'登记与接收由原会话实际调用工具完成；配置成功不等于原会话已接入。普通 MCP 不会向未接收消息的闲置会话自动插话。'};
}
