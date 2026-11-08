import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {pathWithin,isSharedPath} from './path-scope.mjs';

const run = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_PATCH = 64 * 1024 * 1024;
export const REPORT_OPEN = '<<<SIBYL_REPORT';
export const REPORT_CLOSE = 'SIBYL_REPORT>>>';

const clip = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const list = value => Array.isArray(value) ? value.slice(0, 20).map(item => clip(item, 500)) : [];
const objects = (value, fields) => Array.isArray(value) ? value.slice(0, 20).map(item => {
  const out = {};
  for (const field of fields) {
    if (item?.[field] !== undefined) out[field] = clip(item[field], field === 'evidence' || field === 'reason' ? 1000 : 500);
  }
  return out;
}) : [];

export function parseWorkerReport(text) {
  const raw = typeof text === 'string' ? text : '';
  const open = raw.lastIndexOf(REPORT_OPEN);
  if (open < 0) return {reported: false, summary: raw.slice(-2000), verification: [], unfinished: [], blockers: [], changeRequests: [], acceptanceCriteria: [], risks: []};
  const close = raw.indexOf(REPORT_CLOSE, open);
  if (close < 0) return {reported: false, summary: '', verification: [], unfinished: [], blockers: [], changeRequests: [], acceptanceCriteria: [], risks: []};
  let value;
  try {
    value = JSON.parse(raw.slice(open + REPORT_OPEN.length, close).trim());
  } catch {
    return {reported: false, summary: '', verification: [], unfinished: [], blockers: [], changeRequests: [], acceptanceCriteria: [], risks: []};
  }
  return {
    reported: true,
    summary: clip(value?.summary, 2000),
    verification: objects(value?.verification, ['command', 'result', 'exitCode', 'cwd', 'logPath']),
    unfinished: list(value?.unfinished),
    blockers: list(value?.blockers),
    changeRequests: objects(value?.changeRequests, ['path', 'reason']),
    acceptanceCriteria: objects(value?.acceptanceCriteria, ['criterion', 'status', 'evidence']),
    risks: list(value?.risks)
  };
}

async function git(cwd, ...args) {
  const {stdout} = await run('git', args, {cwd, maxBuffer: MAX_BUFFER});
  return stdout;
}

function parseNameStatus(output) {
  const chunks = output.split('\0');
  const changed = [];
  for (let index = 0; index < chunks.length;) {
    const status = chunks[index++];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = chunks[index++];
      const to = chunks[index++];
      if (from && to) changed.push({status: status[0], from, path: to});
    } else {
      const path = chunks[index++];
      if (path) changed.push({status: status[0], path});
    }
  }
  return changed;
}

function parseRawUnsafe(output) {
  const chunks = output.split('\0');
  const unsafe = [];
  for (let index = 0; index < chunks.length;) {
    const header = chunks[index++];
    if (!header) continue;
    const fields = header.split(' ');
    const oldMode = fields[0]?.replace(/^:/, '');
    const newMode = fields[1];
    const status = fields[4] || '';
    const count = /^[RC]/.test(status) ? 2 : 1;
    const paths = chunks.slice(index, index + count);
    index += count;
    if ([oldMode, newMode].includes('120000') || [oldMode, newMode].includes('160000')) unsafe.push(...paths.filter(Boolean));
  }
  return unsafe;
}

export async function collectWorkerReport({worktreePath, projectPath, workerId, snapshotCommit, headCommit, text = '', scope = [], sharedExtra = []}) {
  const range = `${snapshotCommit}..${headCommit}`;
  const changed = parseNameStatus(await git(worktreePath, 'diff', '--name-status', '-z', '--find-renames', range));
  const unsafeChanges = [...new Set(parseRawUnsafe(await git(worktreePath, 'diff', '--raw', '-z', range)))].sort();

  const files = {added: [], modified: [], deleted: [], renamed: []};
  for (const entry of changed) {
    if (entry.from) files.renamed.push({from: entry.from, to: entry.path});
    else if (entry.status === 'A') files.added.push(entry.path);
    else if (entry.status === 'D') files.deleted.push(entry.path);
    else files.modified.push(entry.path);
  }
  for (const key of Object.keys(files)) if (Array.isArray(files[key])) files[key].sort((a, b) => (typeof a === 'string' ? a : a.to).localeCompare(typeof b === 'string' ? b : b.to));

  let insertions = 0;
  let deletions = 0;
  for (const line of (await git(worktreePath, 'diff', '--numstat', range)).split(/\r?\n/)) {
    if (!line) continue;
    const [added, removed] = line.split('\t');
    if (/^\d+$/.test(added)) insertions += Number(added);
    if (/^\d+$/.test(removed)) deletions += Number(removed);
  }

  let patch = '';
  let patchError = null;
  try {
    patch = await git(worktreePath, 'diff', '--binary', range);
  } catch (error) {
    patchError = error.message;
  }
  const patchBytes = Buffer.byteLength(patch);
  const tooBig = patchBytes > MAX_PATCH || Boolean(patchError);

  const allPaths = [...new Set(changed.flatMap(entry => entry.from ? [entry.from, entry.path] : [entry.path]))].sort();
  const sharedChanged = allPaths.filter(path => isSharedPath(path, {extra: sharedExtra}));
  const outOfScope = allPaths.filter(path => !scope.some(entry => pathWithin(entry, path)) && !sharedChanged.includes(path));

  const parsed = parseWorkerReport(text);
  const reviewReasons = [];
  if (outOfScope.length) reviewReasons.push(`越界改动：${outOfScope.join(', ')}`);
  if (sharedChanged.length) reviewReasons.push(`改动了共享文件：${sharedChanged.join(', ')}`);
  if (unsafeChanges.length) reviewReasons.push(`改动了符号链接或子模块：${unsafeChanges.join(', ')}`);
  if (!parsed.reported) reviewReasons.push('工作方没有给出机器可读的交工报告');
  if (!parsed.verification.length) reviewReasons.push('工作方没有记录验证结果');
  for (const item of parsed.verification) {
    if (item.result === 'fail') reviewReasons.push(`验证未通过：${item.command}`);
    else if (item.result === 'not-run') reviewReasons.push(`验证未执行：${item.command}`);
  }
  if (tooBig) reviewReasons.push('补丁超过 64MB 或无法读取，未生成可交付补丁');

  let deliverableReason = null;
  if (outOfScope.length) deliverableReason = `越界改动：${outOfScope.join(', ')}`;
  else if (sharedChanged.length) deliverableReason = `改动了共享文件：${sharedChanged.join(', ')}`;
  else if (unsafeChanges.length) deliverableReason = `改动了符号链接或子模块：${unsafeChanges.join(', ')}`;
  else if (tooBig) deliverableReason = '补丁超过 64MB 或无法读取';

  const result = {
    workerId,
    snapshotCommit,
    headCommit,
    changed,
    files,
    stats: {files: allPaths.length, insertions, deletions, patchBytes},
    scope: {declared: scope, outOfScope, sharedChanged},
    unsafeChanges,
    verification: parsed.verification,
    verificationSource: 'worker-self-report',
    unfinished: parsed.unfinished,
    blockers: parsed.blockers,
    changeRequests: parsed.changeRequests,
    acceptanceCriteria: parsed.acceptanceCriteria,
    risks: parsed.risks,
    acceptance: 'pending',
    summary: parsed.summary,
    reported: parsed.reported,
    needsReview: reviewReasons.length > 0,
    reviewReasons,
    deliverable: {path: null, reason: deliverableReason},
    ...(patchError ? {patchError} : {})
  };
  Object.defineProperty(result, 'patchText', {value: patch, enumerable: false});
  return result;
}

async function atomicWrite(file, data) {
  const temporary = file + '.tmp';
  await writeFile(temporary, data, {mode: 0o600});
  await rename(temporary, file);
}

export async function writeWorkerReport({projectPath, workerId, report, patch = '', deliverablePatch = null}) {
  const directory = join(projectPath, '.sibyl', 'reports');
  await mkdir(directory, {recursive: true});
  const reportPath = join(directory, `${workerId}.json`);
  const patchPath = join(directory, `${workerId}.patch`);
  const deliverablePatchPath = report.deliverable.reason === null && typeof deliverablePatch === 'string'
    ? join(directory, `${workerId}.deliverable.patch`)
    : null;
  report.patchPath = patchPath;
  report.reportPath = reportPath;
  report.deliverable.path = deliverablePatchPath;
  const serializable = {...report};
  await atomicWrite(patchPath, patch);
  if (deliverablePatchPath) await atomicWrite(deliverablePatchPath, deliverablePatch);
  await atomicWrite(reportPath, JSON.stringify(serializable, null, 2));
  return {reportPath, patchPath, deliverablePatchPath};
}
