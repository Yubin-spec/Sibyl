import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  PLAN_REVIEW_OPEN, PLAN_REVIEW_CLOSE, REVIEW_BEGIN, REVIEW_END,
  REVIEW_STATES, PROTOCOL_VERSION, HASH_VERSION,
  parsePlanDeclaration, planInputHash, parseFocus, isStructural,
  scanGeneratedBlocks, stripGeneratedReview, writeCodexReviewSection,
  parseVerdict, findPlanFiles, normalizeReviewConfig,
  buildReviewPrompt, buildResponsePrompt
} from './plan-review-policy.mjs';

const sample = `---
review: required
change:
  scope: [api, db]
  concurrency: false
  irreversible: true
  tasks: 6
  files: 7
---
# Plan

body
`;

const approveVerdict = `${PLAN_REVIEW_OPEN}
{"verdict":"approve","summary":"ok","issues":[],"questions":[]}
${PLAN_REVIEW_CLOSE}`;
const changesVerdict = `${PLAN_REVIEW_OPEN}
{"verdict":"changes-required","summary":"no","issues":[{"id":"R1","severity":"major","location":"§1","problem":"p","why":"w","suggestion":"s"}],"questions":[]}
${PLAN_REVIEW_CLOSE}`;

test('hash is stable, excludes review status and generated block, includes change and body', () => {
  const parsed = parsePlanDeclaration(sample);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.review, 'required');
  assert.deepEqual(parsed.change.scope, ['api', 'db']);
  assert.equal(parsed.inputHash, '8b07ad6ffdf70795ce36d9877497b68e2a14ee0850601e266b7c354c9e06d22e');
  const approved = writeCodexReviewSection(sample, {status: 'approved', summary: 'ok', reviewer: 'codex', round: 1, accepted: ['R1'], residualRisks: []});
  assert.equal(parsePlanDeclaration(approved).inputHash, parsed.inputHash);
  assert.equal(parsePlanDeclaration(approved).review, 'approved');
  assert.equal(parsePlanDeclaration(sample.replace('body', 'changed')).inputHash === parsed.inputHash, false);
  assert.equal(parsePlanDeclaration(sample.replace('irreversible: true', 'irreversible: false')).inputHash === parsed.inputHash, false);
});

test('hash normalizes BOM and line endings but preserves code-block whitespace', () => {
  const base = parsePlanDeclaration(sample);
  const crlf = parsePlanDeclaration(sample.replace(/\n/g, '\r\n'));
  const bom = parsePlanDeclaration('﻿' + sample);
  assert.equal(crlf.inputHash, base.inputHash);
  assert.equal(bom.inputHash, base.inputHash);
  const extra = parsePlanDeclaration(sample + '\n\n');
  assert.equal(extra.inputHash, base.inputHash);
  const codeA = parsePlanDeclaration(sample + '\n```js\na  b\n```\n');
  const codeB = parsePlanDeclaration(sample + '\n```js\na b\n```\n');
  assert.notEqual(codeA.inputHash, codeB.inputHash);
});

test('focus parses list items outside code fences', () => {
  const body = '## Review Focus\n\n- first\n- second\n\n```md\n- ignored\n```\n\n## Next\n- outside\n';
  const focus = parseFocus(body);
  assert.deepEqual(focus.map(item => item.text), ['first', 'second']);
  assert.equal(focus[0].id, 'F1');
});

test('structural detection upgrades not-required when flags are present', () => {
  assert.deepEqual(isStructural(parsePlanDeclaration(sample)), {required: true, reasons: ['review:required', 'scope:api', 'scope:db', 'irreversible', 'tasks:6', 'files:7']});
  const upgraded = parsePlanDeclaration('---\nreview: not-required\nchange:\n  scope: [api]\n---\nbody');
  assert.equal(isStructural(upgraded).required, true);
  const plain = parsePlanDeclaration('---\nreview: not-required\n---\nbody');
  assert.deepEqual(isStructural(plain), {required: false, reasons: []});
});

test('missing or malformed frontmatter is reported without pretending to be declared', () => {
  assert.equal(parsePlanDeclaration('no frontmatter').review, null);
  assert.ok(parsePlanDeclaration('---\nreview: maybe\n---\nbody').errors.length > 0);
  assert.ok(parsePlanDeclaration('---\nreview: required\nchange:\n  tasks: nope\n---\nbody').errors.length > 0);
  assert.ok(parsePlanDeclaration('---\nreview: required\nbody').errors.length > 0);
  assert.ok(REVIEW_STATES.includes('awaiting-visibility'));
});

test('generated block scanner ignores fenced markers and rejects malformed pairs', () => {
  const fenced = '```md\n' + REVIEW_BEGIN + '\ninside\n' + REVIEW_END + '\n```\n';
  assert.deepEqual(scanGeneratedBlocks(fenced).blocks, []);
  assert.deepEqual(scanGeneratedBlocks(fenced).errors, []);
  const unclosed = REVIEW_BEGIN + '\ntext\n';
  assert.ok(scanGeneratedBlocks(unclosed).errors.includes('Unclosed review block'));
  const orphanEnd = REVIEW_END + '\n';
  assert.ok(scanGeneratedBlocks(orphanEnd).errors.includes('Review end without begin'));
  const two = REVIEW_BEGIN + '\nA\n' + REVIEW_END + '\n' + REVIEW_BEGIN + '\nB\n' + REVIEW_END + '\n';
  assert.ok(scanGeneratedBlocks(two).errors.includes('Multiple review blocks'));
  assert.throws(() => writeCodexReviewSection(two, {status: 'approved'}), /Multiple review blocks/);
  assert.throws(() => writeCodexReviewSection(unclosed, {status: 'approved'}), /Unclosed review block/);
});

test('strip removes only complete generated blocks and preserves user text', () => {
  const user = '---\nreview: required\n---\n\n## Codex review\nuser text\n';
  assert.equal(stripGeneratedReview(user).includes('user text'), true);
  const generated = user + '\n' + REVIEW_BEGIN + '\ngenerated\n' + REVIEW_END + '\n';
  const stripped = stripGeneratedReview(generated);
  assert.equal(stripped.includes('generated'), false);
  assert.equal(stripped.includes('user text'), true);
});

test('write updates the declaration and inserts a unique block', () => {
  const written = writeCodexReviewSection(sample, {status: 'approved', summary: 'ok', reviewer: 'codex', round: 2, accepted: ['R1'], residualRisks: ['none']});
  assert.match(written, /review: approved/);
  assert.match(written, /SIBYL_REVIEW_BEGIN/);
  assert.equal((written.match(/SIBYL_REVIEW_BEGIN/g) || []).length, 1);
  assert.equal(parsePlanDeclaration(written).inputHash, parsePlanDeclaration(sample).inputHash);
  const twice = writeCodexReviewSection(written, {status: 'changes-required', summary: 'again'});
  assert.equal((twice.match(/SIBYL_REVIEW_BEGIN/g) || []).length, 1);
  assert.match(twice, /review: changes-required/);
});

test('verdict parsing is strict and numbers questions', () => {
  assert.equal(parseVerdict('looks good').ok, false);
  const two = approveVerdict + '\n' + approveVerdict;
  assert.equal(parseVerdict(two).ok, false);
  assert.equal(parseVerdict(approveVerdict).ok, true);
  const approveWithBlocker = `${PLAN_REVIEW_OPEN}
{"verdict":"approve","issues":[{"id":"R1","severity":"blocker","location":"§1","problem":"p","why":"w","suggestion":"s"}]}
${PLAN_REVIEW_CLOSE}`;
  assert.equal(parseVerdict(approveWithBlocker).ok, false);
  const changesWithoutMajor = `${PLAN_REVIEW_OPEN}
{"verdict":"changes-required","issues":[{"id":"R1","severity":"minor","location":"§1","problem":"p","why":"w","suggestion":"s"}]}
${PLAN_REVIEW_CLOSE}`;
  assert.equal(parseVerdict(changesWithoutMajor).ok, false);
  const discuss = `${PLAN_REVIEW_OPEN}
{"verdict":"discuss","issues":[],"questions":["a?","b?"]}
${PLAN_REVIEW_CLOSE}`;
  assert.deepEqual(parseVerdict(discuss).verdict.questions.map(item => item.id), ['Q1', 'Q2']);
  const duplicate = `${PLAN_REVIEW_OPEN}
{"verdict":"changes-required","issues":[{"id":"R1","severity":"major","location":"a","problem":"p","why":"w","suggestion":"s"},{"id":"R1","severity":"major","location":"b","problem":"p","why":"w","suggestion":"s"}]}
${PLAN_REVIEW_CLOSE}`;
  assert.equal(parseVerdict(duplicate).ok, false);
  const qCollision = `${PLAN_REVIEW_OPEN}
{"verdict":"changes-required","issues":[{"id":"Q1","severity":"major","location":"a","problem":"p","why":"w","suggestion":"s"}]}
${PLAN_REVIEW_CLOSE}`;
  assert.equal(parseVerdict(qCollision).ok, false);
  const focus = [{id: 'F1', text: 'check'}];
  assert.equal(parseVerdict(changesVerdict, {focus}).ok, true);
  assert.equal(parseVerdict(approveVerdict, {focus}).focusWarning, 'Review Focus 未被引用');
});

test('config only accepts the time-oriented whitelist', () => {
  const config = normalizeReviewConfig({maxRounds: 2, turnMs: 1000, reviewerModel: 'gpt-6.1-sol'});
  assert.equal(config.maxRounds, 2);
  assert.equal(config.protocolVersion, PROTOCOL_VERSION);
  assert.equal(config.hashVersion, HASH_VERSION);
  assert.throws(() => normalizeReviewConfig({maxReviewTokens: 1}), /Unsupported/);
  assert.throws(() => normalizeReviewConfig({maxRounds: 0}), /Invalid/);
});

test('findPlanFiles finds docs plans and root plan files only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-files-'));
  try {
    await mkdir(join(root, 'docs', 'superpowers', 'plans'), {recursive: true});
    await writeFile(join(root, 'docs', 'superpowers', 'plans', 'a.md'), '# a');
    await writeFile(join(root, 'b.plan.md'), '# b');
    await writeFile(join(root, 'c.md'), '# c');
    await writeFile(join(root, 'docs', 'superpowers', 'plans', 'd.txt'), 'd');
    assert.deepEqual(await findPlanFiles(root), ['b.plan.md', 'docs/superpowers/plans/a.md']);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('prompts name the snapshot and require the sentinel', () => {
  const review = buildReviewPrompt({snapshotPath: '/p/.sibyl/reviews/r1/round-1.md', projectPath: '/p', planPath: 'docs/a.md', round: 1, focus: [{id: 'F1', text: 'x'}]});
  assert.match(review, /\.sibyl\/reviews\/r1\/round-1\.md/);
  assert.match(review, /SIBYL_REVIEW/);
  assert.match(review, /F1/);
  const response = buildResponsePrompt({snapshotPath: '/p/round-2.md', projectPath: '/p', round: 2, previous: 'R1 fixed'});
  assert.match(response, /完整当前计划/);
  assert.match(response, /R1 fixed/);
});
