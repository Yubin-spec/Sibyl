import { DatabaseSync } from 'node:sqlite';
import { mkdir, chmod } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { canonicalProjectPath, projectKey } from './project-path.mjs';

const tools = ['claude', 'codex', 'cursor', 'workbuddy'];
const statuses = ['idle', 'running', 'completed', 'failed', 'cancelled', 'archived'];
const limitKeys = {maxMessages:[1,200], maxTurnsPerAgent:[1,50], maxDurationMs:[1000,86400000], idleTimeoutMs:[1000,86400000], duplicateLimit:[2,10]};
const defaults = {page:'conversations', selectedProjectId:'', closeToTray:true, autoStartHost:false, autoBindProjects:true, networkPort:47831};
function text(value, field, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim())) throw new Error(`Invalid ${field}`);
  return value;
}
function oneOf(value, values, field) {
  if (!values.includes(value)) throw new Error(`Invalid ${field}`);
  return value;
}
function integer(value, min, max, field) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${field}`);
  return value;
}
function boolean(value, field) { if (typeof value !== 'boolean') throw new Error(`Invalid ${field}`); return value; }
function keys(patch, allowed) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Expected object');
  for (const key of Object.keys(patch)) if (!allowed.includes(key)) throw new Error(`Unsupported field: ${key}`);
}
function limits(value) {
  if (value == null) return null;
  keys(value, Object.keys(limitKeys));
  const out = {};
  for (const [key,[min,max]] of Object.entries(limitKeys)) if (value[key] !== undefined) out[key] = integer(value[key], min, max, key);
  return out;
}
function cursors(value) {
  keys(value, ['local','remote']);
  return {local:integer(value.local ?? 0,0,Number.MAX_SAFE_INTEGER,'cursor'), remote:integer(value.remote ?? 0,0,Number.MAX_SAFE_INTEGER,'cursor')};
}
const now = () => new Date().toISOString();

export async function openWorkspace(dir) {
  await mkdir(dir, {recursive:true, mode:0o700});
  const file = join(dir,'workspace.sqlite');
  const db = new DatabaseSync(file);
  await chmod(file,0o600);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) { db.close(); throw new Error('Unsupported workspace schema version'); }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {const result=fn(); db.exec('COMMIT'); return result;} catch(error) {db.exec('ROLLBACK');throw error;}
  }
  try {
    transaction(()=>{
      db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), localSessionId TEXT NOT NULL REFERENCES sessions(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (conversationId TEXT NOT NULL REFERENCES conversations(id), id TEXT NOT NULL, offset INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(conversationId,id), UNIQUE(conversationId,offset));
        PRAGMA user_version=1;`);
      db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('device',JSON.stringify({id:randomUUID(),name:hostname(),owner:''}));
      db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('settings',JSON.stringify(defaults));
      db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('bindings',JSON.stringify([]));
      db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('consultations',JSON.stringify([]));
      db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('workers',JSON.stringify([]));
      db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('planReviews',JSON.stringify([]));
      db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('planApprovals',JSON.stringify({}));
      for (const row of db.prepare('SELECT id,data FROM conversations').all()) {
        const record=JSON.parse(row.data);
        if(record.status==='running') {record.status='failed';record.updatedAt=now();db.prepare('UPDATE conversations SET data=? WHERE id=?').run(JSON.stringify(record),row.id);}
      }
    });
  } catch(error) {db.close();throw error;}
  const meta = key => JSON.parse(db.prepare('SELECT data FROM meta WHERE key=?').get(key).data);
  const putMeta = (key,value) => db.prepare('UPDATE meta SET data=? WHERE key=?').run(JSON.stringify(value),key);
  const consultations = meta('consultations');
  for (const record of consultations) if (record.status === 'running') {
    record.status = 'interrupted';
    record.error = '后台已重启；该核对线程未完成，请重新发起或检查已有结果。';
    record.updatedAt = now();
  }
  if (consultations.some(record => record.status === 'interrupted')) putMeta('consultations', consultations);
  const workers = meta('workers');
  let workersInterrupted = false;
  for (const record of workers) if (record.status === 'starting' || record.status === 'running') {
    record.status = 'orphan';
    record.stopReason = 'exit-unconfirmed';
    record.error = '后台已重启；工作树和分支保留，确认进程已退出后关闭以释放租约。';
    record.updatedAt = now();
    workersInterrupted = true;
  }
  if (workersInterrupted) putMeta('workers', workers);
  const get = (table,id) => {
    const row=db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(text(id,'id'));
    if(!row) throw new Error(`${table} record not found: ${id}`);
    return JSON.parse(row.data);
  };
  const list = table => db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(row=>JSON.parse(row.data));
  const save = (table,record) => {db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(record),record.id);return record;};
  function validateSession(record) {
    oneOf(record.tool,tools,'tool');text(record.title,'title');
    oneOf(record.mode,['managed','native-inbox'],'mode');boolean(record.shared,'shared');
    if(record.nativeSessionId !== null) text(record.nativeSessionId,'nativeSessionId');
    oneOf(record.capability,['managed','inbox','unregistered'],'capability');
    if(record.mode==='native-inbox' && !record.nativeSessionId)record.capability='unregistered';
    return record;
  }
  return {
    snapshot() {return {device:meta('device'),settings:meta('settings'),projects:list('projects'),sessions:list('sessions'),conversations:list('conversations'),bindings:meta('bindings')};},
    setDevice(patch) {return transaction(()=>{keys(patch,['name','owner']);const record=meta('device');for(const [key,value] of Object.entries(patch))record[key]=text(value,key,true);putMeta('device',record);return record;});},
    updateSettings(patch) {return transaction(()=>{
      keys(patch,Object.keys(defaults));const record=meta('settings');
      for(const [key,value] of Object.entries(patch)) {
        if(key==='networkPort')integer(value,1,65535,key);
        else if(key==='closeToTray'||key==='autoStartHost'||key==='autoBindProjects')boolean(value,key);
        else text(value,key,key==='selectedProjectId');
        record[key]=value;
      }
      putMeta('settings',record);return record;
    });},
    dismissAttention(key) {return transaction(()=>{
      if(typeof key!=='string'||!/^(consult|conversation):[a-zA-Z0-9:._-]{1,220}$/.test(key))throw new Error('Invalid attention item');
      const record=meta('settings'),list=Array.isArray(record.dismissedAttention)?record.dismissedAttention:[];
      if(!list.includes(key))list.push(key);
      record.dismissedAttention=list.slice(-100);putMeta('settings',record);return record.dismissedAttention;
    });},
    saveProject(input) {return transaction(()=>{
      const name=text(input.name,'name');const path=realpathSync(text(input.path,'path'));
      if(!statSync(path).isDirectory())throw new Error('Project path must be a directory');
      const duplicate=db.prepare('SELECT data FROM projects WHERE path=?').get(path);
      if(duplicate && input.id===undefined)return JSON.parse(duplicate.data);
      if(duplicate && JSON.parse(duplicate.data).id!==input.id)throw new Error('Project path already exists');
      const id=input.id===undefined?randomUUID():text(input.id,'id');
      const previous=db.prepare('SELECT data FROM projects WHERE id=?').get(id);
      const record={id,name,path,createdAt:previous?JSON.parse(previous.data).createdAt:now()};
      db.prepare('INSERT INTO projects VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,data=excluded.data').run(id,path,JSON.stringify(record));return record;
    });},
    deleteProject(id) {return transaction(()=>{get('projects',id);db.prepare('DELETE FROM projects WHERE id=?').run(id);putMeta('bindings',meta('bindings').filter(binding=>binding.sourceProjectId!==id&&binding.targetProjectId!==id));});},
    ensureProjectByPath(input) {return transaction(()=>{
      const path=canonicalProjectPath(text(input?.path??input,'path'));
      const key=projectKey(path);
      const existing=list('projects').find(project=>projectKey(project.path)===key);
      if(existing)return existing;
      const record={id:randomUUID(),name:basename(path)||'Project',path,createdAt:now()};
      db.prepare('INSERT INTO projects VALUES (?,?,?)').run(record.id,path,JSON.stringify(record));
      return record;
    });},
    saveBinding(input) {return transaction(()=>{
      keys(input,['sourceProjectId','targetTool','targetProjectId']);
      const record={sourceProjectId:text(input.sourceProjectId,'sourceProjectId'),targetTool:oneOf(input.targetTool,tools,'targetTool'),targetProjectId:text(input.targetProjectId,'targetProjectId')};
      get('projects',record.sourceProjectId);get('projects',record.targetProjectId);
      putMeta('bindings',[...meta('bindings').filter(binding=>binding.sourceProjectId!==record.sourceProjectId||binding.targetTool!==record.targetTool),record]);return record;
    });},
    deleteBinding(input) {return transaction(()=>{
      keys(input,['sourceProjectId','targetTool']);
      const sourceProjectId=text(input.sourceProjectId,'sourceProjectId'),targetTool=oneOf(input.targetTool,tools,'targetTool');
      putMeta('bindings',meta('bindings').filter(binding=>binding.sourceProjectId!==sourceProjectId||binding.targetTool!==targetTool));return {ok:true};
    });},
    getProject(id) {return get('projects',id);},
    getSession(id) {return get('sessions',id);},
    getConversation(id) {return get('conversations',id);},
    listConsultations() {return meta('consultations');},
    listWorkers() {return meta('workers');},
    listPlanReviews() {return meta('planReviews');},
    savePlanReview(record) {return transaction(()=>{
      const id=text(record.id,'id');
      const value={...record,id,updatedAt:now()};
      const records=meta('planReviews').filter(item=>item.id!==id);
      records.push(value);
      records.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
      const active=new Set(Object.values(meta('planApprovals')).map(item=>item?.reviewId).filter(Boolean));
      let terminal=0;
      putMeta('planReviews',records.filter(item=>!['approved','rejected','cancelled','failed'].includes(item.status)||active.has(item.id)||terminal++<100));
      return value;
    });},
    getPlanApproval(projectId,planPath) {
      const key=text(projectId,'projectId')+'\0'+text(planPath,'planPath');
      return meta('planApprovals')[key]??null;
    },
    savePlanApproval(input) {return transaction(()=>{
      const reviewId=text(input.reviewId,'reviewId'),planHash=text(input.planHash,'planHash'),projectId=text(input.projectId,'projectId'),planPath=text(input.planPath,'planPath');
      if(!Number.isInteger(input.hashVersion)||input.hashVersion<1)throw new Error('Invalid hashVersion');
      const approvals={...meta('planApprovals')};
      const key=projectId+'\0'+planPath;
      approvals[key]={projectId,planPath,reviewId,planHash,hashVersion:input.hashVersion,status:text(input.status,'status'),approvedAt:input.approvedAt??now()};
      putMeta('planApprovals',approvals);return approvals[key];
    });},
    deletePlanApproval(projectId,planPath) {return transaction(()=>{
      const key=text(projectId,'projectId')+'\0'+text(planPath,'planPath');
      const approvals={...meta('planApprovals')};delete approvals[key];putMeta('planApprovals',approvals);return {ok:true};
    });},
    saveWorker(record) {return transaction(()=>{
      const id=text(record.id,'id');
      const value={...record,id,updatedAt:now()};
      const records=meta('workers').filter(item=>item.id!==id);
      records.push(value);
      records.sort((a,b)=>String(b.startedAt).localeCompare(String(a.startedAt)));
      let ended=0;
      putMeta('workers',records.filter(item=>['starting','running','orphan'].includes(item.status)||item.stopReason==='exit-unconfirmed'||ended++<100));
      return value;
    });},
    saveConsultation(record) {return transaction(()=>{
      const id=text(record.id,'id');
      const value={...record,id,updatedAt:now()};
      const list=meta('consultations').filter(item=>item.id!==id);
      list.push(value);
      list.sort((a,b)=>String(b.startedAt).localeCompare(String(a.startedAt)));
      putMeta('consultations',list.slice(0,100));return value;
    });},
    registerSession(input) {return transaction(()=>{
      get('projects',input.projectId);
      const record=validateSession({id:input.id===undefined?randomUUID():text(input.id,'id'),projectId:input.projectId,tool:input.tool,title:input.title,nativeSessionId:input.nativeSessionId??null,mode:input.mode??'managed',shared:input.shared??false,capability:input.capability??(input.mode==='native-inbox'?'inbox':'managed'),createdAt:now()});
      db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(record.id,record.projectId,JSON.stringify(record));return record;
    });},
    updateSession(id,patch) {return transaction(()=>{keys(patch,['title','nativeSessionId','mode','shared','capability']);return save('sessions',validateSession({...get('sessions',id),...patch}));});},
    createConversation(input) {return transaction(()=>{
      get('projects',input.projectId);const session=get('sessions',input.localSessionId);
      if(session.projectId!==input.projectId)throw new Error('Session belongs to another project');
      oneOf(session.tool,tools,'tool');const createdAt=now();
      const record={id:randomUUID(),title:text(input.title,'title'),projectId:input.projectId,localSessionId:input.localSessionId,connectionId:text(input.connectionId,'connectionId'),remoteAgent:oneOf(input.remoteAgent,tools,'remoteAgent'),remoteProjectId:input.remoteProjectId==null?null:text(input.remoteProjectId,'remoteProjectId'),rounds:integer(input.rounds??1,1,5,'rounds'),mode:oneOf(input.mode??'meeting',['meeting','channel'],'mode'),limits:limits(input.limits),cursors:{local:0,remote:0},stopReason:null,status:'idle',createdAt,updatedAt:createdAt};
      db.prepare('INSERT INTO conversations VALUES (?,?,?,?)').run(record.id,record.projectId,record.localSessionId,JSON.stringify(record));return record;
    });},
    updateConversation(id,patch) {return transaction(()=>{
      keys(patch,['title','status','rounds','mode','limits','cursors','stopReason','lastActivityAt','usage']);const record={...get('conversations',id),...patch,updatedAt:now()};
      text(record.title,'title');oneOf(record.status,statuses,'status');integer(record.rounds,1,5,'rounds');
      if(record.mode!==undefined)oneOf(record.mode,['meeting','channel'],'mode');
      if(record.limits!==undefined&&record.limits!==null)record.limits=limits(record.limits);
      if(record.cursors!==undefined)record.cursors=cursors(record.cursors);
      if(record.stopReason!==undefined&&record.stopReason!==null)text(record.stopReason,'stopReason');
      return save('conversations',record);
    });},
    appendMessage(conversationId,input) {return transaction(()=>{
      get('conversations',conversationId);
      const content={id:input.id===undefined?randomUUID():text(input.id,'id'),side:oneOf(input.side,['local','remote','human','system'],'side'),agent:text(input.agent,'agent',true),text:text(input.text,'text',true)};
      if(input.deliveryStatus!==undefined)content.deliveryStatus=text(input.deliveryStatus,'deliveryStatus');
      if(input.replyTo!==undefined)content.replyTo=text(input.replyTo,'replyTo');
      const existing=db.prepare('SELECT data FROM messages WHERE conversationId=? AND id=?').get(conversationId,content.id);
      if(existing) {
        const record=JSON.parse(existing.data);const {createdAt,offset,...previous}=record;
        if(JSON.stringify(previous)!==JSON.stringify(content))throw new Error('Message ID content conflict');return record;
      }
      const offset=db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversationId=?').get(conversationId).count;
      const record={...content,createdAt:now(),offset};
      db.prepare('INSERT INTO messages VALUES (?,?,?,?)').run(conversationId,record.id,offset,JSON.stringify(record));return record;
    });},
    messages(conversationId,{after=0,limit=100}={}) {
      get('conversations',conversationId);integer(after,0,Number.MAX_SAFE_INTEGER,'after');integer(limit,1,200,'limit');
      const total=db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversationId=?').get(conversationId).count;
      const messages=db.prepare('SELECT data FROM messages WHERE conversationId=? AND offset>=? ORDER BY offset LIMIT ?').all(conversationId,after,limit).map(row=>JSON.parse(row.data));
      return {messages,total,nextOffset:Math.min(after+messages.length,total)};
    },
    close() {db.close();}
  };
}
