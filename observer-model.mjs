export const OBSERVER_ACTIVE_REVIEWS = new Set(['starting', 'awaiting-visibility', 'reviewing', 'changes-required', 'deadlock', 'interrupted']);
export const OBSERVER_ACTIVE_WORKERS = new Set(['starting', 'running', 'orphan', 'exit-unconfirmed']);
const NEEDS_RESPONSE = new Set(['changes-required', 'deadlock']);

const names = {codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor', workbuddy: 'WorkBuddy'};
const pad = n => String(n).padStart(2, '0');
const agentName = tool => names[tool] || tool || '未选择工具';
const firstTime = record => record?.updatedAt || record?.startedAt || record?.createdAt || null;

export function observerTime(at, now = new Date()) {
  const ms = Date.parse(at ?? '');
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const clock = pad(date.getHours()) + ':' + pad(date.getMinutes());
  return date.toDateString() === now.toDateString() ? clock : pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + clock;
}

export function observerVerdict(review) {
  const verdict = review?.verdict;
  if (typeof verdict === 'string') return verdict;
  if (verdict && typeof verdict === 'object' && typeof verdict.verdict === 'string') return verdict.verdict;
  return '';
}

export function observerPipelineStats(state = {}) {
  const reviews = state.planReviews || [];
  const needingResponse = reviews.filter(review => NEEDS_RESPONSE.has(review.status)).length;
  return {
    reviews: reviews.filter(review => OBSERVER_ACTIVE_REVIEWS.has(review.status)).length,
    needingResponse,
    workers: (state.workers || []).filter(worker => OBSERVER_ACTIVE_WORKERS.has(worker.status)).length,
    attention: (state.attention || []).length + needingResponse
  };
}

export function observerTimelineItems(state = {}) {
  const items = [];
  for (const review of state.planReviews || []) {
    const verdict = observerVerdict(review);
    const issues = Array.isArray(review.issues) && review.issues.length ? review.issues.length + ' 个问题' : '';
    items.push({
      at: firstTime(review),
      stage: '计划评审',
      status: review.status || '',
      title: String(review.planPath || '').split(/[\\/]/).pop() || '计划',
      detail: ['第 ' + (review.round || 0) + '/' + (review.maxRounds || 3) + ' 轮', verdict, issues].filter(Boolean).join(' · '),
      anchor: 'observer-review-' + review.reviewId,
      needsResponse: NEEDS_RESPONSE.has(review.status)
    });
  }
  for (const worker of state.workers || []) {
    const report = worker.report;
    const handover = report ? '已交工' + (report.summary ? ' · ' + String(report.summary).slice(0, 80) : '') : '';
    items.push({
      at: firstTime(worker),
      stage: '工作方',
      status: worker.status || '',
      title: agentName(worker.tool) + ' · ' + (worker.tier || 'worker'),
      detail: [worker.model || '模型未指定', worker.effort, '第 ' + (worker.turns || 0) + ' 轮', handover].filter(Boolean).join(' · '),
      anchor: 'observer-worker-' + worker.workerId,
      needsResponse: false
    });
  }
  for (const consult of state.consultations || []) {
    items.push({
      at: firstTime(consult),
      stage: '核对',
      status: consult.status || '',
      title: '第 ' + (consult.round || 1) + ' 轮只读核对',
      detail: String(consult.question || '').slice(0, 80),
      anchor: 'observer-consult-' + consult.id,
      needsResponse: false
    });
  }
  for (const operation of state.operations || []) {
    items.push({
      at: operation.started || operation.startedAt || null,
      stage: '运行',
      status: operation.status || '',
      title: operation.label || '操作',
      detail: operation.connection ? '跨电脑' : '本机',
      anchor: 'observerOperations',
      needsResponse: false
    });
  }
  for (const item of state.attention || []) {
    items.push({
      at: item.at || null,
      stage: '待处理',
      status: 'attention',
      title: item.title || '需要处理',
      detail: item.detail || '',
      anchor: 'observerAttention',
      needsResponse: true
    });
  }
  return items
    .map((item, index) => ({item, index, ms: Date.parse(item.at ?? '')}))
    .sort((a, b) => {
      const aValid = Number.isFinite(a.ms), bValid = Number.isFinite(b.ms);
      if (aValid && bValid) return b.ms - a.ms || a.index - b.index;
      if (aValid) return -1;
      if (bValid) return 1;
      return a.index - b.index;
    })
    .slice(0, 60)
    .map(entry => entry.item);
}
