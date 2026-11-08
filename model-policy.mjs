export const CODEX_MODELS = Object.freeze(['gpt-6.1-sol','gpt-6-astra','gpt-6.1-terra','gpt-6-sol','gpt-6-luna','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna']);

export function chooseCodexModel({tier = 'consult', kind = null, risk = 'normal'} = {}) {
  const k = kind ?? (tier === 'consult' ? 'review' : 'implement');
  if (!['review', 'implement', 'mechanical', 'frontier'].includes(k)) throw new Error('kind must be review, implement, mechanical or frontier');
  if (!['normal', 'high'].includes(risk)) throw new Error('risk must be normal or high');
  if (k === 'mechanical') return {model: 'gpt-6-luna', effort: 'low', reason: 'mechanical'};
  if (k === 'frontier') return {model: 'gpt-6-astra', effort: 'high', reason: 'frontier'};
  if (k === 'review') return risk === 'high'
    ? {model: 'gpt-6.1-sol', effort: 'high', reason: 'review-high-risk'}
    : {model: 'gpt-6.1-terra', effort: 'medium', reason: 'review'};
  return risk === 'high'
    ? {model: 'gpt-6.1-sol', effort: 'high', reason: 'implement-high-risk'}
    : {model: 'gpt-6.1-sol', effort: 'medium', reason: 'implement'};
}
