import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

test('native connector configuration preserves unrelated MCP settings and adds no model credentials',async()=>{
 const mod=await import('./native-config.mjs').catch(()=>({}));assert.equal(typeof mod.configureNativeTool,'function');
 const project=await mkdtemp(join(tmpdir(),'bridge-config-'));
 try{
  await writeFile(join(project,'.mcp.json'),JSON.stringify({mcpServers:{existing:{command:'existing'}},extra:true}));
  const a=await mod.configureNativeTool({project,tool:'claude',dir:'/private/bridge-data',nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs'});
  const config=JSON.parse(await readFile(a.configPath,'utf8'));assert.equal(config.extra,true);assert.equal(config.mcpServers.existing.command,'existing');
  assert.deepEqual(config.mcpServers['ai-bridge'].args,['/app/native-mcp.mjs','--dir',resolve('/private/bridge-data'),'--tool','claude']);
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
  assert.ok(text.includes(JSON.stringify(resolve('/private/bridge-data'))));
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

test('Claude hooks merge, stay idempotent and preserve unrelated settings',async()=>{
 const mod=await import('./native-config.mjs');
 const project=await mkdtemp(join(tmpdir(),'bridge-hooks-'));
 const settings=join(project,'.claude','settings.local.json');
 try{
  await mkdir(join(project,'.claude'),{recursive:true});
  await writeFile(settings,JSON.stringify({
    permissions:{allow:['Bash(ls)']},
    hooks:{
      Stop:[{hooks:[{type:'command',command:'say done'}]}],
      PreToolUse:[{matcher:'Bash',hooks:[{type:'command',command:'echo foreign'}]}]
    }
  }));
  const options={project,tool:'claude',dir:'/data with space',nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs',hookScript:'/app/sibyl-hook.mjs'};
  const first=await mod.configureNativeTool(options);
  assert.equal(first.hooksPath,settings);
  const config=JSON.parse(await readFile(settings,'utf8'));
  assert.deepEqual(config.permissions,{allow:['Bash(ls)']});
  assert.ok(config.hooks.Stop.some(group=>group.hooks.some(hook=>hook.command==='say done')));
  const oursStop=config.hooks.Stop.flatMap(group=>group.hooks).filter(hook=>hook.command.includes('sibyl-hook.mjs'));
  assert.equal(oursStop.length,1);
  assert.match(oursStop[0].command,/--event stop/);
  assert.match(oursStop[0].command,/data with space/);
  const oursPre=config.hooks.PreToolUse.flatMap(group=>group.hooks).filter(hook=>hook.command.includes('sibyl-hook.mjs'));
  assert.equal(oursPre.length,1);
  assert.match(oursPre[0].command,/--event pre-tool/);
  const oursStart=config.hooks.SessionStart.flatMap(group=>group.hooks).filter(hook=>hook.command.includes('sibyl-hook.mjs'));
  assert.equal(oursStart.length,1);
  assert.match(oursStart[0].command,/--event session-start/);
  const oursPrompt=config.hooks.UserPromptSubmit.flatMap(group=>group.hooks).filter(hook=>hook.command.includes('sibyl-hook.mjs'));
  assert.equal(oursPrompt.length,1);
  assert.match(oursPrompt[0].command,/--event user-prompt/);
  assert.ok(config.hooks.SessionStart.every(group=>group.matcher===undefined));
  assert.ok(config.hooks.UserPromptSubmit.every(group=>group.matcher===undefined));
  assert.ok(config.hooks.PreToolUse.some(group=>group.matcher==='Bash'));
  await mod.configureNativeTool(options);
  assert.equal(await readFile(settings,'utf8'),JSON.stringify(config,null,2)+'\n');
  await writeFile(settings,'{broken');
  await assert.rejects(mod.configureNativeTool(options),/hooks|JSON/);
  assert.equal(await readFile(settings,'utf8'),'{broken');
  const exact=`"/app/node" "/app/sibyl-hook.mjs" --dir "${resolve('/data with space')}" --event stop`;
  await writeFile(settings,JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:exact}]},{hooks:[{type:'command',command:exact}]}]}}));
  await assert.rejects(mod.configureNativeTool(options),/Ambiguous/);
 }finally{await rm(project,{recursive:true,force:true});}
});
