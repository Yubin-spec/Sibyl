import test from 'node:test';
import assert from 'node:assert/strict';
import {CODEX_MODELS,chooseCodexModel} from './model-policy.mjs';

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
