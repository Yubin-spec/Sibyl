import {readFileSync} from 'node:fs';
import {writeFile,rename} from 'node:fs/promises';
import {basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {notify} from './scripts/notify-wechat.mjs';

const CONFIG_FIELDS=['host','user','key','hermes','target'];
const WORKER_TERMINAL=new Set(['completed','failed','stopped','orphan','interrupted']);
const PLAN_EVENTS=new Set(['awaiting-visibility','changes-required','deadlock','approved','failed','interrupted']);
const PLAN_LABELS={'awaiting-visibility':'等待确认','changes-required':'需要回应','deadlock':'死锁','approved':'已通过','failed':'失败','interrupted':'中断'};
const ATTENTION_LABELS={pair:'配对请求',consult:'只读核对停止',conversation:'会话失败'};
const DEFAULT_CONFIG_PATH=fileURLToPath(new URL('./.notify.json',import.meta.url));
const MAX_LEDGER=1000;

const text=value=>String(value??'').replace(/\s+/g,' ').trim();
const clip=(value,max)=>{const line=text(value);return line.length>max?line.slice(0,max-1)+'…':line;};
const shortId=value=>String(value??'').slice(0,8);
const delay=ms=>new Promise(resolve=>{const timer=setTimeout(resolve,ms);timer.unref?.();});

export function attentionKey(item){
  if(item?.kind==='pair') return `pair:${item.pairId}`;
  if(item?.kind==='consult') return `consult:${item.consultId}`;
  if(item?.kind==='conversation') return `conversation:${item.conversationId}`;
  return String(item?.key??'');
}

function workerLabel(worker){
  if(worker.status==='completed') return '完成';
  if(worker.status==='orphan') return '孤儿';
  if(worker.status==='stopped') return '已停止';
  if(worker.status==='interrupted') return '中断';
  if(/timed?\s*out|timeout|超时/i.test(String(worker.error??''))) return '超时';
  return '失败';
}

function modelText(model,effort){
  if(!model) return 'codex 默认';
  return effort?`${model} / ${effort}`:model;
}

function workerMessage(event){
  const project=event.projectName||'本机';
  const label=workerLabel(event);
  const model=event.model?modelText(event.model,event.effort):'claude 默认';
  let done='';
  let missing='';
  let eta='';
  if(event.status==='completed'){
    const report=event.report;
    const stats=report?.stats?.files?`（${report.stats.files} 个文件）`:'';
    done=`工作方已交工${stats}：${clip(report?.summary||'工作方没有给出摘要。',260)}`;
    missing=report?.needsReview
      ? `需要人工验收：${clip((report.reviewReasons??[]).join('；')||'报告标记为需要复核',260)}`
      : '无，报告可验收。';
    eta=report?.needsReview?'等你验收，约几分钟。':'无需等待。';
  } else if(event.status==='orphan'){
    done='工作方进程未确认退出，工作树与分支保留。';
    missing='需要你确认进程已退出后关闭工作方。';
    eta='等你处理。';
  } else if(event.status==='stopped'){
    done=`工作方已停止：${clip(event.error||event.stopReason||'长时间没有进展',200)}`;
    missing='需要你决定是否重新派活。';
    eta='等你决定。';
  } else if(event.status==='interrupted'){
    done='工作方已中断。';
    missing=clip(event.error||'需要重新派活',200);
    eta='等你决定。';
  } else {
    done=`工作方失败：${clip(event.error||event.stopReason||'未知原因',200)}`;
    missing='需要你决定是否重试或人工处理。';
    eta='等你决定。';
  }
  return {title:clip(`${project} · 工作方${label}`,100),body:bodyOf(project,`工作方 ${shortId(event.workerId)} · ${event.tool||'codex'}/${event.tier||'dispatch'}`,model,done,missing,eta)};
}

function planMessage(event){
  const project=event.projectName||'本机';
  const model=event.model?modelText(event.model,event.effort):'codex 默认';
  const round=event.round??1;
  let done='';
  let missing='';
  let eta='';
  switch(event.status){
    case 'awaiting-visibility':
      done='计划已提交评审，评审会话还未确认可见。';
      missing='需要确认评审会话可见后继续。';
      eta='等你确认。';
      break;
    case 'changes-required':{
      const major=(event.issues??[]).filter(issue=>['blocker','major'].includes(issue?.severity)).length;
      const questions=(event.questions??[]).length;
      done=`第 ${round} 轮评审完成：${major} 个 blocker/major、${questions} 个问题待回应。`;
      missing='需要回应评审意见后重新提交（由 Claude 处理）。';
      eta='视回应而定，通常几分钟到半小时。';
      break;
    }
    case 'deadlock':
      done=`评审在第 ${round} 轮达到上限，仍未通过。`;
      missing='需要你裁决：继续一轮或取消。';
      eta='等你决定。';
      break;
    case 'approved':
      done='计划已通过评审。';
      missing='无，可以开工。';
      eta='无。';
      break;
    case 'interrupted':
      done='评审因后台重启中断。';
      missing='需要恢复评审。';
      eta='等你恢复。';
      break;
    default:
      done=`评审未完成：${clip(event.error||'未知原因',200)}`;
      missing='需要恢复或重新发起评审。';
      eta='等你恢复。';
  }
  return {title:clip(`${project} · 计划评审${PLAN_LABELS[event.status]||''}`,100),body:bodyOf(project,`计划评审 ${shortId(event.reviewId)} · ${clip(event.planPath,120)} · 第 ${round} 轮`,model,done,missing,eta)};
}

function attentionMessage(event){
  const project=event.projectName||'本机';
  const label=ATTENTION_LABELS[event.attentionKind]||'待处理';
  return {
    title:clip(`${project} · 待处理`,100),
    body:bodyOf(project,`待处理 · ${label}`,'不适用','待处理队列出现新事项。',`${clip(event.title,80)}：${clip(event.detail,240)}`,'等你处理。')
  };
}

function bodyOf(project,task,model,done,missing,eta){
  return `项目：${project}\n任务：${task}\n模型：${model}\n\n完成了什么：${clip(done,300)}\n还差什么：${clip(missing,300)}\n预计多久：${clip(eta,100)}`;
}

export function formatNotification(event){
  if(event.kind==='worker') return workerMessage(event);
  if(event.kind==='plan-review') return planMessage(event);
  return attentionMessage(event);
}

export function notificationEvents(previous,current,{internalWorkers=new Set()}={}){
  const events=[];
  if(!previous) return events;
  const projects=new Map((current?.projects??[]).map(project=>[project.path,project.name]));
  const projectName=path=>projects.get(path)||(path?basename(path):'');
  const prevWorkers=new Map((previous.workers??[]).map(worker=>[worker.workerId,worker]));
  const internal=new Set(internalWorkers);
  for(const review of current?.planReviews??[]) if(review?.workerId) internal.add(review.workerId);

  const prevReviews=new Map((previous.planReviews??[]).map(review=>[review.reviewId,review]));
  for(const review of current?.planReviews??[]){
    if(!review?.reviewId||!PLAN_EVENTS.has(review.status)) continue;
    const before=prevReviews.get(review.reviewId);
    if(before&&before.status===review.status) continue;
    const worker=(current.workers??[]).find(item=>item.workerId===review.workerId);
    events.push({
      key:`plan-review:${review.reviewId}:${review.status}:${review.round??0}`,
      kind:'plan-review',
      status:review.status,
      reviewId:review.reviewId,
      planPath:review.planPath,
      round:review.round,
      issues:review.issues,
      questions:review.questions,
      error:review.error,
      projectName:projectName(review.projectPath),
      model:worker?.model??null,
      effort:worker?.effort??null,
      at:review.updatedAt
    });
  }

  for(const worker of current?.workers??[]){
    if(!worker?.workerId||internal.has(worker.workerId)) continue;
    if(!WORKER_TERMINAL.has(worker.status)) continue;
    const before=prevWorkers.get(worker.workerId);
    if(before&&before.status===worker.status) continue;
    events.push({
      key:`worker:${worker.workerId}:${worker.status}`,
      kind:'worker',
      status:worker.status,
      workerId:worker.workerId,
      tool:worker.tool,
      tier:worker.tier,
      model:worker.model,
      effort:worker.effort,
      error:worker.error,
      stopReason:worker.stopReason,
      report:worker.report,
      projectName:projectName(worker.projectPath),
      at:worker.endedAt
    });
  }

  const prevAttention=new Set((previous.attention??[]).map(item=>attentionKey(item)));
  for(const item of current?.attention??[]){
    const key=attentionKey(item);
    if(prevAttention.has(key)) continue;
    events.push({
      key:`attention:${key}`,
      kind:'attention',
      attentionKind:item.kind,
      title:item.title,
      detail:item.detail,
      at:item.at
    });
  }
  return events;
}

function readBaseline(snapshot){
  return {
    workers:(snapshot?.workers??[]).map(worker=>({workerId:worker.workerId,status:worker.status})),
    planReviews:(snapshot?.planReviews??[]).map(review=>({reviewId:review.reviewId,status:review.status,round:review.round})),
    attention:(snapshot?.attention??[]).map(item=>({key:attentionKey(item)}))
  };
}

function normalizeConfig(value){
  if(!value||typeof value!=='object'||Array.isArray(value)) return null;
  for(const field of CONFIG_FIELDS){
    if(typeof value[field]!=='string'||!value[field].trim()) return null;
  }
  if(value.enabled===false) return null;
  return value;
}

function loadConfigFile(path){
  if(!path) return null;
  let value;
  try{value=JSON.parse(readFileSync(path,'utf8'));}
  catch{return null;}
  return normalizeConfig(value);
}

function loadStateFile(path){
  if(!path) return {keys:new Map(),workers:new Set(),state:'ok'};
  let value;
  try{value=JSON.parse(readFileSync(path,'utf8'));}
  catch(error){
    if(error?.code==='ENOENT') return {keys:new Map(),workers:new Set(),state:'ok'};
    return {keys:new Map(),workers:new Set(),state:'broken'};
  }
  if(!value||typeof value!=='object'||Array.isArray(value)) return {keys:new Map(),workers:new Set(),state:'broken'};
  const keys=new Map();
  if(value.keys!==undefined){
    if(!value.keys||typeof value.keys!=='object'||Array.isArray(value.keys)) return {keys:new Map(),workers:new Set(),state:'broken'};
    for(const [key,at] of Object.entries(value.keys)){
      const time=Number(at);
      if(!Number.isFinite(time)) return {keys:new Map(),workers:new Set(),state:'broken'};
      keys.set(key,time);
    }
  }
  const workers=new Set();
  if(value.internalWorkers!==undefined){
    if(!Array.isArray(value.internalWorkers)||value.internalWorkers.some(id=>typeof id!=='string')) return {keys:new Map(),workers:new Set(),state:'broken'};
    for(const id of value.internalWorkers) workers.add(id);
  }
  return {keys,workers,state:'ok'};
}

export function createNotifyService({
  enabled=false,
  sender,
  config,
  configPath=process.env.SIBYL_NOTIFY_CONFIG||DEFAULT_CONFIG_PATH,
  statePath,
  dedupeMs=6*60*60*1000,
  sendTimeoutMs=20000,
  now=Date.now,
  retryDelayMs=2000,
  maxAttempts=2,
  maxQueue=20,
  onError=()=>{}
}={}){
  const resolved=config===undefined?loadConfigFile(configPath):normalizeConfig(config);
  const persisted=loadStateFile(statePath);
  const senderFn=typeof sender==='function'?sender:input=>notify({title:input.title,body:input.body,config:input.config,signal:input.signal});
  const secrets=resolved?CONFIG_FIELDS.map(field=>resolved[field]).filter(Boolean):[];
  const windowMs=(()=>{const value=Number(resolved?.dedupeMs);return Number.isFinite(value)&&value>=0?Math.min(value,7*24*60*60*1000):dedupeMs;})();
  const keys=persisted.keys;
  const internalWorkers=persisted.workers;
  const status={enabled:!!enabled&&!!resolved,state:'disabled',sent:0,failed:0,dropped:0,lastError:null};
  if(status.enabled) status.state=persisted.state;
  const queue=[];
  const waiters=[];
  let previous=null;
  let running=false;
  let closed=false;
  let inflight=null;
  let cancelInflight=null;
  let saveChain=Promise.resolve();
  const redact=value=>{
    let output=String(value??'');
    for(const secret of secrets) if(secret) output=output.split(secret).join('[redacted]');
    return output;
  };
  const noteError=message=>{
    const safe=redact(message);
    status.lastError=safe;
    try{onError({message:safe});}catch{}
  };
  const prune=()=>{
    const cutoff=now()-windowMs;
    for(const [key,at] of keys) if(!(at>=cutoff)) keys.delete(key);
  };
  const persist=()=>{
    if(!statePath||!status.enabled||status.state==='broken') return saveChain;
    prune();
    const payload={version:1,keys:Object.fromEntries(keys),internalWorkers:[...internalWorkers]};
    saveChain=saveChain.catch(()=>{}).then(async()=>{
      await writeFile(statePath+'.tmp',JSON.stringify(payload),{mode:0o600});
      await rename(statePath+'.tmp',statePath);
    });
    return saveChain;
  };
  const persistLedger=()=>{
    if(!statePath||!status.enabled||status.state==='broken') return;
    persist().catch(()=>{
      status.state='broken';
      noteError('通知状态文件不可写，已暂停微信通知');
    });
  };
  const rememberWorkers=(snapshot)=>{
    let changed=false;
    for(const review of snapshot?.planReviews??[]){
      if(review?.workerId&&!internalWorkers.has(review.workerId)){
        internalWorkers.add(review.workerId);
        changed=true;
      }
    }
    const live=new Set((snapshot?.workers??[]).filter(worker=>['starting','running','orphan'].includes(worker.status)).map(worker=>worker.workerId));
    const referenced=new Set((snapshot?.planReviews??[]).map(review=>review.workerId).filter(Boolean));
    if(internalWorkers.size>MAX_LEDGER){
      for(const id of [...internalWorkers]){
        if(internalWorkers.size<=MAX_LEDGER) break;
        if(live.has(id)||referenced.has(id)) continue;
        internalWorkers.delete(id);
      }
    }
    if(changed) persistLedger();
  };
  const settle=()=>{
    if(running||queue.length) return;
    for(const resolve of waiters.splice(0)) resolve({...status,queued:0});
  };
  const attempt=async message=>{
    let lastError=null;
    const attempts=Math.max(1,maxAttempts);
    for(let index=1;index<=attempts;index++){
      const controller=new AbortController();
      inflight=controller;
      let timer;
      const cancelled=new Promise((_,reject)=>{
        cancelInflight=()=>reject(Object.assign(Error('notify closed'),{name:'AbortError'}));
      });
      try{
        const timeout=new Promise((_,reject)=>{
          timer=setTimeout(()=>{
            controller.abort();
            reject(Object.assign(Error('notify send timed out'),{name:'AbortError'}));
          },sendTimeoutMs);
          timer.unref?.();
        });
        const call=Promise.resolve().then(()=>senderFn({title:message.title,body:message.body,config:resolved,signal:controller.signal}));
        return await Promise.race([call,timeout,cancelled]);
      }catch(error){
        lastError=error;
        const retryable=error?.retryable===true&&!closed&&!controller.signal.aborted&&index<attempts;
        if(!retryable) throw error;
        await delay(retryDelayMs);
        if(closed) throw Object.assign(Error('notify closed'),{name:'AbortError'});
      }finally{
        clearTimeout(timer);
        inflight=null;
        cancelInflight=null;
      }
    }
    throw lastError;
  };
  const pump=async()=>{
    if(running) return;
    if(closed){settle();return;}
    if(!status.enabled||status.state==='broken'){queue.length=0;settle();return;}
    const event=queue.shift();
    if(!event){settle();return;}
    running=true;
    try{
      keys.set(event.key,now());
      try{await persist();}catch(error){status.state='broken';throw error;}
      const message=formatNotification(event);
      await attempt({title:redact(message.title),body:redact(message.body)});
      status.sent+=1;
    }catch(error){
      status.failed+=1;
      if(status.state==='broken') queue.length=0;
      noteError(error?.name==='AbortError'?'微信通知发送被取消或超时':(error?.message??error));
    }finally{
      running=false;
      void pump();
    }
  };
  const enqueue=events=>{
    for(const event of events){
      const sentAt=keys.get(event.key);
      if(sentAt!==undefined&&sentAt>=now()-windowMs) continue;
      if(queue.length>=maxQueue){status.dropped+=1;continue;}
      queue.push(event);
    }
    if(queue.length) void pump();
  };
  return {
    seed(snapshot){
      previous=readBaseline(snapshot);
      rememberWorkers(snapshot);
    },
    observe(snapshot){
      rememberWorkers(snapshot);
      if(!previous){previous=readBaseline(snapshot);return;}
      const events=notificationEvents(previous,snapshot,{internalWorkers});
      previous=readBaseline(snapshot);
      if(!status.enabled||status.state==='broken') return;
      enqueue(events);
    },
    status(){return {...status,queued:queue.length};},
    flush(){
      if(!running&&!queue.length) return Promise.resolve({...status,queued:0});
      return new Promise(resolve=>waiters.push(resolve));
    },
    close(){
      closed=true;
      queue.length=0;
      try{inflight?.abort();}catch{}
      try{cancelInflight?.();}catch{}
      settle();
    }
  };
}
