import {readFile as readFileAsync} from 'node:fs/promises';
import {join} from 'node:path';

export const CODEX_MODELS = Object.freeze(['gpt-6.1-sol','gpt-6-astra','gpt-6.1-terra','gpt-6-sol','gpt-6-luna','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna']);

const EFFORTS = ['low', 'medium', 'high', 'ultra'];
const KINDS = ['review', 'implement', 'mechanical', 'frontier'];
const RISKS = ['normal', 'high'];
const NO_ULTRA_MODELS = new Set(['gpt-6-luna', 'gpt-5.6-luna', 'gpt-reserve', 'codex-auto-review']);

export function supportsEffort(model, effort) {
  return effort !== 'ultra' || !NO_ULTRA_MODELS.has(model);
}

function assertEffortSupport(path, leaf) {
  if (!supportsEffort(leaf.model, leaf.effort)) {
    throw Error(path + '.effort ultra is not supported by ' + leaf.model + '; set an explicit compatible effort such as high');
  }
}

export const DEFAULT_CODEX_POLICY = Object.freeze({
  mechanical: Object.freeze({model: 'gpt-6-luna', effort: 'low'}),
  review: Object.freeze({
    normal: Object.freeze({model: 'gpt-6-astra', effort: 'ultra'}),
    high: Object.freeze({model: 'gpt-6-astra', effort: 'ultra'})
  }),
  implement: Object.freeze({
    normal: Object.freeze({model: 'gpt-6.1-sol', effort: 'medium'}),
    high: Object.freeze({model: 'gpt-6.1-sol', effort: 'high'})
  }),
  frontier: Object.freeze({model: 'gpt-6-astra', effort: 'high'})
});

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(label + ' must be an object');
}

function readLeaf(value, path) {
  assertObject(value, path);
  const leaf = {};
  for (const key of Object.keys(value)) {
    if (key === 'model') {
      if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 80) throw Error(path + '.model must be a non-empty string up to 80 characters');
      leaf.model = value.model.trim();
    } else if (key === 'effort') {
      if (!EFFORTS.includes(value.effort)) throw Error(path + '.effort must be low, medium, high or ultra');
      leaf.effort = value.effort;
    } else {
      throw Error('Unknown policy key: ' + path + '.' + key);
    }
  }
  return leaf;
}

export function normalizeModelPolicy(value) {
  assertObject(value, 'policy');
  for (const key of Object.keys(value)) if (key !== 'version' && key !== 'codex') throw Error('Unknown policy key: ' + key);
  if (value.version !== 1) throw Error('Unsupported policy version: ' + String(value.version));

  const policy = {
    mechanical: {...DEFAULT_CODEX_POLICY.mechanical},
    review: {normal: {...DEFAULT_CODEX_POLICY.review.normal}, high: {...DEFAULT_CODEX_POLICY.review.high}},
    implement: {normal: {...DEFAULT_CODEX_POLICY.implement.normal}, high: {...DEFAULT_CODEX_POLICY.implement.high}},
    frontier: {...DEFAULT_CODEX_POLICY.frontier}
  };
  if (value.codex !== undefined) {
    assertObject(value.codex, 'codex');
    for (const [kind, entry] of Object.entries(value.codex)) {
      if (!KINDS.includes(kind)) throw Error('Unknown policy key: codex.' + kind);
      if (kind === 'mechanical' || kind === 'frontier') {
        Object.assign(policy[kind], readLeaf(entry, 'codex.' + kind));
        continue;
      }
      assertObject(entry, 'codex.' + kind);
      for (const [risk, leaf] of Object.entries(entry)) {
        if (!RISKS.includes(risk)) throw Error('Unknown policy key: codex.' + kind + '.' + risk);
        Object.assign(policy[kind][risk], readLeaf(leaf, 'codex.' + kind + '.' + risk));
      }
    }
  }
  assertEffortSupport('codex.mechanical', policy.mechanical);
  assertEffortSupport('codex.review.normal', policy.review.normal);
  assertEffortSupport('codex.review.high', policy.review.high);
  assertEffortSupport('codex.implement.normal', policy.implement.normal);
  assertEffortSupport('codex.implement.high', policy.implement.high);
  assertEffortSupport('codex.frontier', policy.frontier);
  return Object.freeze({
    mechanical: Object.freeze(policy.mechanical),
    review: Object.freeze({normal: Object.freeze(policy.review.normal), high: Object.freeze(policy.review.high)}),
    implement: Object.freeze({normal: Object.freeze(policy.implement.normal), high: Object.freeze(policy.implement.high)}),
    frontier: Object.freeze(policy.frontier)
  });
}

export function chooseCodexModel({tier = 'consult', kind = null, risk = 'normal', policy = DEFAULT_CODEX_POLICY} = {}) {
  const k = kind ?? (tier === 'consult' ? 'review' : 'implement');
  if (!KINDS.includes(k)) throw Error('kind must be review, implement, mechanical or frontier');
  if (!RISKS.includes(risk)) throw Error('risk must be normal or high');
  const byRisk = k === 'review' || k === 'implement';
  const leaf = byRisk ? policy[k][risk] : policy[k];
  const base = byRisk ? DEFAULT_CODEX_POLICY[k][risk] : DEFAULT_CODEX_POLICY[k];
  const reason = k === 'mechanical' ? 'mechanical'
    : k === 'frontier' ? 'frontier'
      : k === 'review' ? (risk === 'high' ? 'review-high-risk' : 'review')
        : (risk === 'high' ? 'implement-high-risk' : 'implement');
  const changed = leaf.model !== base.model || leaf.effort !== base.effort;
  return {model: leaf.model, effort: leaf.effort, reason: changed ? 'project:' + reason : reason};
}

export async function loadModelPolicy(projectPath, {readFile = readFileAsync} = {}) {
  const path = join(projectPath, '.sibyl', 'models.json');
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {policy: DEFAULT_CODEX_POLICY, configured: false, path};
    throw Error('Invalid model policy: ' + path + ': ' + (error?.message ?? String(error)));
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw Error('Invalid model policy: ' + path + ': ' + error.message);
  }
  let policy;
  try {
    policy = normalizeModelPolicy(value);
  } catch (error) {
    throw Error('Invalid model policy: ' + path + ': ' + error.message);
  }
  return {policy, configured: true, path};
}
