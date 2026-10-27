import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {runProcess} from './bridge.mjs';

test('CLI pairing approval, real HTTP check, agent selection and human-directed discussion', {timeout:30000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'bridge-cli-'));
  const bin=join(dir,'bin');await mkdir(bin);
  const script=fileURLToPath(new URL('./bridge.mjs',import.meta.url));
  const fake=`#!/usr/bin/env node
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {basename,join} from 'node:path';
const name=basename(process.argv[1]),args=process.argv.slice(2),root=process.env.BRIDGE_TEST_DATA;
if(args.includes('--version')){console.log(name+' test-version');process.exit(0);}
let prompt='';if(name==='cursor-agent') prompt=args.at(-1);else for await(const chunk of process.stdin) prompt+=chunk;
appendFileSync(join(root,'calls'),name+'\\n');
let session;
if(name==='codex'&&args.includes('resume')) session=args[args.indexOf('resume')+1];
else if(args.includes('--resume')) session=args[args.indexOf('--resume')+1];
session ||=randomUUID();
const file=join(root,session),marker=prompt.match(/BRIDGE_[a-f0-9]+/)?.[0];
let result='Hello from '+name;
if(marker){writeFileSync(file,marker);result='OK';}
else if(prompt.includes('完整校验词')) result=readFileSync(file,'utf8');
if(name==='codex'){console.log(JSON.stringify({type:'thread.started',thread_id:session}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:result}}));console.log(JSON.stringify({type:'turn.completed'}));}
else console.log(JSON.stringify({session_id:session,result,is_error:false}));
`;
  for(const name of ['codex','claude','cursor-agent']) await writeFile(join(bin,name),fake,{mode:0o755});
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const oldPath=process.env.PATH,oldData=process.env.BRIDGE_TEST_DATA;
  process.env.PATH=bin+':'+dirname(process.execPath)+':/usr/bin:/bin';process.env.BRIDGE_TEST_DATA=dir;
  const server=spawn(process.execPath,[script,'serve','--state',join(dir,'state'),'--project',dir,'--port',String(port)],{stdio:['pipe','pipe','pipe']});
  let output='',approved=false;
  server.stdout.on('data',data=>{output+=data;const id=output.match(/approve ([a-f0-9-]{36})/)?.[1];if(id&&!approved){approved=true;server.stdin.write('approve '+id+'\n');}});
  const waitFor=async pattern=>{for(let i=0;i<100;i++){if(pattern.test(output)) return;await new Promise(r=>setTimeout(r,30));}throw Error('Server did not become ready: '+output);};
  try{
    await waitFor(/一次性配对码.*\d{8}/);
    const code=output.match(/一次性配对码[^\n]*?(\d{8})/)[1];
    const connection=join(dir,'connection.json'),base=['--connection',connection,'--project',dir];
    const run=(args)=>runProcess(process.execPath,[script,...args],{cwd:dir,timeout:15000});
    assert.match(await run(['pair','--url',`http://127.0.0.1:${port}`,'--code',code,'--name','Test Mac',...base]),/配对成功/);
    const credential=JSON.parse(await readFile(connection,'utf8'));assert.equal(credential.token.length,64);
    await assert.rejects(readFile(join(dir,'calls')), {code:'ENOENT'});
    assert.match(await run(['diagnose','--remote-agent','claude',...base]),/收到对方 AI 回复/);
    assert.equal((await readFile(join(dir,'calls'),'utf8')).trim().split('\n').length,1);
    assert.match(await run(['check','--remote-agent','cursor','--local-agent','codex',...base]),/等待人工目标/);
    assert.equal((await readFile(join(dir,'calls'),'utf8')).trim().split('\n').length,5);
    await assert.rejects(run(['discuss','--remote-agent','claude',...base]),/explicit human goal/);
    assert.equal((await readFile(join(dir,'calls'),'utf8')).trim().split('\n').length,5);
    const log=join(dir,'discussion.jsonl');
    assert.match(await run(['discuss','--remote-agent','claude','--local-agent','codex','--goal','Introduce yourselves','--room','introductions','--rounds','2','--log',log,...base]),/等待下一条/);
    const lines=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map(x=>x.agent),['codex','claude','codex','claude','codex']);
    assert.equal(lines[0].session,lines[2].session);
    assert.equal(lines[0].session,lines[4].session);
    assert.equal((await readFile(join(dir,'calls'),'utf8')).trim().split('\n').length,10);
  }finally{
    server.kill('SIGTERM');await new Promise(r=>server.once('close',r));
    if(oldPath===undefined) delete process.env.PATH;else process.env.PATH=oldPath;
    if(oldData===undefined) delete process.env.BRIDGE_TEST_DATA;else process.env.BRIDGE_TEST_DATA=oldData;
    await rm(dir,{recursive:true,force:true});
  }
});
