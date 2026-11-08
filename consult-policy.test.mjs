import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_CONSULT_LIMITS,consultFingerprint,findDuplicate,checkBudget,checkParallel,checkProgress,DEFAULT_WORKER_LIMITS,normalizeWorkerLimits,workerTurnTimeoutMs,checkWorkerCapacity} from './consult-policy.mjs';

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

test('worker tiers do not reuse the consult budget',()=>{
  const limits=normalizeWorkerLimits();
  assert.equal(limits.consult.maxDurationMs,15*60*1000);
  assert.equal(limits.consult.maxLivePerSession,2);
  assert.equal(limits.dispatch.maxDurationMs,30*60*1000);
  assert.equal(limits.dispatch.noProgressMs,15*60*1000);
  assert.equal(limits.dispatch.maxLivePerSession,1);
  assert.equal(limits.parallel.maxDurationMs,60*60*1000);
  assert.equal(limits.parallel.maxLivePerSession,3);
  assert.notEqual(limits.dispatch.maxDurationMs,180000);
  assert.notEqual(limits.dispatch.noProgressMs,120000);
  assert.equal(workerTurnTimeoutMs('consult'),600000);
  assert.equal(workerTurnTimeoutMs('dispatch'),600000);
  assert.throws(()=>workerTurnTimeoutMs('unknown'),/tier must be consult, dispatch or parallel/);
});

test('invalid worker limits are rejected',()=>{
  assert.throws(()=>normalizeWorkerLimits({dispatch:{maxPerWindow:0}}),/Invalid worker limit: maxPerWindow/);
  assert.throws(()=>normalizeWorkerLimits({parallel:{maxDurationMs:1.5}}),/Invalid worker limit: maxDurationMs/);
  assert.throws(()=>normalizeWorkerLimits({meeting:{}}),/Invalid worker limit tier: meeting/);
});

const worker=(id,over={})=>({id,sourceSessionId:'s',projectPath:'/p',status:'running',startedAt:new Date().toISOString(),...over});

test('a dispatch session may have only one live worker',()=>{
  const limits=normalizeWorkerLimits();
  const records=[worker('a'),worker('b')];
  const blocked=checkWorkerCapacity(records,{sourceSessionId:'s',projectPath:'/p',tier:'dispatch',now:Date.now(),limits:limits.dispatch});
  assert.equal(blocked.allow,false);
  assert.equal(blocked.reason,'live-session');
  const single=checkWorkerCapacity([worker('a')],{sourceSessionId:'s',projectPath:'/p',tier:'dispatch',now:Date.now(),limits:limits.dispatch});
  assert.equal(single.allow,false);
  assert.equal(checkWorkerCapacity([],{sourceSessionId:'s',projectPath:'/p',tier:'dispatch',now:Date.now(),limits:limits.dispatch}).allow,true);
});

test('parallel capacity counts live workers per project',()=>{
  const limits=normalizeWorkerLimits().parallel;
  const records=[worker('a',{sourceSessionId:'other',projectPath:'/p'}),worker('b',{sourceSessionId:'other',projectPath:'/p'}),worker('c',{sourceSessionId:'other',projectPath:'/p'}),worker('d',{sourceSessionId:'other',projectPath:'/p'})];
  const city=checkWorkerCapacity(records,{sourceSessionId:'s',projectPath:'/p',tier:'parallel',now:Date.now(),limits});
  assert.equal(city.reason,'live-project');
  assert.equal(checkWorkerCapacity(records.slice(0,3),{sourceSessionId:'s',projectPath:'/p',tier:'parallel',now:Date.now(),limits}).allow,true);
});

test('the rolling window budget stops runaway dispatch',()=>{
  const limits={...normalizeWorkerLimits().dispatch,maxPerWindow:2};
  const now=Date.now();
  const records=[worker('a',{status:'completed',startedAt:new Date(now-1000).toISOString()}),worker('b',{status:'completed',startedAt:new Date(now-2000).toISOString()})];
  const result=checkWorkerCapacity(records,{sourceSessionId:'s',projectPath:'/p',tier:'dispatch',now,limits});
  assert.equal(result.allow,false);
  assert.equal(result.reason,'budget');
});
