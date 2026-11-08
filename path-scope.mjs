import {normalizedPath} from './project-path.mjs';

export const DEFAULT_SHARED_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'bun.lock',
  'bun.lockb',
  'tsconfig.json',
  'jsconfig.json',
  '.npmrc',
  '.nvmrc',
  '.node-version',
  'lerna.json',
  'nx.json',
  'turbo.json',
  '.editorconfig'
]);

const SHARED_DIRS = ['.github', '.vscode', '.claude', '.codex'];
const SHARED_PATTERN = /^(tsconfig|jsconfig)\..*\.json$/i;
const MAX_SCOPE = 64;

const clean = path => String(path).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
const key = path => normalizedPath(clean(path));

function normalizeOne(path) {
  if (typeof path !== 'string') throw new Error(`Invalid scope path: ${path}`);
  const value = path.trim();
  if (!value || value.length > 1024) throw new Error(`Invalid scope path: ${path}`);
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) throw new Error(`Invalid scope path: ${path}`);
  const parts = clean(value).split('/').filter(Boolean);
  if (!parts.length) throw new Error(`Invalid scope path: ${path}`);
  for (const part of parts) {
    if (part === '.' || part === '..') throw new Error(`Invalid scope path: ${path}`);
    if (part === '.git' || part === '.sibyl') throw new Error(`Invalid scope path: ${path}`);
  }
  return parts.join('/');
}

export function normalizeScope(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_SCOPE) throw new Error('scope must be a non-empty array of project-relative paths');
  return paths.map(normalizeOne);
}

export function pathWithin(scopeEntry, target) {
  const parent = key(scopeEntry);
  const child = key(target);
  if (parent === '.') return true;
  return child === parent || child.startsWith(parent + '/');
}

export function scopeOverlaps(a, b) {
  return a.some(left => b.some(right => pathWithin(left, right) || pathWithin(right, left)));
}

export function isSharedPath(path, {extra = []} = {}) {
  const value = key(path);
  const parts = value.split('/');
  const base = parts.at(-1);
  if (DEFAULT_SHARED_FILES.some(name => name.toLowerCase() === base)) return true;
  if (SHARED_PATTERN.test(base)) return true;
  if (SHARED_DIRS.some(dir => value === dir || value.startsWith(dir + '/'))) return true;
  return extra.some(entry => {
    const shared = key(entry);
    return value === shared || value.startsWith(shared + '/');
  });
}

export function scopeSharedConflicts(scope, {extra = []} = {}) {
  const out = [];
  for (const entry of scope) {
    if (key(entry) === '.') {
      for (const shared of [...DEFAULT_SHARED_FILES, ...extra]) if (!out.includes(shared)) out.push(shared);
      continue;
    }
    if (isSharedPath(entry)) {
      if (!out.includes(entry)) out.push(entry);
      continue;
    }
    for (const shared of [...DEFAULT_SHARED_FILES, ...extra]) {
      if (pathWithin(entry, shared) && !out.includes(shared)) out.push(shared);
    }
  }
  return out;
}

export function findLeaseConflict(leases, scope, {repositoryKey} = {}) {
  for (const lease of leases) {
    if (repositoryKey && lease.repositoryKey && lease.repositoryKey !== repositoryKey) continue;
    for (const owned of lease.scope) {
      for (const wanted of scope) {
        if (pathWithin(owned, wanted) || pathWithin(wanted, owned)) {
          return {workerId: lease.workerId, ...(lease.leaseId ? {leaseId: lease.leaseId} : {}), path: owned};
        }
      }
    }
  }
  return null;
}

export function checkPaths(paths, leases, {sharedExtra = [], repositoryKey} = {}) {
  const blocked = [];
  const shared = [];
  const invalid = [];
  for (const path of paths) {
    let value;
    try {
      value = normalizeOne(path);
    } catch {
      invalid.push(path);
      continue;
    }
    const conflict = findLeaseConflict(leases, [value], {repositoryKey});
    if (conflict) blocked.push({path: value, workerId: conflict.workerId, ...(conflict.leaseId ? {leaseId: conflict.leaseId} : {})});
    if (isSharedPath(value, {extra: sharedExtra}) && !shared.includes(value)) shared.push(value);
  }
  return {allowed: !blocked.length && !shared.length && !invalid.length, blocked, shared, invalid};
}
