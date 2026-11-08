import {createHash} from 'node:crypto';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';

export const PLAN_REVIEW_OPEN = '<<<SIBYL_REVIEW';
export const PLAN_REVIEW_CLOSE = 'SIBYL_REVIEW>>>';
export const REVIEW_BEGIN = '<!-- SIBYL_REVIEW_BEGIN -->';
export const REVIEW_END = '<!-- SIBYL_REVIEW_END -->';
export const PROTOCOL_VERSION = 'plan-review/v1';
export const HASH_VERSION = 1;

export const REVIEW_STATES = Object.freeze([
  'awaiting-visibility', 'reviewing', 'changes-required', 'deadlock',
  'approved', 'rejected', 'cancelled', 'interrupted', 'failed'
]);

export const DEFAULT_PLAN_REVIEW = Object.freeze({
  protocolVersion: PROTOCOL_VERSION,
  hashVersion: HASH_VERSION,
  maxRounds: 3,
  wholeReviewMs: 60 * 60 * 1000,
  turnMs: 10 * 60 * 1000,
  maxPlanBytes: 204800,
  maxIssues: 20,
  maxFocusItems: 20,
  maxResponsesBytes: 12000,
  reviewerModel: 'auto',
  reviewerFinalModel: 'gpt-6-astra',
  reviewerEffort: 'high'
});

const REVIEW_VALUES = new Set(['required', 'not-required', 'approved', 'provisional', 'waived']);
const VERDICTS = new Set(['approve', 'changes-required', 'discuss']);
const SEVERITIES = new Set(['blocker', 'major', 'minor']);
const ISSUE_ID = /^[A-Za-z0-9_-]{1,20}$/;
const QUESTION_ID = /^Q\d+$/;

function stripBom(text) {
  return String(text ?? '').replace(/^﻿/, '');
}

function normalizeNewlines(text) {
  return stripBom(text).replace(/\r\n?/g, '\n');
}

function defaultChange() {
  return {scope: [], concurrency: false, irreversible: false, tasks: 0, files: 0, reason: ''};
}

function parseScalar(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^-?\d+$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map(item => item.trim()).filter(Boolean);
  }
  return value;
}

function parseFrontmatter(lines) {
  const errors = [];
  const change = defaultChange();
  let review = null;
  let inChange = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = /^\s*/.exec(line)[0].length;
    const text = line.trim();
    if (indent === 0) {
      const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(text);
      if (!match) {
        errors.push('Invalid frontmatter line: ' + text);
        continue;
      }
      const [, key, raw] = match;
      if (key === 'review') {
        review = parseScalar(raw);
        if (!REVIEW_VALUES.has(review)) errors.push('Invalid review status: ' + review);
      } else if (key === 'change') {
        inChange = true;
        if (raw) errors.push('change must be a mapping');
      } else {
        inChange = false;
      }
      continue;
    }
    if (!inChange) continue;
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(text);
    if (!match) {
      errors.push('Invalid change line: ' + text);
      continue;
    }
    const [, key, raw] = match;
    if (key === 'scope') {
      if (raw) {
        const value = parseScalar(raw);
        change.scope = Array.isArray(value) ? value : [value];
      } else {
        change.scope = [];
        for (let next = index + 1; next < lines.length; next++) {
          const item = lines[next].trim();
          if (!item) continue;
          if (!item.startsWith('-')) break;
          change.scope.push(item.slice(1).trim());
          index = next;
        }
      }
    } else if (key === 'concurrency' || key === 'irreversible') {
      const value = parseScalar(raw);
      if (typeof value !== 'boolean') errors.push('Invalid ' + key);
      else change[key] = value;
    } else if (key === 'tasks' || key === 'files') {
      const value = parseScalar(raw);
      if (!Number.isInteger(value) || value < 0) errors.push('Invalid ' + key);
      else change[key] = value;
    } else if (key === 'reason') {
      change.reason = String(parseScalar(raw));
    }
  }
  return {review, change, errors};
}

export function scanGeneratedBlocks(text) {
  const lines = normalizeNewlines(text).split('\n');
  const blocks = [];
  const errors = [];
  let fence = null;
  let begin = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const char = marker[1][0];
      const length = marker[1].length;
      if (!fence) fence = {char, length};
      else if (fence.char === char && length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const trimmed = line.replace(/\s+$/, '');
    if (trimmed === REVIEW_BEGIN) {
      if (begin >= 0) errors.push('Nested review block');
      else begin = index;
    } else if (trimmed === REVIEW_END) {
      if (begin < 0) errors.push('Review end without begin');
      else {
        blocks.push({start: begin, end: index});
        begin = -1;
      }
    }
  }
  if (begin >= 0) errors.push('Unclosed review block');
  if (blocks.length > 1) errors.push('Multiple review blocks');
  return {blocks, errors};
}

export function stripGeneratedReview(text) {
  const source = normalizeNewlines(text);
  const {blocks} = scanGeneratedBlocks(source);
  if (!blocks.length) return source;
  const lines = source.split('\n');
  const drop = new Set();
  for (const block of blocks) {
    for (let index = block.start; index <= block.end; index++) drop.add(index);
  }
  return lines.filter((_, index) => !drop.has(index)).join('\n');
}

function canonicalChange(change = {}) {
  const scope = [...new Set((Array.isArray(change.scope) ? change.scope : [])
    .map(item => String(item).trim())
    .filter(Boolean))]
    .sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
  return {
    scope,
    concurrency: change.concurrency === true,
    irreversible: change.irreversible === true,
    tasks: Number.isInteger(change.tasks) && change.tasks >= 0 ? change.tasks : 0,
    files: Number.isInteger(change.files) && change.files >= 0 ? change.files : 0
  };
}

function canonicalBody(body) {
  return stripGeneratedReview(body).replace(/\s+$/, '');
}

export function planInputHash(change, body) {
  const source = [
    'plan-review/v1',
    JSON.stringify(canonicalChange(change)),
    canonicalBody(body)
  ].join('\n');
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

export function parseFocus(body) {
  const lines = normalizeNewlines(body).split('\n');
  const items = [];
  let fence = null;
  let inFocus = false;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const char = marker[1][0];
      const length = marker[1].length;
      if (!fence) fence = {char, length};
      else if (fence.char === char && length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const text = line.trim();
    if (/^##\s+Review Focus\s*$/i.test(text)) {
      inFocus = true;
      continue;
    }
    if (inFocus && /^##\s+/.test(text)) break;
    if (!inFocus) continue;
    const match = /^(?:[-*]|\d+\.)\s+(.+)$/.exec(text);
    if (match) items.push(match[1].trim());
  }
  return items.slice(0, DEFAULT_PLAN_REVIEW.maxFocusItems).map((text, index) => ({id: 'F' + (index + 1), text}));
}

export function parsePlanDeclaration(text) {
  const source = normalizeNewlines(text);
  const lines = source.split('\n');
  let review = null;
  let change = defaultChange();
  let errors = [];
  let body = source;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end < 0) {
      errors = ['Unterminated frontmatter'];
    } else {
      const parsed = parseFrontmatter(lines.slice(1, end));
      review = parsed.review;
      change = parsed.change;
      errors = parsed.errors;
      body = lines.slice(end + 1).join('\n');
    }
  }
  const scan = scanGeneratedBlocks(body);
  errors = errors.concat(scan.errors);
  const focus = parseFocus(body);
  const inputHash = planInputHash(change, body);
  return {review, change, body, focus, inputHash, errors};
}

export function isStructural(parsed) {
  const reasons = [];
  if (parsed.review === 'required') reasons.push('review:required');
  for (const item of parsed.change.scope ?? []) reasons.push('scope:' + item);
  if (parsed.change.concurrency) reasons.push('concurrency');
  if (parsed.change.irreversible) reasons.push('irreversible');
  if ((parsed.change.tasks ?? 0) >= 5) reasons.push('tasks:' + parsed.change.tasks);
  if ((parsed.change.files ?? 0) >= 5) reasons.push('files:' + parsed.change.files);
  return {required: reasons.length > 0, reasons};
}

export function parseVerdict(text, {focus = []} = {}) {
  const source = String(text ?? '');
  const blocks = [...source.matchAll(/<<<SIBYL_REVIEW\s*([\s\S]*?)\s*SIBYL_REVIEW>>>/g)];
  if (blocks.length !== 1) return {ok: false, error: 'Verdict must contain exactly one SIBYL_REVIEW block'};
  let value;
  try {
    value = JSON.parse(blocks[0][1]);
  } catch {
    return {ok: false, error: 'Verdict is not valid JSON'};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {ok: false, error: 'Verdict must be an object'};
  if (!VERDICTS.has(value.verdict)) return {ok: false, error: 'Invalid verdict'};
  const summary = typeof value.summary === 'string' ? value.summary.slice(0, 2000) : '';
  const issues = Array.isArray(value.issues) ? value.issues : [];
  if (issues.length > DEFAULT_PLAN_REVIEW.maxIssues) return {ok: false, error: 'Too many issues'};
  const seen = new Set();
  const normalizedIssues = [];
  for (const issue of issues) {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return {ok: false, error: 'Invalid issue'};
    const id = typeof issue.id === 'string' ? issue.id : '';
    if (!ISSUE_ID.test(id) || QUESTION_ID.test(id)) return {ok: false, error: 'Invalid issue id'};
    if (seen.has(id)) return {ok: false, error: 'Duplicate issue id'};
    seen.add(id);
    if (!SEVERITIES.has(issue.severity)) return {ok: false, error: 'Invalid severity'};
    for (const field of ['location', 'problem', 'why', 'suggestion']) {
      if (typeof issue[field] !== 'string' || !issue[field].trim()) return {ok: false, error: 'Invalid issue ' + field};
    }
    normalizedIssues.push({
      id,
      severity: issue.severity,
      location: issue.location.slice(0, 500),
      problem: issue.problem.slice(0, 2000),
      why: issue.why.slice(0, 2000),
      suggestion: issue.suggestion.slice(0, 2000)
    });
  }
  const rawQuestions = Array.isArray(value.questions) ? value.questions : [];
  if (rawQuestions.length > DEFAULT_PLAN_REVIEW.maxIssues) return {ok: false, error: 'Too many questions'};
  const questions = rawQuestions.map((question, index) => ({
    id: 'Q' + (index + 1),
    text: String(typeof question === 'string' ? question : question?.text ?? '').slice(0, 2000)
  })).filter(question => question.text.trim());
  const hasBlocking = normalizedIssues.some(issue => issue.severity === 'blocker' || issue.severity === 'major');
  if (value.verdict === 'approve' && hasBlocking) return {ok: false, error: 'approve cannot include blocker or major'};
  if (value.verdict === 'changes-required' && !hasBlocking) return {ok: false, error: 'changes-required needs a blocker or major'};
  if (value.verdict === 'discuss' && !normalizedIssues.length && !questions.length) return {ok: false, error: 'discuss needs issues or questions'};
  let focusWarning = null;
  if (focus.length) {
    const haystack = [
      ...normalizedIssues.flatMap(issue => [issue.location, issue.problem, issue.why, issue.suggestion]),
      ...questions.map(question => question.text)
    ].join(' ');
    if (!focus.some(item => haystack.includes(item.id))) focusWarning = 'Review Focus 未被引用';
  }
  return {
    ok: true,
    verdict: {verdict: value.verdict, summary, issues: normalizedIssues, questions},
    ...(focusWarning ? {focusWarning} : {})
  };
}

function updateFrontmatterReview(text, status) {
  const lines = normalizeNewlines(text).split('\n');
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end < 0) throw Error('Unterminated frontmatter');
    let found = false;
    for (let index = 1; index < end; index++) {
      if (/^review:\s*/.test(lines[index])) {
        lines[index] = 'review: ' + status;
        found = true;
        break;
      }
    }
    if (!found) lines.splice(1, 0, 'review: ' + status);
    return lines.join('\n');
  }
  return '---\nreview: ' + status + '\n---\n\n' + lines.join('\n');
}

export function writeCodexReviewSection(text, input = {}) {
  const source = normalizeNewlines(text);
  const scan = scanGeneratedBlocks(source);
  if (scan.errors.length) throw Error(scan.errors[0]);
  if (scan.blocks.length > 1) throw Error('Multiple review blocks');
  const lines = source.split('\n');
  const status = String(input.status ?? 'approved');
  const block = [
    REVIEW_BEGIN,
    '## Codex review',
    '',
    '- 状态：' + status,
    '- 结论：' + String(input.summary ?? ''),
    '- 评审模型：' + String(input.reviewer ?? 'codex'),
    '- 轮次：' + String(input.round ?? ''),
    '- 采纳：' + (Array.isArray(input.accepted) ? input.accepted.join(', ') : String(input.accepted ?? '')),
    '- 残留风险：' + (Array.isArray(input.residualRisks) ? input.residualRisks.join('; ') : String(input.residualRisks ?? '')),
    REVIEW_END
  ];
  let next;
  if (scan.blocks.length === 1) {
    const {start, end} = scan.blocks[0];
    next = [...lines.slice(0, start), ...block, ...lines.slice(end + 1)].join('\n');
  } else {
    const prefix = source.endsWith('\n') ? source : source + '\n';
    next = prefix + '\n' + block.join('\n') + '\n';
  }
  return updateFrontmatterReview(next, status);
}

export async function findPlanFiles(projectPath) {
  const found = [];
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await readdir(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.sibyl' || entry.name === '.git' || entry.name === 'node_modules') continue;
      if (entry.isSymbolicLink()) continue;
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), relative);
      } else if (entry.isFile() && (
        (relative.startsWith('docs/superpowers/plans/') && relative.endsWith('.md')) ||
        (!relative.includes('/') && relative.endsWith('.plan.md'))
      )) {
        found.push(relative);
      }
    }
  }
  await walk(projectPath, '');
  return found.sort();
}

export function normalizeReviewConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid plan review config');
  const numeric = ['maxRounds', 'wholeReviewMs', 'turnMs', 'maxPlanBytes', 'maxIssues', 'maxFocusItems', 'maxResponsesBytes'];
  const strings = ['reviewerModel', 'reviewerFinalModel', 'reviewerEffort'];
  const out = {...DEFAULT_PLAN_REVIEW};
  for (const [key, next] of Object.entries(value)) {
    if (key === 'protocolVersion') {
      if (next !== PROTOCOL_VERSION) throw Error('Unsupported protocolVersion');
      continue;
    }
    if (key === 'hashVersion') {
      if (next !== HASH_VERSION) throw Error('Unsupported hashVersion');
      continue;
    }
    if (numeric.includes(key)) {
      if (!Number.isInteger(next) || next < 1) throw Error('Invalid ' + key);
      out[key] = next;
    } else if (strings.includes(key)) {
      if (typeof next !== 'string' || !next.trim()) throw Error('Invalid ' + key);
      out[key] = next;
    } else {
      throw Error('Unsupported plan review config: ' + key);
    }
  }
  out.protocolVersion = PROTOCOL_VERSION;
  out.hashVersion = HASH_VERSION;
  return out;
}

export function buildReviewPrompt(input = {}) {
  const focus = Array.isArray(input.focus) && input.focus.length
    ? input.focus.map(item => '- ' + item.id + ': ' + item.text).join('\n')
    : '- (none declared)';
  return [
    '你是独立评审者，只读。任务：找出这份计划会失败的理由，不是确认它可行。',
    '',
    '计划快照（权威输入，请读取）：' + String(input.snapshotPath ?? ''),
    '项目根：' + String(input.projectPath ?? ''),
    '计划路径：' + String(input.planPath ?? ''),
    '轮次：' + String(input.round ?? 1),
    '',
    'Review Focus：',
    focus,
    '',
    input.previous ? '上一轮结论与回应：\n' + String(input.previous) + '\n' : '',
    input.constraints ? '项目约束：\n' + String(input.constraints).slice(0, 4000) + '\n' : '',
    '要求：',
    '- 只读；不要修改任何文件。',
    '- 每条 issue 必须引用具体段落或文件位置；禁止空泛建议。',
    '- 输出恰好一个块，格式：',
    '<<<SIBYL_REVIEW',
    '{"verdict":"approve|changes-required|discuss","summary":"...","issues":[{"id":"R1","severity":"blocker|major|minor","location":"...","problem":"...","why":"...","suggestion":"..."}],"questions":["..."]}',
    'SIBYL_REVIEW>>>',
    '- approve 不能带 blocker/major；changes-required 至少一个 blocker/major。',
    '- 最多 ' + DEFAULT_PLAN_REVIEW.maxIssues + ' 条 issue。'
  ].filter(Boolean).join('\n');
}

export function buildResponsePrompt(input = {}) {
  return [
    '这是同一计划的下一轮评审。执行方已逐条回应，计划可能已修改。',
    '',
    '当前计划快照（权威输入，请读取）：' + String(input.snapshotPath ?? ''),
    '项目根：' + String(input.projectPath ?? ''),
    '轮次：' + String(input.round ?? 2),
    '',
    '上一轮 verdict 与回应：',
    String(input.previous ?? ''),
    '',
    input.constraints ? '项目约束：\n' + String(input.constraints).slice(0, 4000) + '\n' : '',
    '要求：',
    '- 重新评审完整当前计划，不要只看未解决项；上一轮结论只作上下文。',
    '- 只读；不要修改任何文件。',
    '- 输出恰好一个块：',
    '<<<SIBYL_REVIEW',
    '{"verdict":"approve|changes-required|discuss","summary":"...","issues":[...],"questions":[...]}',
    'SIBYL_REVIEW>>>',
    '- approve 不能带 blocker/major；changes-required 至少一个 blocker/major。'
  ].filter(Boolean).join('\n');
}
