import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_CONSULT_LIMITS,consultFingerprint,findDuplicate,checkBudget,checkParallel,checkProgress} from '../src/bridge/consult-policy.mjs';

const now=1_700_000_000_000;
const base={sourceSessionId:'source',targetTool:'claude',targetProjectId:'target',threadId:'thread',status:'completed',startedAt:new Date(now-1000).toISOString(),lastProgressAt:new Date(now-1000).toISOString()};

test('fingerprint ignores whitespace but separates tools and projects',()=>{
 const a=consultFingerprint({...base,text:'  verify   parser '}),b=consultFingerprint({...base,text:'verify parser'}),c=consultFingerprint({...base,targetTool:'codex',text:'verify parser'});
 assert.equal(a,b);assert.notEqual(a,c);
});

test('duplicate lookup only reuses recent records',()=>{
 const record={...base,text:'verify',fingerprint:'same'};
 assert.equal(findDuplicate([record],{fingerprint:'same',now,windowMs:5000}),record);
 assert.equal(findDuplicate([record],{fingerprint:'same',now:now+6000,windowMs:5000}),null);
 assert.equal(findDuplicate([{...record,status:'failed'}],{fingerprint:'same',now,windowMs:5000}),null);
});

test('budget counts only the same source session in the window',()=>{
 const records=[{...base,id:'a'},{...base,id:'b'},{...base,id:'c',sourceSessionId:'other'}];
 assert.equal(checkBudget(records,{sourceSessionId:'source',now,limits:{...DEFAULT_CONSULT_LIMITS,maxPerWindow:2}}).allow,false);
 assert.equal(checkBudget(records,{sourceSessionId:'source',now,limits:{...DEFAULT_CONSULT_LIMITS,maxPerWindow:3}}).allow,true);
});

test('parallel cap is per target tool and project',()=>{
 const records=[{...base,status:'running'},{...base,status:'running'},{...base,targetProjectId:'other',status:'running'}];
 const limits={...DEFAULT_CONSULT_LIMITS,maxParallelPerTarget:2};
 assert.equal(checkParallel(records,{targetTool:'claude',targetProjectId:'target',limits}).allow,false);
 assert.equal(checkParallel(records,{targetTool:'claude',targetProjectId:'other',limits}).allow,true);
});

test('watchdog stops on no progress and absolute duration',()=>{
 const limits={...DEFAULT_CONSULT_LIMITS,noProgressMs:1000,maxDurationMs:5000};
 assert.deepEqual(checkProgress({...base,startedAt:new Date(now).toISOString(),lastProgressAt:new Date(now).toISOString()},{now:now+500,limits}).stalled,false);
 assert.equal(checkProgress({...base,startedAt:new Date(now).toISOString(),lastProgressAt:new Date(now).toISOString()},{now:now+1500,limits}).reason,'stalled');
 assert.equal(checkProgress({...base,startedAt:new Date(now-6000).toISOString(),lastProgressAt:new Date(now).toISOString()},{now,limits}).reason,'timeout');
});
