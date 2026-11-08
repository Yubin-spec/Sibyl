import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const controlPath = join(root, "src/app/control.mjs");

// 等待控制面通过 stdout 报告随机端口；超时或提前退出都让测试明确失败。
function waitForReady(child, timeoutMs = 15000) {
  return new Promise((resolveReady, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`control did not become ready: ${stdout}${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/BRIDGE_UI_READY=(http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolveReady(match[1]);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`control exited early (${code ?? signal}): ${stdout}${stderr}`));
    });
  });
}

// 等待子进程真正退出，确保关闭信号已经完成清理。
function waitForExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("control did not exit")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

test("control publishes a private runtime descriptor and removes it on shutdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agents-calling-runtime-"));
  const child = spawn(process.execPath, [controlPath, dir, String(process.pid)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const url = await waitForReady(child);
    const runtimePath = join(dir, "ui-runtime.json");
    const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
    assert.equal(runtime.pid, child.pid);
    assert.equal(runtime.appPid, process.pid);
    assert.equal(runtime.url, url);
    assert.equal(runtime.version, JSON.parse(await readFile(join(root, "package.json"), "utf8")).version);
    assert.equal((await stat(runtimePath)).mode & 0o777, 0o600);

    const version = await fetch(url + "/api/version", {
      headers: { "x-bridge-ui": runtime.token },
    });
    assert.equal(version.status, 200);
    assert.equal((await version.json()).version, runtime.version);

    child.kill("SIGTERM");
    await waitForExit(child);
    await assert.rejects(readFile(runtimePath, "utf8"), { code: "ENOENT" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
