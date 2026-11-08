import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRemoteCommand,buildSshArgs,notify,loadConfig} from './scripts/notify-wechat.mjs';

test('remote command pins the hermes path and target',()=>{
  const command=buildRemoteCommand({hermes:'/home/ubuntu/.local/bin/hermes',target:'weixin'});
  assert.equal(command,"'/home/ubuntu/.local/bin/hermes' send --to 'weixin'");
});

test('a title with quotes and substitutions cannot escape its argument',()=>{
  const command=buildRemoteCommand({hermes:'/h',target:'weixin',title:"it's $(rm -rf /)"});
  assert.ok(command.includes(`--subject 'it'\\''s $(rm -rf /)'`),command);
});

test('the body never appears in the remote command',()=>{
  const body='secret body $(id)';
  const command=buildRemoteCommand({hermes:'/h',target:'weixin',title:'t'});
  assert.ok(!command.includes(body));
  assert.ok(!command.includes('secret'));
});

test('ssh args carry the fixed host, user and key',()=>{
  const args=buildSshArgs({host:'203.0.113.9',user:'ubuntu',key:'C:/keys/k',command:'hermes send'});
  assert.deepEqual(args.slice(0,2),['-i','C:/keys/k']);
  assert.ok(args.includes('ubuntu@203.0.113.9'));
  assert.equal(args.at(-1),'hermes send');
  assert.ok(args.includes('BatchMode=yes'));
});

test('notify pipes the body on stdin instead of the command line',async()=>{
  let seen;
  const result=await notify({title:'阶段完成',body:'完成了 A\n还差 B',config:{host:'h',user:'u',key:'k',hermes:'/hm',target:'weixin'},
    run:async options=>{seen=options;return 'sent';}});
  assert.equal(result,'sent');
  assert.equal(seen.input,'完成了 A\n还差 B');
  assert.ok(!seen.command.includes('完成了'));
  assert.ok(seen.command.includes("'/hm' send --to 'weixin'"));
});

test('a missing config file is reported in plain language',async()=>{
  await assert.rejects(loadConfig('C:/definitely/not/here.json'),/Missing notify config: create .*here\.json/);
});

test('incomplete config is rejected before any connection',async()=>{
  await assert.rejects(notify({title:'t',body:'b',config:{host:'h'},run:async()=>'x'}),
    /notify config needs/);
});
