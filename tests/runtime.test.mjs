import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  agentEnv,
  defaultDataDir,
  resolveAgentExecutable,
  resolveExecutable,
} from "../src/platform/runtime.mjs";

/**
 * 创建隔离的临时目录，并在测试结束后递归清理。
 */
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "agents-calling-runtime-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("default data directories follow each platform convention", () => {
  assert.equal(
    defaultDataDir({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      home: "C:\\Users\\me",
    }),
    "C:\\Users\\me\\AppData\\Local\\AI Bridge",
  );
  assert.equal(
    defaultDataDir({
      platform: "darwin",
      env: {},
      home: "/Users/me",
    }),
    "/Users/me/Library/Application Support/AI Bridge",
  );
});

test("a one-line WinGet shim resolves to its native executable", async (t) => {
  const dir = await fixture(t);
  const executable = join(dir, "codex.exe");
  await writeFile(executable, "fixture");
  await writeFile(
    join(dir, "codex.cmd"),
    `@echo off\r\n"${executable}" %*\r\n`,
  );
  assert.deepEqual(
    await resolveExecutable("codex", {
      platform: "win32",
      cwd: dir,
      env: { PATH: dir },
    }),
    { command: executable, args: [] },
  );
});

test("an npm cmd shim resolves through package bin metadata without a shell", async (t) => {
  const dir = await fixture(t);
  const packageDir = join(dir, "node_modules", "fake-claude");
  const entry = join(packageDir, "cli.mjs");
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "fake-claude", bin: { claude: "cli.mjs" } }),
  );
  await writeFile(entry, 'console.log("fixture")');
  await writeFile(
    join(dir, "claude.cmd"),
    "@ECHO off\r\nGOTO start\r\n:start\r\n\"%_prog%\" \"%dp0%\\..\\fake-claude\\cli.mjs\" %*\r\n",
  );
  assert.deepEqual(
    await resolveExecutable("claude", {
      platform: "win32",
      cwd: dir,
      env: { PATH: dir },
    }),
    { command: process.execPath, args: [entry] },
  );
});

test("npm bin metadata cannot escape its package directory", async (t) => {
  const dir = await fixture(t);
  const packageDir = join(dir, "node_modules", "escape");
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: "escape",
      bin: { claude: "../../outside.mjs" },
    }),
  );
  await writeFile(join(dir, "outside.mjs"), 'console.log("unsafe")');
  await writeFile(join(dir, "claude.cmd"), "@echo off");
  await assert.rejects(
    resolveExecutable("claude", {
      platform: "win32",
      cwd: dir,
      env: { PATH: dir },
    }),
    /npm|outside|escape|unsupported/i,
  );
});

test("explicit agent paths win over PATH and fail closed", async (t) => {
  const dir = await fixture(t);
  const explicit = join(dir, "chosen.exe");
  await writeFile(explicit, "fixture");
  assert.deepEqual(
    await resolveAgentExecutable("claude", {
      platform: "win32",
      env: { PATH: "", SIBYL_CLAUDE_PATH: explicit },
    }),
    { command: explicit, args: [] },
  );
  await assert.rejects(
    resolveAgentExecutable("claude", {
      platform: "win32",
      env: { PATH: "", SIBYL_CLAUDE_PATH: join(dir, "missing.exe") },
    }),
    { code: "ENOENT" },
  );
});

test("Claude settings override stale environment keys case-insensitively on Windows", async (t) => {
  const dir = await fixture(t);
  const settings = join(dir, "settings.json");
  await writeFile(
    settings,
    JSON.stringify({
      env: {
        PATH: "C:\\settings",
        ANTHROPIC_BASE_URL: "http://proxy",
        BAD_KEY: 42,
      },
    }),
  );
  const merged = await agentEnv(
    "claude",
    { Path: "C:\\shell", ANTHROPIC_BASE_URL: "http://stale", OTHER: "1" },
    { SIBYL_CLAUDE_SETTINGS: settings },
    "win32",
  );
  assert.equal(merged.PATH, "C:\\settings");
  assert.equal("Path" in merged, false);
  assert.equal(merged.ANTHROPIC_BASE_URL, "http://proxy");
  assert.equal(merged.OTHER, "1");
  assert.equal("BAD_KEY" in merged, false);
});
