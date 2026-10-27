import test from 'node:test';
import assert from 'node:assert/strict';

test('pairing needs approval, returns credentials once, supports revocation and expiry',async()=>{
  const {createPairing}=await import('./pairing.mjs');
  let clock=1000;let requested;const peers={};let saves=0;
  const p=createPairing({peers,now:()=>clock,save:async()=>{saves++;},notify:r=>{requested=r;}});
  assert.throws(()=>p.start({code:'incorrect',name:'alice'},'ip'),/Invalid/);
  const request=p.start({code:p.code,name:'alice'},'ip');
  assert.equal(p.result(request.id,request.secret).status,'pending');
  assert.equal(p.authenticate('anything'),null);
  await p.approve(requested.id,true);
  assert.throws(()=>p.result(request.id,'wrong'),/Unknown/);
  const result=p.result(request.id,request.secret);
  assert.equal(result.status,'approved');
  assert.equal(p.authenticate(result.token).name,'alice');
  assert.equal(saves,1);
  assert.throws(()=>p.result(request.id,request.secret),/Unknown/);
  assert.ok(!JSON.stringify(peers).includes(result.token));
  await p.revoke(result.peerId);
  assert.equal(p.authenticate(result.token),null);
  clock+=300001;
  assert.throws(()=>p.start({code:p.code,name:'late'},'other'),/expired/);
});

test('pairing rejects repeated guesses and denied requests never get credentials',async()=>{
  const {createPairing}=await import('./pairing.mjs');
  const p=createPairing({peers:{},save:async()=>{},notify:()=>{}});
  const request=p.start({code:p.code,name:'alice'},'ip');
  await p.approve(request.id,false);
  assert.equal(p.result(request.id,request.secret).status,'denied');
  for(let i=0;i<5;i++) assert.throws(()=>p.start({code:'bad',name:'x'},'attacker'),/Invalid/);
  assert.throws(()=>p.start({code:p.code,name:'x'},'attacker'),/Too many/);
});
