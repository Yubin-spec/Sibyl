import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 读取 JSON 配置并在路径不存在时给出明确测试失败信息。
 */
async function json(path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

test("Windows desktop configuration keeps versions and installer inputs aligned", async () => {
  const pkg = await json("package.json");
  const tauri = await json("src-tauri/tauri.conf.json");
  const cargo = await readFile(join(root, "src-tauri/Cargo.toml"), "utf8");

  assert.equal(tauri.version, pkg.version);
  assert.match(cargo, new RegExp(`version = "${pkg.version}"`));
  assert.deepEqual(tauri.bundle.targets, ["nsis"]);
  assert.equal(tauri.bundle.windows.webviewInstallMode.type, "downloadBootstrapper");
  assert.equal(tauri.bundle.windows.nsis.installMode, "currentUser");

  for (const source of [
    "../runtime/windows/node.exe",
    "../src/",
    "../package.json",
    "../Node-LICENSE",
  ]) {
    assert.ok(source in tauri.bundle.resources, `missing resource mapping: ${source}`);
  }
  assert.equal(tauri.bundle.resources["../runtime/windows/node.exe"], "node.exe");
  assert.equal(tauri.bundle.resources["../src/"], "src/");
});

test("Windows icon and startup page assets are present", async () => {
  const png = await readFile(join(root, "src-tauri/icons/icon.png"));
  const ico = await readFile(join(root, "src-tauri/icons/icon.ico"));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0]);
  assert.ok((await stat(join(root, "src-tauri/icons/icon.png"))).size > 10_000);
  assert.ok((await stat(join(root, "src-tauri/icons/icon.ico"))).size > 10_000);

  const page = await readFile(join(root, "windows/frontend/index.html"), "utf8");
  assert.match(page, /id="status"/);
  assert.match(page, /id="detail"/);
  await access(join(root, "src-tauri/src/main.rs"));
});

test("Windows CI bundles Node 26 and uploads the NSIS installer", async () => {
  const workflow = await readFile(
    join(root, ".github/workflows/windows-desktop.yml"),
    "utf8",
  );
  assert.match(workflow, /node-version:\s*26\.12\.1/);
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /runtime\/windows\/node\.exe/);
  assert.match(workflow, /@tauri-apps\/cli@2 build/);
  assert.match(workflow, /bundle\/nsis\/\*\.exe/);
  assert.match(workflow, /upload-artifact/);

  const ignore = await readFile(join(root, ".gitignore"), "utf8");
  assert.match(ignore, /\/runtime\/windows\/node\.exe/);
});
