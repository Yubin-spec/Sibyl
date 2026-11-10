import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

// Windows 会把 POSIX 字面量解析到当前盘符，断言必须使用平台实际路径。
const fakeData=resolve('/private/bridge-data');

test('native connector configuration preserves unrelated MCP settings and adds no model credentials',async()=>{
 const mod=await import('../src/native/native-config.mjs').catch(()=>({}));assert.equal(typeof mod.configureNativeTool,'function');
 const project=await mkdtemp(join(tmpdir(),'bridge-config-'));
 try{
  await writeFile(join(project,'.mcp.json'),JSON.stringify({mcpServers:{existing:{command:'existing'}},extra:true}));
  const a=await mod.configureNativeTool({project,tool:'claude',dir:fakeData,nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs'});
  const config=JSON.parse(await readFile(a.configPath,'utf8'));assert.equal(config.extra,true);assert.equal(config.mcpServers.existing.command,'existing');
  assert.deepEqual(config.mcpServers['ai-bridge'].args,['/app/native-mcp.mjs','--dir',fakeData,'--tool','claude']);
  assert.equal(a.rulesPath,join(project,'CLAUDE.md'));
  const claudeRule=await readFile(a.rulesPath,'utf8');
  assert.match(claudeRule,/<<< Agents Calling bridge/);
  assert.match(claudeRule,/bridge_context works before bridge_open_session/);
  await mod.configureNativeTool({project,tool:'claude',dir:fakeData,nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs'});
  assert.equal(await readFile(a.rulesPath,'utf8'),claudeRule);
  await mkdir(join(project,'.cursor'),{recursive:true});
  await writeFile(join(project,'.cursor','cli.json'),JSON.stringify({permissions:{allow:['Shell(ls)'],deny:['Shell(rm)']},extra:true}));
  const b=await mod.configureNativeTool({project,tool:'cursor',dir:fakeData,nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs'});
  assert.equal(b.configPath,join(project,'.cursor','mcp.json'));
  assert.equal(b.permissionsPath,join(project,'.cursor','cli.json'));
  assert.equal(b.rulesPath,join(project,'.cursor','rules','agents-calling.mdc'));
  const cursorRule=await readFile(b.rulesPath,'utf8');
  assert.match(cursorRule,/alwaysApply: true/);
  assert.match(cursorRule,/Agents Calling bridge is available through MCP/);
  assert.match(b.instructions,/bridge_consult/);
  const permissions=JSON.parse(await readFile(b.permissionsPath,'utf8'));
  assert.equal(permissions.extra,true);
  assert.deepEqual(permissions.permissions.deny,['Shell(rm)']);
  assert.ok(permissions.permissions.allow.includes('Shell(ls)'));
  for(const name of ['bridge_context','bridge_list_peers','bridge_list_sessions'])
   assert.ok(permissions.permissions.allow.includes(`Mcp(ai-bridge:${name})`));
  for(const name of ['bridge_open_session','bridge_consult','bridge_consult_result','bridge_consult_stop'])
   assert.ok(!permissions.permissions.allow.includes(`Mcp(ai-bridge:${name})`));
  const readOnlyPermissions=await readFile(b.permissionsPath,'utf8');
  await mod.configureNativeTool({project,tool:'cursor',dir:fakeData,nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs'});
  assert.equal(await readFile(b.permissionsPath,'utf8'),readOnlyPermissions);
  await mod.configureNativeTool({project,tool:'cursor',dir:fakeData,nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs',allowConsult:true});
  const consultPermissions=JSON.parse(await readFile(b.permissionsPath,'utf8'));
  for(const name of ['bridge_context','bridge_list_peers','bridge_list_sessions','bridge_open_session','bridge_consult','bridge_consult_result','bridge_consult_stop'])
   assert.ok(consultPermissions.permissions.allow.includes(`Mcp(ai-bridge:${name})`));
  const permissionsText=await readFile(b.permissionsPath,'utf8');
  await mod.configureNativeTool({project,tool:'cursor',dir:fakeData,nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs',allowConsult:true});
  assert.equal(await readFile(b.permissionsPath,'utf8'),permissionsText);
  await mod.configureNativeTool({project,tool:'cursor',dir:fakeData,nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs'});
  const downgraded=JSON.parse(await readFile(b.permissionsPath,'utf8')).permissions.allow;
  for(const name of ['bridge_open_session','bridge_consult','bridge_consult_result','bridge_consult_stop'])
   assert.ok(!downgraded.includes(`Mcp(ai-bridge:${name})`));
  await writeFile(b.permissionsPath,JSON.stringify({permissions:{allow:['Shell(ls)']}}));
  await mod.configureNativeTool({project,tool:'cursor',dir:fakeData,nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs'});
  assert.deepEqual(JSON.parse(await readFile(b.permissionsPath,'utf8')).permissions.deny,[]);
  assert.ok(!JSON.stringify(config).includes('token'));assert.match(a.instructions,/原会话/);
  await assert.rejects(mod.configureNativeTool({project,tool:'unknown',dir:'/data'}),/Unsupported/);
  await writeFile(join(project,'.cursor','cli.json'),'{broken');
  await assert.rejects(mod.configureNativeTool({project,tool:'cursor',dir:'/data',nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs'}),/Cursor permissions/);
  assert.equal(await readFile(join(project,'.cursor','cli.json'),'utf8'),'{broken');
  await writeFile(join(project,'.mcp.json'),'{broken');
  await assert.rejects(mod.configureNativeTool({project,tool:'claude',dir:'/data'}),/JSON/);
  assert.equal(await readFile(join(project,'.mcp.json'),'utf8'),'{broken');
 }finally{await rm(project,{recursive:true,force:true});}
});

test('Codex configuration adds a user-level MCP server with narrow auto approval',async()=>{
 const mod=await import('../src/native/native-config.mjs');
 const home=await mkdtemp(join(tmpdir(),'bridge-codex-'));
 const configPath=join(home,'config.toml');
 try{
  await writeFile(configPath,'model = "existing"\n\n[model_providers.custom]\nname = "custom"\n');
  await writeFile(join(home,'AGENTS.md'),'# Existing instructions\n');
  const result=await mod.configureNativeTool({project:home,tool:'codex',dir:fakeData,nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs',codexConfigPath:configPath});
  const text=await readFile(configPath,'utf8');
  assert.equal(result.configPath,configPath);
  assert.equal(result.rulesPath,join(home,'AGENTS.md'));
  assert.match(text,/\[mcp_servers\.ai-bridge\]/);
  assert.match(text,/default_tools_approval_mode = "approve"/);
  assert.match(text,/tool_timeout_sec = 120/);
  assert.match(text,/--tool", "codex"/);
  assert.ok(text.includes(JSON.stringify(fakeData)));
  assert.match(text,/\[model_providers\.custom\]/);
  assert.equal((text.match(/\[mcp_servers\.ai-bridge\]/g)||[]).length,1);
  assert.match(await readFile(configPath+'.ai-bridge-backup','utf8'),/model = "existing"/);
  const agents=await readFile(result.rulesPath,'utf8');
  assert.match(agents,/^# Existing instructions/m);
  assert.equal((agents.match(/>>> Agents Calling bridge/g)||[]).length,1);
  assert.match(await readFile(result.rulesPath+'.ai-bridge-backup','utf8'),/^# Existing instructions/m);
  await mod.configureNativeTool({project:home,tool:'codex',dir:fakeData,nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs',codexConfigPath:configPath});
  assert.equal(await readFile(configPath,'utf8'),text);
  assert.equal(await readFile(result.rulesPath,'utf8'),agents);
  await writeFile(configPath,'mcp_servers = { ai-bridge = {} }\n');
  await assert.rejects(mod.configureNativeTool({project:home,tool:'codex',dir:'/data',nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs',codexConfigPath:configPath}),/inline/);
  assert.equal(await readFile(configPath,'utf8'),'mcp_servers = { ai-bridge = {} }\n');
 }finally{await rm(home,{recursive:true,force:true});}
});

test('DeepSeek Harness configuration appends one desktop MCP entry and stays idempotent',async()=>{
 const mod=await import('../src/native/native-config.mjs');
 const home=await mkdtemp(join(tmpdir(),'bridge-deepseek-config-'));
 const profile=join(home,'profiles','desktop'),configPath=join(profile,'cordis.patch.yml');
 try{
  await mkdir(profile,{recursive:true});
  await writeFile(configPath,'# existing profile patches\n- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n');
  const args={project:home,tool:'deepseek',dir:fakeData,nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs',dshHome:home};
  const result=await mod.configureNativeTool(args);
  const text=await readFile(configPath,'utf8');
  assert.equal(result.configPath,configPath);
  assert.match(text,/ui-chat/);
  assert.match(text,/id: ai-bridge-sibyl/);
  assert.match(text,/name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(text,/serverName: ai-bridge/);
  assert.match(text,/"--tool"/);
  assert.match(text,/"deepseek"/);
  assert.match(result.instructions,/projectPath/);
  assert.ok(text.includes(JSON.stringify(fakeData)));
  assert.doesNotMatch(text,/^\s*cwd:/m);
  assert.match(await readFile(configPath+'.ai-bridge-backup','utf8'),/ui-chat/);
  await mod.configureNativeTool(args);
  assert.equal(await readFile(configPath,'utf8'),text);
  await writeFile(configPath,'# empty\n[]\n');
  await mod.configureNativeTool(args);
  const empty=await readFile(configPath,'utf8');
  assert.match(empty,/# empty/);
  assert.match(empty,/- insert:/);
  assert.doesNotMatch(empty,/^\[\]$/m);
 }finally{await rm(home,{recursive:true,force:true});}
});

test('desktop-only configuration writes the desktop app config instead of a project file',async()=>{
 const mod=await import('../src/native/native-config.mjs');
 const project=await mkdtemp(join(tmpdir(),'bridge-desktop-project-'));
 const home=await mkdtemp(join(tmpdir(),'bridge-desktop-home-'));
 try{
  const claudePath=join(home,'claude_desktop_config.json');
  const claudeRulePath=join(home,'CLAUDE.md');
  const claude=await mod.configureNativeTool({project,tool:'claude',dir:fakeData,nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs',desktopOnly:true,desktopConfigPath:claudePath,rulePath:claudeRulePath});
  assert.equal(claude.configPath,claudePath);
  assert.equal(claude.rulesPath,claudeRulePath);
  const claudeConfig=JSON.parse(await readFile(claudePath,'utf8'));
  assert.equal(claudeConfig.mcpServers['ai-bridge'].type,'stdio');
  assert.deepEqual(claudeConfig.mcpServers['ai-bridge'].args,['/app/native-mcp.mjs','--dir',fakeData,'--tool','claude']);
  assert.match(claude.notice,/重启对应桌面应用/);
  assert.match(claude.instructions,/Claude Desktop/);
  if (process.platform === 'win32')
    assert.match(claude.instructions,/需要独立 Claude Code CLI/);
  else assert.match(claude.instructions,/无需单独安装 Claude Code CLI/);
  await assert.rejects(readFile(join(project,'.mcp.json')),{code:'ENOENT'});

  const cursorPath=join(home,'cursor-mcp.json');
  const cursorRulePath=join(home,'cursor-rule.mdc');
  const cursor=await mod.configureNativeTool({project,tool:'cursor',dir:fakeData,nodePath:'/app/node',scriptPath:'/app/native-mcp.mjs',desktopOnly:true,desktopConfigPath:cursorPath,rulePath:cursorRulePath});
  assert.equal(cursor.configPath,cursorPath);
  assert.equal(cursor.rulesPath,cursorRulePath);
  assert.deepEqual(JSON.parse(await readFile(cursorPath,'utf8')).mcpServers['ai-bridge'].args.slice(-2),['--tool','cursor']);
  assert.match(cursor.instructions,/Cursor Desktop/);
  if (process.platform === 'win32')
    assert.match(cursor.instructions,/需要 Cursor CLI/);
  else assert.match(cursor.instructions,/无需单独安装 Cursor CLI/);
  assert.equal(cursor.permissionsPath,null);
  await assert.rejects(readFile(join(project,'.cursor','mcp.json')),{code:'ENOENT'});
  await assert.rejects(readFile(join(project,'.cursor','cli.json')),{code:'ENOENT'});
 }finally{await rm(project,{recursive:true,force:true});await rm(home,{recursive:true,force:true});}
});
