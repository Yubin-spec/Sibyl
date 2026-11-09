import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {workerFixture} from './worker-test-support.mjs';

test('control wires hook context to project questions without marking them read',async()=>{
  const f=await workerFixture('write');
  try{
    const runtime=JSON.parse(await readFile(join(f.dir,'native-runtime.json'),'utf8'));
    const post=async(path,body)=>{const response=await fetch(new URL(path,runtime.url),{method:'POST',headers:{authorization:'Bearer '+runtime.token,'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
    const a=await post('/register',{tool:'claude',title:'A',projectPath:f.project,nativeSessionId:'A'});
    const b=await post('/register',{tool:'claude',title:'B',projectPath:f.project,nativeSessionId:'B'});
    await post('/ask',{id:a.id,lease:a.lease,questionId:'q1',targetSessionId:a.id,text:'SECRET-TO-A'});
    await post('/ask',{id:a.id,lease:a.lease,questionId:'q2',targetSessionId:b.id,text:'SECRET-TO-B'});

    const context=await post('/hook/context',{protocol:'hook-context/v1',event:'session-start',projectPath:f.project,nativeSessionId:'A'});
    assert.match(context.text,/待答问题 2 条：当前会话 1 条、本工具其他会话 1 条、其他工具 0 条/);
    assert.ok(!context.text.includes('SECRET-TO-A'));
    assert.ok(!context.text.includes('SECRET-TO-B'));

    const received=await post('/receive',{id:a.id,lease:a.lease,waitMs:0});
    assert.deepEqual(received.messages.map(message=>message.id),['q1']);

    const state=await f.call('/api/status');
    assert.equal(state.nativeInbox.pendingCount,2);
    assert.equal(state.nativeInbox.questionsTotal,2);
  }finally{await f.close();}
});
