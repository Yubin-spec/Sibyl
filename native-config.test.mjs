import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('native connector configuration preserves unrelated MCP settings and adds no model credentials',async()=>{
 const mod=await import('./native-config.mjs').catch(()=>({}));assert.equal(typeof mod.configureNativeTool,'function');
 const project=await mkdtemp(join(tmpdir(),'bridge-config-'));
 try{
  await writeFile(join(project,'.mcp.json'),JSON.stringify({mcpServers:{existing:{command:'existing'}},extra:true}));
  const a=await mod.configureNativeTool({project,tool:'claude',dir:'/private/bridge-data',nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs'});
  const config=JSON.parse(await readFile(a.configPath,'utf8'));assert.equal(config.extra,true);assert.equal(config.mcpServers.existing.command,'existing');
  assert.deepEqual(config.mcpServers['ai-bridge'].args,['/app/native-mcp.mjs','--dir','/private/bridge-data','--tool','claude']);
  const b=await mod.configureNativeTool({project,tool:'cursor',dir:'/private/bridge-data',nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs'});
  assert.equal(b.configPath,join(project,'.cursor','mcp.json'));
  assert.ok(!JSON.stringify(config).includes('token'));assert.match(a.instructions,/原会话/);
  await assert.rejects(mod.configureNativeTool({project,tool:'unknown',dir:'/data'}),/Unsupported/);
  await writeFile(join(project,'.mcp.json'),'{broken');
  await assert.rejects(mod.configureNativeTool({project,tool:'claude',dir:'/data'}),/JSON/);
  assert.equal(await readFile(join(project,'.mcp.json'),'utf8'),'{broken');
 }finally{await rm(project,{recursive:true,force:true});}
});

test('Codex configuration adds a user-level MCP server with narrow auto approval',async()=>{
 const mod=await import('./native-config.mjs');
 const home=await mkdtemp(join(tmpdir(),'bridge-codex-'));
 const configPath=join(home,'config.toml');
 try{
  await writeFile(configPath,'model = "existing"\n\n[model_providers.custom]\nname = "custom"\n');
  const result=await mod.configureNativeTool({project:home,tool:'codex',dir:'/private/bridge-data',nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs',codexConfigPath:configPath});
  const text=await readFile(configPath,'utf8');
  assert.equal(result.configPath,configPath);
  assert.match(text,/\[mcp_servers\.ai-bridge\]/);
  assert.match(text,/default_tools_approval_mode = "approve"/);
  assert.match(text,/tool_timeout_sec = 120/);
  assert.match(text,/--tool", "codex"/);
  assert.match(text,/"\/private\/bridge-data"/);
  assert.match(text,/\[model_providers\.custom\]/);
  assert.equal((text.match(/\[mcp_servers\.ai-bridge\]/g)||[]).length,1);
  assert.match(await readFile(configPath+'.ai-bridge-backup','utf8'),/model = "existing"/);
  await mod.configureNativeTool({project:home,tool:'codex',dir:'/private/bridge-data',nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs',codexConfigPath:configPath});
  assert.equal(await readFile(configPath,'utf8'),text);
  await writeFile(configPath,'mcp_servers = { ai-bridge = {} }\n');
  await assert.rejects(mod.configureNativeTool({project:home,tool:'codex',dir:'/data',nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs',codexConfigPath:configPath}),/inline/);
  assert.equal(await readFile(configPath,'utf8'),'mcp_servers = { ai-bridge = {} }\n');
 }finally{await rm(home,{recursive:true,force:true});}
});
