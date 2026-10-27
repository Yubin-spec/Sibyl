import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
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
