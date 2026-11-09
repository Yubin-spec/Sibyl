const reviewStatuses = new Set(['failed', 'stalled', 'timeout', 'interrupted']);

const clip = (value, max = 180) => {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
};

const projectName = (projects, id) => projects.find(project => project.id === id)?.name || '';

const detailForConsult = (record, projects) => {
  const route = record.route || {};
  const source = route.sourceProjectName || projectName(projects, record.sourceProjectId);
  const target = route.targetProjectName || projectName(projects, record.targetProjectId);
  const path = [source, target].filter(Boolean).join(' → ');
  const reason = clip(record.error || record.stopReason || '本次只读核对已停止，来源任务未受影响。');
  return [path, reason].filter(Boolean).join(' · ');
};

export function attentionItems({requests = [], consultations = [], conversations = [], projects = [], dismissed = []} = {}) {
  const ignored = new Set(Array.isArray(dismissed) ? dismissed : []);
  const items = [];

  for (const request of Array.isArray(requests) ? requests : []) {
    if (!request?.id) continue;
    items.push({
      key: `pair:${request.id}`,
      kind: 'pair',
      title: `${clip(request.name, 80) || '未知电脑'} 请求配对`,
      detail: `${clip(request.ip, 80) || '未知地址'} · 同意后对方将获得独立连接权限`,
      pairId: request.id,
      at: request.createdAt || request.at || null,
      dismissible: false
    });
  }

  for (const record of Array.isArray(consultations) ? consultations : []) {
    if (!record?.id || !reviewStatuses.has(record.status)) continue;
    items.push({
      key: `consult:${record.id}:${record.updatedAt || record.startedAt || ''}`,
      kind: 'consult',
      title: '只读核对已停止',
      detail: detailForConsult(record, projects),
      consultId: record.id,
      at: record.updatedAt || record.startedAt || null,
      dismissible: true
    });
  }

  for (const conversation of Array.isArray(conversations) ? conversations : []) {
    if (!conversation?.id || conversation.status !== 'failed' || conversation.archived) continue;
    const project = projectName(projects, conversation.projectId);
    const reason = clip(conversation.stopReason || '运行失败，详情见会话运行记录。');
    items.push({
      key: `conversation:${conversation.id}:${conversation.updatedAt || ''}`,
      kind: 'conversation',
      title: `会话执行失败 · ${clip(conversation.title, 80) || '未命名会话'}`,
      detail: [project, reason].filter(Boolean).join(' · '),
      conversationId: conversation.id,
      at: conversation.updatedAt || conversation.createdAt || null,
      dismissible: true
    });
  }

  const order = {pair: 0, consult: 1, conversation: 2};
  return items.filter(item => !item.dismissible || !ignored.has(item.key)).sort((a, b) => order[a.kind] - order[b.kind]);
}
