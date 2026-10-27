import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {openNativeInbox} from './native-inbox.mjs';
import {createBridge} from './bridge.mjs';

function client(dir,tool){
 const child=spawn(process.execPath,[fileURLToPath(new URL('./native-mcp.mjs',import.meta.url)),'--dir',dir,'--tool',tool],{stdio:['pipe','pipe','pipe']});
 const pending=new Map();let serial=0,stderr='';child.stderr.on('data',b=>stderr+=b);
 createInterface({input:child.stdout}).on('line',line=>{const value=JSON.parse(line);const p=pending.get(value.id);if(p){pending.delete(value.id);value.error?p.reject(Error(value.error.message)):p.resolve(value.result);}});
 child.on('close',()=>{for(const p of pending.values())p.reject(Error('MCP exited: '+stderr));pending.clear();});
 return {async call(method,params={}){const id=++serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('MCP tool timeout'));},5000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});},async tool(name,args={}){const value=await this.call('tools/call',{name,arguments:args});if(value.isError)throw Error(value.content[0].text);return JSON.parse(value.content[0].text);},async close(){if(child.exitCode!==null)return;child.stdin.end();await new Promise(r=>child.once('close',r));}};
}

test('MCP answer returns on the original ask call and stays isolated from another chat',async()=>{
 const root=await mkdtemp(join(tmpdir(),'bridge-mcp-'));const aDir=join(root,'a'),bDir=join(root,'b');
 const a=await openNativeInbox({dir:aDir}),b=await openNativeInbox({dir:bDir});
 const host=await createBridge({dir:join(root,'host'),project:null,token:'paired-secret',nativeInbox:b});
 await new Promise(r=>host.server.listen(0,'127.0.0.1',r));
 const connectionId=randomUUID();await mkdir(join(aDir,'connections'));await writeFile(join(aDir,'connections',connectionId+'.json'),JSON.stringify({url:'http://127.0.0.1:'+host.server.address().port,token:'paired-secret',name:'B'}));
 const sender=client(aDir,'claude'),receiver=client(bDir,'cursor');
 try{
  const init=await sender.call('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}});
  assert.equal(init.serverInfo.name,'ai-bridge');
  const listed=await sender.call('tools/list');assert.ok(listed.tools.some(t=>t.name==='bridge_ask'));
  const source=await sender.tool('bridge_open_session',{title:'Source original task'});
  const target=await receiver.tool('bridge_open_session',{title:'Receiver original task'});
  const other=await receiver.tool('bridge_open_session',{title:'Unrelated task'});
  assert.equal((await sender.tool('bridge_list_peers')).peers[0].id,connectionId);
  assert.equal((await sender.tool('bridge_list_sessions',{connectionId})).sessions[0].id,target.id);
  const receiving=receiver.tool('bridge_receive',{sessionId:target.id,waitMs:3000});
  const asking=sender.tool('bridge_ask',{sessionId:source.id,connectionId,targetSessionId:target.id,text:'Which identifier should I use?',waitMs:3000});
  const received=await receiving;assert.equal(received.messages[0].text,'Which identifier should I use?');
  const q=received.messages[0];
  await assert.rejects(receiver.tool('bridge_reply',{sessionId:other.id,questionId:q.id,peerId:q.peerId,text:'wrong'}),/Question/);
  await receiver.tool('bridge_reply',{sessionId:target.id,questionId:q.id,peerId:q.peerId,text:'Use account_id.'});
  const answer=await asking;
  assert.equal(answer.answer,'Use account_id.');assert.equal(answer.source.id,source.id);assert.equal(answer.targetSessionId,target.id);
  assert.deepEqual((await receiver.tool('bridge_receive',{sessionId:other.id,waitMs:0})).messages,[]);
  const foreign=client(aDir,'claude');try{await assert.rejects(foreign.tool('bridge_receive',{sessionId:source.id}),/this MCP/);}finally{await foreign.close();}
 }finally{await sender.close();await receiver.close();await new Promise(r=>host.server.close(r));await a.close();await b.close();await rm(root,{recursive:true,force:true});}
});

test('a polling failure returns the submitted question ID for recovery without resending',async()=>{
 const http=await import('node:http');let submitted;
 const server=http.createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.method==='POST'){let body='';for await(const b of req)body+=b;submitted=JSON.parse(body);res.end(JSON.stringify({id:submitted.id,status:'queued'}));}else{res.writeHead(503);res.end(JSON.stringify({error:'receiver temporarily unavailable'}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const dir=await mkdtemp(join(tmpdir(),'bridge-mcp-recovery-')),inbox=await openNativeInbox({dir});await mkdir(join(dir,'connections'));const id=randomUUID();await writeFile(join(dir,'connections',id+'.json'),JSON.stringify({url:'http://127.0.0.1:'+server.address().port,token:'secret'}));
 const sender=client(dir,'claude');
 try{const s=await sender.tool('bridge_open_session',{title:'source'});await assert.rejects(sender.tool('bridge_ask',{sessionId:s.id,connectionId:id,targetSessionId:'target',text:'question',waitMs:0}),e=>e.message.includes(submitted.id)&&e.message.includes('bridge_result'));}
 finally{await sender.close();await inbox.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
