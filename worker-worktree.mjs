import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {copyFile,chmod,readFile,writeFile,mkdir,rm,stat,lstat,readlink,symlink,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,dirname,resolve,isAbsolute} from 'node:path';
import {canonicalProjectPath,normalizedPath} from './project-path.mjs';
import {DEFAULT_SHARED_FILES,pathWithin} from './path-scope.mjs';

const run = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;
const fingerprint = value => createHash('sha256').update(value).digest('hex');

async function git(cwd, ...args) {
  const {stdout} = await run('git', args, {cwd, maxBuffer: MAX_BUFFER});
  return stdout;
}

async function gitOk(cwd, ...args) {
  try { return await git(cwd, ...args); } catch { return null; }
}

function gitNull(cwd, ...args) {
  return git(cwd, ...args).then(output => output.split('\0').filter(Boolean));
}

export async function isGitRepository(projectPath) {
  try {
    const real = canonicalProjectPath(projectPath);
    const top = (await git(real, 'rev-parse', '--show-toplevel')).trim();
    return normalizedPath(top) === normalizedPath(real);
  } catch {
    return false;
  }
}

async function assertSupportedRepository(projectPath) {
  let real;
  try {
    real = canonicalProjectPath(projectPath);
  } catch {
    throw Error(`Worker dispatch needs a git repository: ${projectPath}`);
  }
  let top;
  try {
    top = (await git(real, 'rev-parse', '--show-toplevel')).trim();
  } catch {
    throw Error(`Worker dispatch needs a git repository: ${real}`);
  }
  if (normalizedPath(top) !== normalizedPath(real)) throw Error(`Worker dispatch needs the repository root: ${top}`);
  let base;
  try {
    base = (await git(real, 'rev-parse', 'HEAD')).trim();
  } catch {
    throw Error('Repository has no commits yet; make one commit before dispatching a worker');
  }
  const modules = join(real, '.gitmodules');
  if (existsSync(modules)) throw Error(`Worker dispatch does not support submodules: ${modules}`);
  const stage = await git(real, 'ls-files', '--stage', '-z');
  if (stage.split('\0').some(line => line.startsWith('160000'))) throw Error(`Worker dispatch does not support submodules: ${real}`);
  return {real, base};
}

export async function readSharedFiles(projectPath) {
  const files = new Set(DEFAULT_SHARED_FILES);
  let data;
  try {
    data = JSON.parse(await readFile(join(projectPath, '.sibyl', 'shared-files.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [...files];
    throw error;
  }
  for (const field of ['add', 'remove']) {
    if (data[field] !== undefined && (!Array.isArray(data[field]) || data[field].some(value => typeof value !== 'string'))) throw Error(`Invalid .sibyl/shared-files.json: ${field} must be an array of strings`);
  }
  for (const file of data.add ?? []) files.add(file);
  for (const file of data.remove ?? []) files.delete(file);
  return [...files];
}

export async function ensureSibylExcluded(projectPath) {
  const relative = (await git(projectPath, 'rev-parse', '--git-path', 'info/exclude')).trim();
  const file = isAbsolute(relative) ? relative : join(projectPath, relative);
  await mkdir(dirname(file), {recursive: true});
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (text.split(/\r?\n/).includes('/.sibyl/')) return;
  await writeFile(file, (text && !text.endsWith('\n') ? text + '\n' : text) + '/.sibyl/\n');
}

export async function snapshotFingerprint(projectPath, files) {
  const map = {};
  for (const file of [...files].sort()) {
    const full = join(projectPath, file);
    try {
      const info = await lstat(full);
      if (info.isSymbolicLink()) map[file] = fingerprint('link:' + await readlink(full));
      else if (info.isFile()) map[file] = fingerprint(await readFile(full));
      else map[file] = fingerprint('other');
    } catch {
      map[file] = fingerprint('missing');
    }
  }
  const digest = fingerprint(Object.entries(map).map(([path, hash]) => path + '\0' + hash).join('\n'));
  return {files: map, digest};
}

async function copyEntry(projectPath, worktreePath, file, copied, deleted, skipped) {
  const source = join(projectPath, file);
  const target = join(worktreePath, file);
  let info;
  try {
    info = await lstat(source);
  } catch {
    await rm(target, {force: true, recursive: true});
    deleted.push(file);
    return;
  }
  if (info.isSymbolicLink()) {
    const link = await readlink(source);
    if (isAbsolute(link)) throw Error(`Worker dispatch does not support symlinks outside the repository: ${file}`);
    const resolved = resolve(dirname(source), link);
    if (!pathWithin(projectPath, resolved)) throw Error(`Worker dispatch does not support symlinks outside the repository: ${file}`);
    await mkdir(dirname(target), {recursive: true});
    await rm(target, {force: true, recursive: true});
    await symlink(link, target);
    skipped.symlinks.push(file);
    copied.push(file);
    return;
  }
  if (info.isDirectory()) throw Error(`Worker dispatch does not support submodules: ${file}`);
  if (!info.isFile()) throw Error(`Worker dispatch does not support file type: ${file}`);
  await mkdir(dirname(target), {recursive: true});
  await copyFile(source, target);
  await chmod(target, info.mode);
  copied.push(file);
}

async function tryRemove(projectPath, worktreePath, branch) {
  await gitOk(projectPath, 'worktree', 'remove', '--force', worktreePath);
  await rm(worktreePath, {recursive: true, force: true});
  await gitOk(projectPath, 'branch', '-D', branch);
}

export async function createWorkerWorktree({projectPath, workerId, branchPrefix = 'sibyl/worker', scope = [], onBeforeCopy} = {}) {
  const {real, base} = await assertSupportedRepository(projectPath);
  const branch = `${branchPrefix}/${workerId}`;
  if (await gitOk(real, 'show-ref', '--verify', 'refs/heads/' + branch)) throw Error(`Worker branch already exists: ${branch}`);
  await ensureSibylExcluded(real);
  const worktreePath = join(real, '.sibyl', 'worktrees', workerId);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await tryRemove(real, worktreePath, branch);
      await git(real, 'worktree', 'add', '-b', branch, worktreePath, base);

      const tracked = await gitNull(real, 'ls-files', '--cached', '-z');
      const ignored = new Set(await gitNull(real, 'ls-files', '--cached', '--ignored', '--exclude-standard', '-z'));
      const untracked = await gitNull(real, 'ls-files', '--others', '--exclude-standard', '-z');
      const files = [...new Set([...tracked.filter(file => !ignored.has(file)), ...untracked])]
        .filter(file => !file.startsWith('.sibyl/'))
        .sort();

      const before = await snapshotFingerprint(real, files);
      if (onBeforeCopy) await onBeforeCopy();

      const copied = [];
      const deleted = [];
      const skipped = {ignoredTracked: [...ignored], symlinks: [], submodules: []};
      for (const file of files) await copyEntry(real, worktreePath, file, copied, deleted, skipped);

      const keep = new Set(files);
      for (const file of await gitNull(worktreePath, 'ls-tree', '-r', '--name-only', '-z', base)) {
        if (keep.has(file) || file.startsWith('.sibyl/')) continue;
        await rm(join(worktreePath, file), {force: true, recursive: true});
        deleted.push(file);
      }

      const after = await snapshotFingerprint(real, files);
      if (before.digest !== after.digest) throw Error('SNAPSHOT_CHANGED');

      let snapshotCommit = base;
      await git(worktreePath, 'add', '-A');
      if ((await git(worktreePath, 'diff', '--cached', '--name-only')).trim()) {
        await git(worktreePath, '-c', 'user.name=Agents Calling', '-c', 'user.email=agents-calling@localhost', 'commit', '-q', '-m', `sibyl: snapshot before ${workerId}`);
        snapshotCommit = (await git(worktreePath, 'rev-parse', 'HEAD')).trim();
      }

      const leadDigest = {files: {}, truncated: false};
      for (const [file, hash] of Object.entries(after.files)) {
        if (scope.some(entry => pathWithin(entry, file))) leadDigest.files[file] = hash;
      }

      return {worktreePath, branch, baseCommit: base, snapshotCommit, snapshotFiles: files, copied, deleted, skipped, leadDigest};
    } catch (error) {
      await tryRemove(real, worktreePath, branch);
      if (error.message === 'SNAPSHOT_CHANGED' && attempt === 0) continue;
      if (error.message === 'SNAPSHOT_CHANGED') throw Error('Lead workspace changed during snapshot; retry dispatch');
      throw error;
    }
  }
  throw Error('Lead workspace changed during snapshot; retry dispatch');
}

export async function commitWorktree(worktreePath, message, {branch, snapshotCommit} = {}) {
  if (branch) {
    const current = (await git(worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
    if (current !== branch) throw Error('Worker worktree is not on the expected branch or snapshot');
  }
  if (snapshotCommit) {
    try {
      await git(worktreePath, 'merge-base', '--is-ancestor', snapshotCommit, 'HEAD');
    } catch {
      throw Error('Worker worktree is not on the expected branch or snapshot');
    }
  }
  if (!(await git(worktreePath, 'status', '--porcelain')).trim()) return null;
  await git(worktreePath, 'add', '-A');
  if (!(await git(worktreePath, 'diff', '--cached', '--name-only')).trim()) return null;
  await git(worktreePath, '-c', 'user.name=Agents Calling', '-c', 'user.email=agents-calling@localhost', 'commit', '-q', '-m', message);
  return (await git(worktreePath, 'rev-parse', 'HEAD')).trim();
}

export async function worktreeStatus(worktreePath) {
  return (await git(worktreePath, 'status', '--porcelain')).trim();
}

export async function removeWorkerWorktree({projectPath, branch, worktreePath}) {
  const root = join(projectPath, '.sibyl', 'worktrees');
  if (!pathWithin(root, worktreePath) || !branch?.startsWith('sibyl/worker/')) throw Error('Refusing to remove a worktree outside this plan');
  await tryRemove(projectPath, worktreePath, branch);
}

export async function listRefs(projectPath) {
  const output = await git(projectPath, 'for-each-ref', '--format=%(refname) %(objectname)');
  const refs = {};
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [name, sha] = line.split(' ');
    if (name && sha) refs[name] = sha;
  }
  return refs;
}

export async function stagedPaths(projectPath) {
  return gitNull(projectPath, 'diff', '--cached', '--name-only', '-z');
}

export function refChanges(before, after, {ignore = []} = {}) {
  const ignored = new Set(ignore);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(ref => !ignored.has(ref) && before[ref] !== after[ref])
    .sort();
}

const SKIP_DIRS = new Set(['.git', '.sibyl', 'node_modules']);

export async function scopeFingerprint(projectPath, scope) {
  const files = {};
  let truncated = false;
  const visit = async relative => {
    if (truncated) return;
    const full = join(projectPath, relative);
    let info;
    try {
      info = await lstat(full);
    } catch {
      return;
    }
    if (info.isDirectory()) {
      for (const entry of await readdir(full)) {
        if (SKIP_DIRS.has(entry)) continue;
        await visit(relative ? relative + '/' + entry : entry);
        if (truncated) return;
      }
      return;
    }
    if (Object.keys(files).length >= 2000) {
      truncated = true;
      return;
    }
    files[relative.replace(/\\/g, '/')] = info.isSymbolicLink() ? fingerprint('link:' + await readlink(full)) : fingerprint(await readFile(full));
  };
  for (const entry of scope) {
    await visit(entry);
    if (truncated) break;
  }
  return {files, truncated};
}

export function fingerprintChanges(before, after) {
  const keys = new Set([...(before?.files ? Object.keys(before.files) : []), ...(after?.files ? Object.keys(after.files) : [])]);
  return [...keys].filter(file => before?.files?.[file] !== after?.files?.[file]).sort();
}
