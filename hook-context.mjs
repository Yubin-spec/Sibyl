import {attentionItems} from './attention.mjs';
import {projectKey as keyOf} from './project-path.mjs';

const TOOL_LABELS={claude:'Claude',codex:'Codex',cursor:'Cursor',workbuddy:'WorkBuddy'};
const ACTIONABLE=new Set(['awaiting-visibility','changes-required','deadlock','interrupted','reviewing','starting']);
const PLAN_LABELS={'awaiting-visibility':'等待确认可见','changes-required':'需要回应','deadlock':'死锁待裁决',interrupted:'中断待恢复',reviewing:'评审中',starting:'评审启动中'};

const text=value=>String(value??'').replace(/\s+/g,' ').trim();
const clip=(value,max)=>{const line=text(value);return line.length>max?line.slice(0,max-1)+'…':line;};
const label=tool=>TOOL_LABELS[tool]||text(tool)||'其他工具';

export function reviewAction(status){
  if(status==='awaiting-visibility') return '先确认评审在观测页实际可见，再由当前操作者会话调用 bridge_plan_review_continue({reviewId,confirmVisibility:true})；无法确认就保持等待。';
  if(status==='changes-required') return '由当前操作者会话逐条调用 bridge_plan_review_respond（已接管时为接管会话）。';
  if(status==='deadlock') return '需要人裁决；由当前操作者会话调用 bridge_plan_review_decide({reviewId,choice:"1"|"0"})。';
  if(status==='interrupted') return '原会话可 bridge_plan_review_recover；原会话不可用时，同项目另一个 Claude 会话可 recover({takeover:true})，接管后操作归属转移。';
  if(status==='reviewing'||status==='starting') return '由当前操作者会话调用 bridge_plan_review_result；其他会话只能在观测页查看。';
  return '';
}

export function inboxPublicView(snapshot={}){
  const questions=Array.isArray(snapshot?.questions)?snapshot.questions:[];
  const pending=questions.filter(question=>question&&['queued','delivered'].includes(question.status));
  return {...snapshot,pendingCount:pending.length,questionsTotal:questions.length,questions:questions.slice(-100)};
}

export function scopedHookData({projectKey=null,projects=[],conversations=[],consultations=[],reviews=[],requests=[],dismissed=[]}={}){
  const pairOnly=()=>attentionItems({requests,consultations:[],conversations:[],projects,dismissed});
  if(!projectKey) return {project:null,reviews:[],attention:pairOnly()};
  const project=projects.find(item=>keyOf(item.path)===projectKey)||null;
  const scopedReviews=reviews.filter(review=>keyOf(review.projectPath)===projectKey);
  const scopedConversations=project?conversations.filter(item=>item.projectId===project.id):[];
  const scopedConsultations=project?consultations.filter(item=>item.sourceProjectId===project.id||item.targetProjectId===project.id):[];
  return {
    project,
    reviews:scopedReviews,
    attention:attentionItems({requests,consultations:scopedConsultations,conversations:scopedConversations,projects,dismissed})
  };
}

export function buildHookContext({event='session-start',projectPath='',projectKey=null,projectName='',pendingQuestions=[],reviews=[],attention=[]}={}){
  const questions=projectKey&&Array.isArray(pendingQuestions)?pendingQuestions:[];
  const actionable=projectKey&&Array.isArray(reviews)?reviews.filter(review=>ACTIONABLE.has(review?.status)):[];
  const attentionItemsList=(Array.isArray(attention)?attention:[]).slice(0,3);
  const counts={own:0,sameTool:0,otherTool:0};
  for(const question of questions){
    if(question?.owner==='own') counts.own+=1;
    else if(question?.owner==='sameTool') counts.sameTool+=1;
    else counts.otherTool+=1;
  }
  const project=clip(projectName||projectPath,'100')||'未登记项目';
  const pendingTotal=questions.length;
  const hasItems=pendingTotal||actionable.length||attentionItemsList.length;
  if(event==='user-prompt'&&!hasItems) return '';

  const lines=[];
  if(event==='user-prompt'){
    lines.push('[AI Bridge] 只读提醒（不会把这些事项标记为已读，也不阻塞本条提示）：');
  }else{
    lines.push(`[AI Bridge] 项目：${project}。以下上下文由本机桥接只读生成。`);
    if(!projectKey) lines.push('- 项目路径无法校验，已跳过项目级事项；只显示全局事项。');
  }

  if(pendingTotal){
    lines.push(`- 待答问题 ${pendingTotal} 条：当前会话 ${counts.own} 条、本工具其他会话 ${counts.sameTool} 条、其他工具 ${counts.otherTool} 条。请在对应会话调用 bridge_receive 读取；本提醒不代替读取。`);
    for(const question of questions.slice(0,3)){
      const source=`${clip(question?.source?.title,'60')||'未知来源'}（${label(question?.source?.tool)}）`;
      const target=`${clip(question?.target?.title,'60')||'未知会话'}（${label(question?.target?.tool)}）`;
      lines.push(`  · 来自 ${source} → 发给 ${target}`);
    }
    if(pendingTotal>3) lines.push(`  · 还有 ${pendingTotal-3} 条未列出。`);
  }

  if(actionable.length){
    lines.push('- 计划评审：');
    for(const review of actionable.slice(0,3)){
      lines.push(`  · ${PLAN_LABELS[review.status]||review.status}：${clip(review.planPath,'100')||'未命名计划'}（${clip(review.reviewId,'40')||'无 ID'}）。${reviewAction(review.status)}`);
    }
    if(actionable.length>3) lines.push(`  · 还有 ${actionable.length-3} 个评审未列出；在观测页查看。`);
  }

  if(attentionItemsList.length){
    lines.push('- 待你处理：');
    for(const item of attentionItemsList){
      lines.push(`  · ${clip(item?.title,'80')||'需要处理'}${item?.detail?`：${clip(item.detail,'120')}`:''}`);
    }
  }

  if(event!=='user-prompt'){
    lines.push('- 处理问题用 bridge_receive / bridge_reply；查看状态用 `node scripts/sibyl.mjs status`，打开观测页用 `node scripts/sibyl.mjs open`。');
  }
  return lines.join('\n');
}
