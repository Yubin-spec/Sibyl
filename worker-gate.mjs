const WRITE_TIERS = new Set(['dispatch', 'parallel']);

function blockingPlan(result) {
  if (!Array.isArray(result?.plans)) return null;
  return result.plans.find(plan => plan && plan.approved === false && typeof plan.path === 'string' && plan.path)?.path ?? null;
}

function refusal(result) {
  const plan = blockingPlan(result);
  const reason = typeof result?.reason === 'string' ? result.reason.trim() : '';
  if (plan && !reason.includes(plan)) return '结构计划未通过评审：' + plan;
  return reason || (plan ? '结构计划未通过评审：' + plan : '结构计划未通过评审');
}

export async function gateWorkerStart({tier, projectPath, check} = {}) {
  if (!WRITE_TIERS.has(tier)) return {allowed: true};
  if (typeof projectPath !== 'string' || !projectPath.trim()) return {allowed: false, reason: 'Worker start requires a project path'};
  if (typeof check !== 'function') return {allowed: false, reason: 'Plan review is unavailable: no reviewer is configured'};
  let result;
  try {
    result = await check({projectPath, strict: true});
  } catch (error) {
    return {allowed: false, reason: 'Plan review is unavailable: ' + (error?.message || 'check failed')};
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.block !== 'boolean') {
    return {allowed: false, reason: 'Plan review returned an invalid result'};
  }
  if (result.block === false) return {allowed: true};
  return {allowed: false, reason: refusal(result)};
}
