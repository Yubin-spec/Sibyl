import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runProcess,agentRunner,detectAgents} from './bridge.mjs';

const runtime=()=>import('./runtime.mjs');
async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'sibyl runtime 中文 '));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  return dir;
}
async function npmBin(dir,{name='fake-agent',command='claude',entry='cli.mjs',source=''}={}) {
  const root=join(dir,'node_modules',name);
  await mkdir(root,{recursive:true});
  await writeFile(join(root,'package.json'),JSON.stringify({name,bin:{[command]:entry}}));
  await writeFile(join(root,entry),source);
  await writeFile(join(dir,command+'.cmd'),'@echo off\r\necho THIS_BATCH_MUST_NOT_RUN\r\n');
  return join(root,entry);
}

test('data directories follow Windows, macOS and XDG conventions without requiring HOME',async()=>{
  const {defaultDataDir}=await runtime();
  assert.equal(defaultDataDir({platform:'win32',env:{LOCALAPPDATA:'C:\\Users\\Helen\\AppData\\Local'},home:'C:\\Users\\Helen'}),'C:\\Users\\Helen\\AppData\\Local\\AI Bridge');
  assert.equal(defaultDataDir({platform:'win32',env:{},home:'C:\\Users\\Helen'}),'C:\\Users\\Helen\\AppData\\Local\\AI Bridge');
  assert.equal(defaultDataDir({platform:'darwin',env:{},home:'/Users/helen'}),'/Users/helen/Library/Application Support/AI Bridge');
  assert.equal(defaultDataDir({platform:'linux',env:{XDG_DATA_HOME:'/data'},home:'/home/helen'}),'/data/ai-bridge');
  assert.equal(defaultDataDir({platform:'linux',env:{},home:'/home/helen'}),'/home/helen/.local/share/ai-bridge');
});

test('Windows PATH discovery resolves npm native executables without running a batch file',async t=>{
  const {resolveExecutable}=await runtime(),dir=await fixture(t);
  const native=await npmBin(dir,{name:'@anthropic-ai/claude-code',entry:'claude.exe'});
  assert.deepEqual(await resolveExecutable('claude',{platform:'win32',env:{Path:dir}}),{command:native,args:[]});
});

test('Windows npm JavaScript entry uses the selected Node executable with argv preserved',async t=>{
  const {resolveExecutable}=await runtime(),dir=await fixture(t);
  const entry=await npmBin(dir,{command:'codex',source:'console.log(JSON.stringify(process.argv.slice(2)))'});
  const resolved=await resolveExecutable('codex',{platform:'win32',env:{PATH:dir},nodePath:process.execPath});
  assert.deepEqual(resolved,{command:process.execPath,args:[entry]});
  const literal='中文 space & echo UNEXPECTED $(bad) %PATH%';
  assert.deepEqual(JSON.parse(await runProcess(resolved.command,[...resolved.args,literal])),[literal]);
});

test('unsupported batch wrappers are rejected and cannot run shell content',async t=>{
  const {resolveExecutable}=await runtime(),dir=await fixture(t);
  await writeFile(join(dir,'untrusted.cmd'),'@echo off\r\necho unsafe\r\n');
  await assert.rejects(resolveExecutable(join(dir,'untrusted.cmd'),{platform:'win32',env:{PATH:dir}}),/unsupported|npm|batch/i);
});

test('PATH discovery skips unsupported wrappers to find a later native executable',async t=>{
  const {resolveExecutable}=await runtime(),dir=await fixture(t),later=join(dir,'later');
  await mkdir(later);
  await writeFile(join(dir,'codex.cmd'),'@echo off\r\necho custom wrapper');
  const native=join(later,'codex.exe');await writeFile(native,'native fixture');
  assert.deepEqual(await resolveExecutable('codex',{platform:'win32',env:{PATH:dir+';'+later}}),{command:native,args:[]});
});

test('Windows installer batch wrappers resolve to their quoted native executable',async t=>{
  const {resolveExecutable}=await runtime(),dir=await fixture(t),native=join(dir,'codex.exe');
  await writeFile(native,'native fixture');
  await writeFile(join(dir,'codex.cmd'),'@echo off\r\n"'+native+'" %*\r\n');
  assert.deepEqual(await resolveExecutable('codex',{platform:'win32',env:{PATH:dir}}),{command:native,args:[]});
});

test('Windows bash shims resolve their exec target without running the shell',async t=>{
  const {resolveExecutable}=await runtime(),dir=await fixture(t),native=join(dir,'codex.exe');
  await writeFile(native,'native fixture');
  await writeFile(join(dir,'codex'),'#!/usr/bin/env bash\nexec "'+native+'" "$@"\n');
  assert.deepEqual(await resolveExecutable('codex',{platform:'win32',env:{PATH:dir}}),{command:native,args:[]});
});

test('shim targets that are not native executables stay rejected',async t=>{
  const {resolveExecutable}=await runtime(),dir=await fixture(t);
  await writeFile(join(dir,'script.bat'),'@echo off\r\necho unsafe\r\n');
  await writeFile(join(dir,'codex'),'#!/usr/bin/env bash\nexec "'+join(dir,'script.bat')+'" "$@"\n');
  await assert.rejects(resolveExecutable('codex',{platform:'win32',env:{PATH:dir}}),/unsupported|executable|npm|batch/i);
});

test('shell shims with extra control flow are not followed',async t=>{
  const {resolveExecutable}=await runtime(),dir=await fixture(t),native=join(dir,'other.exe');
  await writeFile(native,'native fixture');
  await writeFile(join(dir,'codex'),'#!/bin/sh\nexit 0\nexec "'+native+'" "$@"\n');
  await assert.rejects(resolveExecutable('codex',{platform:'win32',env:{PATH:dir}}),/unsupported|executable|npm|batch/i);
});

test('Windows merges provider settings into a case-insensitive environment',async t=>{
  const {agentEnv}=await runtime(),dir=await fixture(t),file=join(dir,'settings.json');
  await writeFile(file,JSON.stringify({env:{PATH:'C:\\settings'}}));
  const merged=await agentEnv('claude',{Path:'C:\\shell',OTHER:'1'},{SIBYL_CLAUDE_SETTINGS:file},'win32');
  assert.equal(merged.PATH,'C:\\settings');
  assert.equal('Path' in merged,false);
  assert.equal(merged.OTHER,'1');
});

test('Claude provider settings override the launching environment',async t=>{
  const {agentEnv}=await runtime(),dir=await fixture(t),file=join(dir,'settings.json');
  await writeFile(file,JSON.stringify({env:{ANTHROPIC_BASE_URL:'http://proxy',ANTHROPIC_AUTH_TOKEN:'token',PATH:'/settings/path',BAD_KEY:42}}));
  const merged=await agentEnv('claude',{PATH:'/shell/path',ANTHROPIC_BASE_URL:'http://stale'},{SIBYL_CLAUDE_SETTINGS:file});
  assert.equal(merged.ANTHROPIC_BASE_URL,'http://proxy');
  assert.equal(merged.ANTHROPIC_AUTH_TOKEN,'token');
  assert.equal(merged.PATH,'/settings/path');
  assert.equal('BAD_KEY' in merged,false);
  assert.deepEqual(await agentEnv('codex',{A:'1'},{SIBYL_CLAUDE_SETTINGS:file}),{A:'1'});
  assert.deepEqual(await agentEnv('claude',{SIBYL_CLAUDE_SETTINGS:join(dir,'missing.json')}),{SIBYL_CLAUDE_SETTINGS:join(dir,'missing.json')});
});

test('an explicit Node script need not have POSIX execute permission',async t=>{
  const {resolveExecutable}=await runtime(),dir=await fixture(t),entry=join(dir,'entry.mjs');
  await writeFile(entry,'console.log("entry")',{mode:0o600});
  assert.deepEqual(await resolveExecutable(entry,{platform:'linux'}),{command:process.execPath,args:[entry]});
});

test('npm bin metadata cannot escape its package directory',async t=>{
  const {resolveExecutable}=await runtime(),dir=await fixture(t),root=join(dir,'node_modules','escape');
  await mkdir(root,{recursive:true});
  await writeFile(join(root,'package.json'),JSON.stringify({name:'escape',bin:{claude:'../../outside.mjs'}}));
  await writeFile(join(dir,'outside.mjs'),'console.log("unsafe")');
  await writeFile(join(dir,'claude.cmd'),'@echo off');
  await assert.rejects(resolveExecutable('claude',{platform:'win32',env:{PATH:dir}}),/unsupported|npm|outside|escape/i);
});

test('explicit agent paths and environment settings override PATH and fail closed',async t=>{
  const {resolveAgentExecutable}=await runtime(),dir=await fixture(t),explicit=join(dir,'chosen.exe');
  await writeFile(explicit,'native fixture');
  assert.deepEqual(await resolveAgentExecutable('claude',{platform:'win32',executables:{claude:explicit},env:{PATH:'',SIBYL_CLAUDE_PATH:'missing.exe'}}),{command:explicit,args:[]});
  assert.deepEqual(await resolveAgentExecutable('claude',{platform:'win32',env:{PATH:'',SIBYL_CLAUDE_PATH:explicit}}),{command:explicit,args:[]});
  await assert.rejects(resolveAgentExecutable('claude',{executables:{claude:join(dir,'missing.exe')}}),{code:'ENOENT'});
});

test('POSIX executable paths still launch without an implicit shell',async()=>{
  const {resolveExecutable}=await runtime();
  assert.deepEqual(await resolveExecutable(process.execPath,{platform:'linux'}),{command:process.execPath,args:[]});
});

test('an already cancelled run never attempts executable discovery or spawning',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(runProcess('SIBYL_MISSING_EXECUTABLE_FOR_CANCEL_TEST',[],{signal:controller.signal}),/cancelled/);
});

test('agent execution and detection share explicit executable configuration',async t=>{
  const dir=await fixture(t),entry=join(dir,'fake claude.mjs');
  await writeFile(entry,`if(process.argv.includes('--version')) console.log('fixture 1.0');else {let prompt='';for await(const chunk of process.stdin)prompt+=chunk;console.log(JSON.stringify({session_id:'kept-session',result:prompt,is_error:false}));}`);
  const options={executables:{claude:entry,codex:join(dir,'missing.exe'),cursor:join(dir,'missing.exe')}};
  assert.deepEqual(await agentRunner('claude','literal prompt',null,undefined,dir,options),{session_id:'kept-session',result:'literal prompt',cost:undefined});
  assert.deepEqual(await detectAgents(options),{claude:'fixture 1.0'});
});

test('timing out a process also stops its child process', {timeout:15000},async()=>{
  let descendant;
  const script=`import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000);`;
  const running=runProcess(process.execPath,['--input-type=module','-e',script],{timeout:1500,onOutput:text=>{descendant=Number(text.trim());}});
  try {
    await assert.rejects(running,/timed out/);
    assert.ok(Number.isInteger(descendant)&&descendant>0,'descendant started before timeout');
    let alive=true;
    for(let i=0;i<50;i++) {try{process.kill(descendant,0);}catch{alive=false;break;}await new Promise(r=>setTimeout(r,20));}
    assert.equal(alive,false,'descendant must not outlive the timed out process');
  } finally {if(descendant)try{process.kill(descendant,'SIGKILL');}catch{}}
});
