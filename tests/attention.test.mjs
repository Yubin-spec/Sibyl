import test from 'node:test';
import assert from 'node:assert/strict';
import {attentionItems} from '../src/bridge/attention.mjs';

test('attention queue prioritizes pairing and keeps one actionable item per concern', () => {
  const items = attentionItems({
    requests: [{id:'pair-1', name:'Studio Mac', ip:'192.168.1.20'}],
    consultations: [
      {id:'c-1', status:'failed', sourceProjectId:'p1', targetProjectId:'p2', error:'tool unavailable', updatedAt:'2026-11-03T10:00:00.000Z'},
      {id:'c-2', status:'completed', sourceProjectId:'p1', targetProjectId:'p2', updatedAt:'2026-11-03T10:01:00.000Z'}
    ],
    conversations: [{id:'conv-1', status:'failed', projectId:'p1', title:'parser audit', stopReason:'execution error', updatedAt:'2026-11-03T10:02:00.000Z'}],
    projects: [{id:'p1', name:'Sibyl'}, {id:'p2', name:'Parser Core'}],
    dismissed: []
  });

  assert.deepEqual(items.map(item => item.kind), ['pair', 'consult', 'conversation']);
  assert.match(items[0].title, /Studio Mac/);
  assert.match(items[1].detail, /Sibyl → Parser Core/);
  assert.match(items[1].detail, /tool unavailable/);
  assert.equal(items[0].dismissible, false);
});

test('dismissed failures stay quiet until their record changes', () => {
  const base = {
    requests: [],
    consultations: [{id:'c-1', status:'failed', error:'first', updatedAt:'2026-11-03T10:00:00.000Z'}],
    conversations: [{id:'conv-1', status:'failed', title:'one', updatedAt:'2026-11-03T10:00:00.000Z'}]
  };
  const dismissed = ['consult:c-1:2026-11-03T10:00:00.000Z','conversation:conv-1:2026-11-03T10:00:00.000Z'];
  assert.deepEqual(attentionItems({...base, dismissed}), []);
  assert.equal(attentionItems({...base, consultations:[{...base.consultations[0], updatedAt:'2026-11-03T10:05:00.000Z'}], dismissed}).length, 1);
});
