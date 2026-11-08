import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_SHARED_FILES,normalizeScope,pathWithin,scopeOverlaps,isSharedPath,scopeSharedConflicts,findLeaseConflict,checkPaths} from './path-scope.mjs';

test('scope is normalized and dangerous paths are refused',()=>{
  assert.deepEqual(normalizeScope(['./src\\api/','docs']),['src/api','docs']);
  for(const bad of [[],['./'],['/etc'],['C:/x'],['../x'],['src/../x'],['.git'],['.sibyl'],[''],123])
    assert.throws(()=>normalizeScope(bad),/scope must be a non-empty array|Invalid scope path/);
});

test('overlap respects path segment boundaries',()=>{
  assert.equal(pathWithin('src/a','src/a/b.txt'),true);
  assert.equal(scopeOverlaps(['src/a'],['src/a/b']),true);
  assert.equal(scopeOverlaps(['src/a'],['src/ab']),false);
  assert.equal(scopeOverlaps(['src/a'],['docs']),false);
});

test('shared files are recognized by name, pattern and directory',()=>{
  for(const p of ['package.json','web/package-lock.json','tsconfig.build.json','.claude/settings.local.json'])
    assert.equal(isSharedPath(p),true,p);
  assert.equal(isSharedPath('src/index.mjs'),false);
  assert.equal(isSharedPath('config/app.json',{extra:['config']}),true);
  assert.ok(DEFAULT_SHARED_FILES.includes('package.json'));
});

test('a scope may not cover a shared file or directory',()=>{
  assert.deepEqual(scopeSharedConflicts(['package.json']),['package.json']);
  assert.deepEqual(scopeSharedConflicts(['.claude']),['.claude']);
  assert.deepEqual(scopeSharedConflicts(['.']).length>0,true);
  assert.deepEqual(scopeSharedConflicts(['src']),[]);
  assert.deepEqual(scopeSharedConflicts(['config'],{extra:['config/keys.json']}),['config/keys.json']);
});

test('live leases expose their owner and block overlapping scopes',()=>{
  const leases=[{workerId:'w1',leaseId:'l1',repositoryKey:'r1',scope:['src/a']}];
  assert.deepEqual(findLeaseConflict(leases,['src/a/x'],{repositoryKey:'r1'}),{workerId:'w1',leaseId:'l1',path:'src/a'});
  assert.equal(findLeaseConflict(leases,['src/ab'],{repositoryKey:'r1'}),null);
  assert.equal(findLeaseConflict(leases,['src/a/x'],{repositoryKey:'r2'}),null,'independent repositories must not collide');
  const checks=checkPaths(['src/a/x','docs/y'],leases,{repositoryKey:'r1'});
  assert.equal(checks.allowed,false);
  assert.deepEqual(checks.blocked,[{path:'src/a/x',workerId:'w1',leaseId:'l1'}]);
  assert.equal(checkPaths(['package.json'],[]).shared.length,1);
});
