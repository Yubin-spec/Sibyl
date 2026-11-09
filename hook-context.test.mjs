import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildHookContext,inboxPublicView,reviewAction,scopedHookData} from './hook-context.mjs';
import {projectKey} from './project-path.mjs';

test('session-start context reports pending ownership, reviews and attention without question text',()=>{
  const output=buildHookContext({
    event:'session-start',
    projectPath:'/p',
    projectKey:'/p',
    projectName:'Demo',
    nativeSessionId:'A',
    pendingQuestions:[
      {id:'q1',status:'queued',owner:'own',source:{title:'Source A',tool:'codex'},target:{title:'Claude A',tool:'claude'},text:'SECRET-QUESTION-BODY'},
      {id:'q2',status:'delivered',owner:'sameTool',source:{title:'Source B',tool:'codex'},target:{title:'Claude B',tool:'claude'},text:'SECRET-QUESTION-BODY'},
      {id:'q3',status:'queued',owner:'otherTool',source:{title:'Source C',tool:'claude'},target:{title:'Codex',tool:'codex'},text:'SECRET-QUESTION-BODY'}
    ],
    reviews:[{reviewId:'r1',status:'awaiting-visibility',planPath:'docs/a.md'}],
    attention:[{kind:'pair',title:'电脑请求配对',detail:'10.0.0.2'}]
  });
  assert.match(output,/项目：Demo/);
  assert.match(output,/待答问题 3 条：当前会话 1 条、本工具其他会话 1 条、其他工具 1 条/);
  assert.match(output,/来自 Source A（Codex） → 发给 Claude A（Claude）/);
  assert.match(output,/等待确认可见：docs\/a.md/);
  assert.match(output,/电脑请求配对/);
  assert.match(output,/bridge_receive/);
  assert.doesNotMatch(output,/SECRET-QUESTION-BODY/);
});

test('user-prompt context is empty without items and read-only when items exist',()=>{
  assert.equal(buildHookContext({event:'user-prompt',projectPath:'/p',projectKey:'/p'}),'');
  const output=buildHookContext({
    event:'user-prompt',
    projectPath:'/p',
    projectKey:'/p',
    pendingQuestions:[{id:'q1',status:'queued',owner:'own',source:{title:'Source',tool:'codex'},target:{title:'Claude',tool:'claude'}}],
    reviews:[{reviewId:'r1',status:'changes-required',planPath:'docs/a.md'}]
  });
  assert.match(output,/只读提醒/);
  assert.match(output,/不会把这些事项标记为已读/);
  assert.match(output,/由当前操作者会话逐条调用 bridge_plan_review_respond/);
});

test('review actions keep the visibility step before continue and describe takeover',()=>{
  const visible=reviewAction('awaiting-visibility');
  assert.ok(visible.indexOf('确认评审在观测页实际可见')<visible.indexOf('bridge_plan_review_continue'));
  assert.match(reviewAction('interrupted'),/takeover:true/);
  assert.match(reviewAction('interrupted'),/操作归属转移/);
  assert.match(reviewAction('reviewing'),/其他会话只能在观测页查看/);
  assert.match(reviewAction('deadlock'),/bridge_plan_review_decide/);
});

test('invalid project key never injects project-scoped reviews or attention',()=>{
  const output=buildHookContext({
    event:'session-start',
    projectPath:'/missing',
    projectKey:null,
    reviews:[{reviewId:'r1',status:'changes-required',planPath:'docs/a.md'}],
    attention:[{kind:'pair',title:'全局配对'}]
  });
  assert.match(output,/项目路径无法校验/);
  assert.match(output,/全局配对/);
  assert.doesNotMatch(output,/docs\/a.md/);
});

test('inboxPublicView counts full pending history before applying the UI window',()=>{
  const questions=[{id:'old',status:'queued'},...Array.from({length:100},(_,index)=>({id:'done-'+index,status:'answered'}))];
  const view=inboxPublicView({sessions:[],questions});
  assert.equal(view.pendingCount,1);
  assert.equal(view.questionsTotal,101);
  assert.equal(view.questions.length,100);
  assert.equal(view.questions.at(-1).id,'done-99');
});

test('scopedHookData filters reviews, conversations and consultations by project key',async()=>{
  const root=await mkdtemp(join(tmpdir(),'sibyl-hook-context-'));
  const a=join(root,'a'),b=join(root,'b');
  await mkdir(a,{recursive:true});await mkdir(b,{recursive:true});
  const projects=[{id:'pa',name:'A',path:a},{id:'pb',name:'B',path:b}];
  const reviews=[
    {reviewId:'ra',projectPath:a,status:'changes-required',planPath:'a.md'},
    {reviewId:'rb',projectPath:b,status:'changes-required',planPath:'b.md'}
  ];
  const conversations=[{id:'ca',projectId:'pa',status:'failed',title:'A failed'},{id:'cb',projectId:'pb',status:'failed',title:'B failed'}];
  const consultations=[
    {id:'ka',sourceProjectId:'pa',targetProjectId:'pb',status:'failed',startedAt:'2026-11-09T00:00:00Z'},
    {id:'kb',sourceProjectId:'pb',targetProjectId:'pb',status:'failed',startedAt:'2026-11-09T00:00:00Z'}
  ];
  const requests=[{id:'pair1',name:'Peer',ip:'10.0.0.2'}];
  try{
    const same=scopedHookData({projectKey:projectKey(a),projects,reviews,conversations,consultations,requests});
    assert.deepEqual(same.reviews.map(item=>item.reviewId),['ra']);
    assert.equal(same.project.id,'pa');
    assert.ok(same.attention.some(item=>item.kind==='conversation'&&item.conversationId==='ca'));
    assert.ok(same.attention.some(item=>item.kind==='consult'&&item.consultId==='ka'));
    assert.ok(same.attention.some(item=>item.kind==='pair'));
    assert.ok(!same.attention.some(item=>item.conversationId==='cb'));
    assert.ok(!same.attention.some(item=>item.consultId==='kb'));

    const alias=scopedHookData({projectKey:projectKey(join(a,'.')),projects,reviews,conversations,consultations,requests});
    assert.deepEqual(alias.reviews.map(item=>item.reviewId),['ra']);

    const untrusted=scopedHookData({projectKey:null,projects,reviews,conversations,consultations,requests});
    assert.deepEqual(untrusted.reviews,[]);
    assert.equal(untrusted.project,null);
    assert.deepEqual(untrusted.attention.map(item=>item.kind),['pair']);
  }finally{await rm(root,{recursive:true,force:true});}
});
