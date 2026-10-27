import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeClaudeDebug} from './claude-diagnostics.mjs';

test('diagnostics report API failure classes without exposing log contents or credentials',()=>{
  const raw='[DEBUG] Authorization: Bearer secret-value\n[DEBUG] [API REQUEST] /v1/messages source=sdk\n[ERROR] API error (attempt 1/11): 429 rate limit api_key=secret-value\n[ERROR] API error (attempt 2/11): undefined Connection error.\n[DEBUG] cause: ECONNREFUSED\n[ERROR] API error (attempt 3/11): 401 invalid token secret-value\n';
  const result=summarizeClaudeDebug(raw);
  assert.deepEqual(result.httpStatuses,[401,429]);
  assert.equal(result.connectionErrors,1);
  assert.deepEqual(result.networkCodes,['ECONNREFUSED']);
  assert.equal(result.apiAttempts,3);
  assert.equal(result.apiRequests,1);
  assert.ok(!JSON.stringify(result).includes('secret-value'));
});

test('successful or startup-only logs do not invent a model API failure',()=>{
  assert.deepEqual(summarizeClaudeDebug('[DEBUG] initializing plugins'),{httpStatuses:[],connectionErrors:0,networkCodes:[],apiAttempts:0,apiRequests:0});
});
