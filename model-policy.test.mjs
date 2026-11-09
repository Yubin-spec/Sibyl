import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {CODEX_MODELS,DEFAULT_CODEX_POLICY,chooseCodexModel,normalizeModelPolicy,loadModelPolicy} from './model-policy.mjs';

test('the advertised Codex models are known',()=>{
  for(const m of ['gpt-6.1-sol','gpt-6-astra','gpt-6.1-terra','gpt-6-luna'])assert.ok(CODEX_MODELS.includes(m),m);
});

test('mechanical work uses the cheap fast model',()=>{
  assert.deepEqual(chooseCodexModel({tier:'dispatch',kind:'mechanical'}),{model:'gpt-6-luna',effort:'low',reason:'mechanical'});
});

test('normal review uses the balanced model, high-risk review escalates',()=>{
  assert.deepEqual(chooseCodexModel({tier:'consult',kind:'review'}),{model:'gpt-6.1-terra',effort:'medium',reason:'review'});
  assert.deepEqual(chooseCodexModel({tier:'consult',kind:'review',risk:'high'}),{model:'gpt-6.1-sol',effort:'high',reason:'review-high-risk'});
});

test('implementation uses the workhorse at medium and escalates by risk',()=>{
  assert.deepEqual(chooseCodexModel({tier:'dispatch',kind:'implement'}),{model:'gpt-6.1-sol',effort:'medium',reason:'implement'});
  assert.deepEqual(chooseCodexModel({tier:'parallel',kind:'implement',risk:'high'}),{model:'gpt-6.1-sol',effort:'high',reason:'implement-high-risk'});
});

test('frontier work alone uses Astra',()=>{
  assert.deepEqual(chooseCodexModel({kind:'frontier'}),{model:'gpt-6-astra',effort:'high',reason:'frontier'});
});

test('tier picks a sensible default kind and unknown values are rejected',()=>{
  assert.equal(chooseCodexModel({tier:'consult'}).model,'gpt-6.1-terra');
  assert.equal(chooseCodexModel({tier:'dispatch'}).model,'gpt-6.1-sol');
  assert.throws(()=>chooseCodexModel({kind:'unknown'}),/kind must be review, implement, mechanical or frontier/);
  assert.throws(()=>chooseCodexModel({risk:'unknown'}),/risk must be normal or high/);
});

test('the default policy reproduces every current choice',()=>{
  const cases=[
    [{tier:'dispatch',kind:'mechanical'},{model:'gpt-6-luna',effort:'low',reason:'mechanical'}],
    [{tier:'consult',kind:'review'},{model:'gpt-6.1-terra',effort:'medium',reason:'review'}],
    [{tier:'consult',kind:'review',risk:'high'},{model:'gpt-6.1-sol',effort:'high',reason:'review-high-risk'}],
    [{tier:'dispatch',kind:'implement'},{model:'gpt-6.1-sol',effort:'medium',reason:'implement'}],
    [{tier:'parallel',kind:'implement',risk:'high'},{model:'gpt-6.1-sol',effort:'high',reason:'implement-high-risk'}],
    [{kind:'frontier'},{model:'gpt-6-astra',effort:'high',reason:'frontier'}]
  ];
  for(const [input,expected] of cases)assert.deepEqual(chooseCodexModel({...input,policy:DEFAULT_CODEX_POLICY}),expected);
});

test('a project policy overrides one leaf and leaves the rest intact',()=>{
  const policy=normalizeModelPolicy({version:1,codex:{implement:{normal:{model:'gpt-6-luna'}}}});
  assert.deepEqual(chooseCodexModel({tier:'dispatch',kind:'implement',policy}),
    {model:'gpt-6-luna',effort:'medium',reason:'project:implement'});
  assert.deepEqual(chooseCodexModel({tier:'dispatch',kind:'implement',risk:'high',policy}),
    {model:'gpt-6.1-sol',effort:'high',reason:'implement-high-risk'});
  assert.deepEqual(chooseCodexModel({tier:'consult',kind:'review',policy}),
    {model:'gpt-6.1-terra',effort:'medium',reason:'review'});
});

test('an overridden effort alone keeps the default model',()=>{
  const policy=normalizeModelPolicy({version:1,codex:{review:{high:{effort:'ultra'}}}});
  assert.deepEqual(chooseCodexModel({tier:'consult',kind:'review',risk:'high',policy}),
    {model:'gpt-6.1-sol',effort:'ultra',reason:'project:review-high-risk'});
});

test('invalid policy values are rejected with the offending key',()=>{
  assert.throws(()=>normalizeModelPolicy(null),/policy/i);
  assert.throws(()=>normalizeModelPolicy({version:2}),/version/i);
  assert.throws(()=>normalizeModelPolicy({version:1,codex:{unknown:{model:'x'}}}),/unknown/);
  assert.throws(()=>normalizeModelPolicy({version:1,codex:{mechanical:{model:''}}}),/mechanical\.model/);
  assert.throws(()=>normalizeModelPolicy({version:1,codex:{mechanical:{effort:'max'}}}),/mechanical\.effort/);
  assert.throws(()=>normalizeModelPolicy({version:1,codex:{review:{model:'x'}}}),/review/);
});

test('a missing project policy falls back to defaults',async()=>{
  const readFile=async()=>{const error=Error('missing');error.code='ENOENT';throw error;};
  const result=await loadModelPolicy('C:/p',{readFile});
  assert.equal(result.configured,false);
  assert.deepEqual(result.policy,DEFAULT_CODEX_POLICY);
});

test('a project policy is loaded and marked configured',async()=>{
  const readFile=async()=>JSON.stringify({version:1,codex:{mechanical:{model:'gpt-6.1-terra'}}});
  const result=await loadModelPolicy('C:/p',{readFile});
  assert.equal(result.configured,true);
  assert.equal(chooseCodexModel({kind:'mechanical',policy:result.policy}).model,'gpt-6.1-terra');
});

test('a broken project policy fails loudly with its full path',async()=>{
  const expected=join('C:/p','.sibyl','models.json');
  const bad=async()=>'{not json';
  await assert.rejects(()=>loadModelPolicy('C:/p',{readFile:bad}),
    error=>error.message.includes('Invalid model policy')&&error.message.includes(expected));
  const invalid=async()=>JSON.stringify({version:2});
  await assert.rejects(()=>loadModelPolicy('C:/p',{readFile:invalid}),
    error=>error.message.includes(expected)&&error.message.includes('version'));
});
