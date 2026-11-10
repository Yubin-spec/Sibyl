/**
 * 平台运行时适配层。
 *
 * Windows 的 npm/WinGet 启动器通常是 `.cmd`、`.ps1` 或 bash shim，而不是真正的
 * `.exe`。Node 的 `spawn()` 不会像终端一样解释这些包装脚本，因此后台直接执行
 * 命令名时会出现“明明装了却找不到”或把提示词交给 shell 的风险。
 *
 * 本模块只做三件事：
 * 1. 解析 Windows 包装脚本并找到真实可执行文件或 Node 入口；
 * 2. 提供各平台的默认数据目录；
 * 3. 合并 Claude Code 的 settings.json 环境变量。
 *
 * 所有命令仍通过独立 argv 传给 `spawn()`，不拼接 shell 命令。
 */
import { access, readFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

/**
 * 返回当前平台的默认数据目录。
 *
 * Windows 与旧版文档、MCP 配置保持 `%LOCALAPPDATA%\AI Bridge`，macOS 保持
 * `~/Library/Application Support/AI Bridge`。调用方仍可传显式目录覆盖。
 */
export function defaultDataDir({
  platform = process.platform,
  env = process.env,
  home = homedir(),
} = {}) {
  if (platform === "win32")
    return win32.join(
      environmentValue(env, "LOCALAPPDATA", platform) ||
        win32.join(home, "AppData", "Local"),
      "AI Bridge",
    );
  if (platform === "darwin")
    return posix.join(home, "Library", "Application Support", "AI Bridge");
  return posix.join(
    environmentValue(env, "XDG_DATA_HOME", platform) ||
      posix.join(home, ".local", "share"),
    "ai-bridge",
  );
}

/**
 * 读取环境变量。
 *
 * Windows 环境变量名不区分大小写；测试里传入普通对象时也要模拟这个行为，
 * 否则 `Path` 和 `PATH` 会得到不同结果。
 */
function environmentValue(env, key, platform) {
  const name =
    platform === "win32"
      ? Object.keys(env).find((item) => item.toUpperCase() === key.toUpperCase())
      : key;
  return name ? env[name] || "" : "";
}

/**
 * 判断路径是否是普通文件。
 *
 * Windows 不要求可执行位；POSIX 仍检查 X_OK，避免把普通文本误当成命令。
 */
async function isFile(path, { platform }) {
  try {
    if (!(await stat(path)).isFile()) return false;
    if (platform !== "win32") await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 构造带 ENOENT 标记的错误。
 *
 * runner 会据此继续尝试下一个候选命令，其它错误则直接上报，避免掩盖真实故障。
 */
function notFound(command) {
  const error = Error("Executable not found: " + command);
  error.code = "ENOENT";
  return error;
}

/**
 * 列出 npm 包目录，包含 `@scope/name`。
 *
 * 读取失败时返回空数组；调用方会把它当作“这个包装脚本无法安全解析”。
 */
async function npmPackages(root) {
  const packages = [];
  for (const item of await readdir(root, { withFileTypes: true }).catch(
    () => [],
  )) {
    if (!item.isDirectory() && !item.isSymbolicLink()) continue;
    if (item.name.startsWith("@")) {
      for (const child of await readdir(join(root, item.name), {
        withFileTypes: true,
      }).catch(() => [])) {
        if (child.isDirectory() || child.isSymbolicLink())
          packages.push(join(root, item.name, child.name));
      }
    } else if (!item.name.startsWith(".")) {
      packages.push(join(root, item.name));
    }
  }
  return packages;
}

/**
 * 判断一个路径是否是可以直接启动的 Windows 原生程序。
 *
 * 只接受绝对路径的 `.exe` / `.com`，避免把任意脚本内容当成命令执行。
 */
function windowsNative(path) {
  return typeof path === "string" &&
    isAbsolute(path) &&
    [".exe", ".com"].includes(extname(path).toLowerCase())
    ? { command: path, args: [] }
    : null;
}

/**
 * 展开批处理里常见的 `%~dp0`，得到包装脚本所在目录。
 *
 * 这里只处理这一种无参数展开；不执行 `set`、`if`、`call` 或其它批处理逻辑。
 */
function expandBatchDirectory(value, directory) {
  return value.replace(/%~dp0[\\/]?/gi, directory + sep);
}

/**
 * 解析 WinGet 一类“一行转发到原生 exe”的 `.cmd` 文件。
 *
 * 只有脚本去掉 `@echo off` 后只剩一条转发语句时才接受；任何条件、变量赋值或
 * 第二条命令都视为真实控制流，交给 npm 包元数据解析或直接拒绝。
 */
async function windowsBatchTarget(path) {
  const text = await readFile(path, "utf8").catch(() => null);
  if (!text || text.length > 4096) return null;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^@?echo\s+off$/i.test(line));
  if (lines.length !== 1) return null;
  const match =
    /^(?:"([^"]+\.(?:exe|com))"|(\S+\.(?:exe|com)))\s+(?:%\*|\*)$/i.exec(
      lines[0],
    );
  if (!match) return null;
  const target = windowsNative(
    expandBatchDirectory(match[1] || match[2], dirname(path)),
  );
  return target && (await isFile(target.command, { platform: "win32" }))
    ? target
    : null;
}

/**
 * 把 Git Bash 风格的 `/c/...` 路径转换为 `C:\...`。
 *
 * 只转换明确的盘符形式，其它路径原样返回。
 */
function windowsPath(value) {
  const drive = /^\/([a-zA-Z])\/(.+)$/.exec(value);
  return drive
    ? drive[1].toUpperCase() + ":\\" + drive[2].replaceAll("/", "\\")
    : value;
}

/**
 * 解析只有一条 `exec ... "$@"` 的 bash shim。
 *
 * 该模式常见于只装 Git Bash 的工具；只接受单条 exec，避免执行额外控制流。
 */
async function windowsShellShim(path) {
  const text = await readFile(path, "utf8").catch(() => null);
  if (!text || text.length > 4096) return null;
  const lines = text.split(/\r?\n/);
  if (!/^#![^\r\n]*\b(?:bash|sh)\b/.test(lines[0] || "")) return null;
  const body = lines
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (body.length !== 1) return null;
  const match = /^exec\s+(?:"([^"]+)"|(\S+))\s+"\$@"$/.exec(body[0]);
  if (!match) return null;
  const target = windowsNative(windowsPath(match[1] || match[2]));
  return target && (await isFile(target.command, { platform: "win32" }))
    ? target
    : null;
}

/**
 * 把真实入口文件转换为 spawn 可用的 command/args。
 *
 * `.js/.mjs/.cjs` 直接用 Node 启动；Windows 下无扩展名入口会检查 shebang 或
 * 单条 bash shim。无法证明安全时返回错误，而不是交给 shell 猜测。
 */
async function executableEntry(path, { platform, nodePath }) {
  if (!(await isFile(path, { platform: "win32" }))) throw notFound(path);
  const extension = extname(path).toLowerCase();
  if ([".cmd", ".bat", ".ps1"].includes(extension))
    throw Error(
      "Unsupported batch entry; configure a native executable or Node entry file",
    );
  if ([".js", ".cjs", ".mjs"].includes(extension))
    return { command: nodePath, args: [path] };
  if (platform === "win32" && ![".exe", ".com"].includes(extension)) {
    const firstLine = (await readFile(path, "utf8")).split(/\r?\n/, 1)[0];
    if (/^#![^\r\n]*\bnode(?:\s|$)/.test(firstLine))
      return { command: nodePath, args: [path] };
    const shim = await windowsShellShim(path);
    if (shim) return shim;
    throw Error(
      "Unsupported executable; configure a native executable or Node entry file",
    );
  }
  if (!(await isFile(path, { platform }))) throw notFound(path);
  return { command: path, args: [] };
}

/**
 * 从 npm 包装脚本的相邻包目录中定位真实 bin 入口。
 *
 * 包装脚本本身不执行；只读取 package.json 的 `bin` 字段，并确认目标没有逃出
 * 包目录。这样既支持 npm 全局安装，也不会因为恶意 package.json 跳转到任意文件。
 */
async function npmShim(shim, options) {
  const command = basename(shim, extname(shim));
  const directory = dirname(shim);
  const root =
    basename(directory) === ".bin"
      ? dirname(directory)
      : join(directory, "node_modules");
  for (const packageDir of await npmPackages(root)) {
    let metadata;
    try {
      metadata = JSON.parse(
        await readFile(join(packageDir, "package.json"), "utf8"),
      );
    } catch {
      continue;
    }
    const entry =
      typeof metadata.bin === "string" &&
      metadata.name?.split("/").at(-1) === command
        ? metadata.bin
        : metadata.bin?.[command];
    if (typeof entry !== "string" || !entry) continue;
    const target = resolve(packageDir, entry);
    const inside = relative(packageDir, target);
    if (
      !inside ||
      inside === ".." ||
      inside.startsWith(".." + sep) ||
      isAbsolute(inside)
    )
      throw Error("npm bin entry escapes its package directory");
    return executableEntry(target, options);
  }
  throw Error(
    "Unsupported batch wrapper: no matching npm package bin entry for " +
      command,
  );
}

/**
 * 把命令名或路径解析成可直接交给 `spawn()` 的入口。
 *
 * Windows 会按 PATHEXT 查找 `.exe/.com/.cmd/.ps1`，并安全解包 npm/WinGet
 * 包装脚本。显式路径解析失败时直接报错，避免悄悄改用 PATH 上另一个版本。
 */
export async function resolveExecutable(
  command,
  {
    platform = process.platform,
    env = process.env,
    cwd = process.cwd(),
    nodePath = process.execPath,
  } = {},
) {
  if (typeof command !== "string" || !command || /[\x00\r\n]/.test(command))
    throw Error("Expected an executable name or path");
  const options = { platform, nodePath };
  const hasPath = /[\\/]/.test(command);
  const extensions =
    platform === "win32" && !extname(command)
      ? [".exe", ".com", ".cmd", ".ps1", ""]
      : [""];
  const directories = hasPath
    ? [""]
    : environmentValue(env, "PATH", platform)
        .split(platform === "win32" ? ";" : ":")
        .filter(Boolean)
        .map((path) => path.replace(/^"(.*)"$/, "$1"));
  let unsupported;
  for (const directory of directories) {
    for (const extension of extensions) {
      const path = resolve(cwd, directory, command + extension);
      if (!(await isFile(path, { platform: "win32" }))) continue;
      try {
        if ([".cmd", ".bat"].includes(extname(path).toLowerCase())) {
          const direct = await windowsBatchTarget(path);
          if (direct) return direct;
          return await npmShim(path, options);
        }
        if (extname(path).toLowerCase() === ".ps1")
          return await npmShim(path, options);
        return await executableEntry(path, options);
      } catch (error) {
        if (hasPath) throw error;
        unsupported = error;
      }
    }
  }
  throw unsupported || notFound(command);
}

/**
 * 解析指定 AI 工具的可执行入口。
 *
 * 显式 `SIBYL_<TOOL>_PATH` 或 `options.executables[tool]` 优先；否则按工具命令名
 * 依次查找 PATH。接口保留给需要显式运行时配置的调用方，不负责桌面 App 路径。
 */
export async function resolveAgentExecutable(agent, options = {}) {
  const agentCommands = {
    claude: ["claude"],
    codex: ["codex"],
    deepseek: ["dsh"],
    cursor: ["cursor-agent", "agent"],
  };
  if (!Object.hasOwn(agentCommands, agent)) throw Error("Unknown agent");
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const explicit =
    options.executables?.[agent] ||
    environmentValue(env, "SIBYL_" + agent.toUpperCase() + "_PATH", platform);
  if (explicit) return resolveExecutable(explicit, { ...options, env });
  let failure;
  for (const command of agentCommands[agent]) {
    try {
      return await resolveExecutable(command, options);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      failure = error;
    }
  }
  throw failure;
}

/**
 * 读取 Claude Code 在 settings.json 中保存的 provider 环境变量。
 *
 * 只接受合法的大写环境变量名和字符串值。文件不存在或格式错误时返回空对象，
 * 不阻断正常的 Claude 调用。
 */
export async function claudeSettingsEnv({
  env = process.env,
  home = homedir(),
  platform = process.platform,
} = {}) {
  const configDir =
    environmentValue(env, "CLAUDE_CONFIG_DIR", platform) ||
    join(home, ".claude");
  const file =
    environmentValue(env, "SIBYL_CLAUDE_SETTINGS", platform) ||
    join(configDir, "settings.json");
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    const values = data?.env;
    if (!values || typeof values !== "object" || Array.isArray(values))
      return {};
    return Object.fromEntries(
      Object.entries(values).filter(
        ([key, value]) =>
          typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(key),
      ),
    );
  } catch {
    return {};
  }
}

/**
 * 合并 Claude 环境变量并处理 Windows 大小写键冲突。
 *
 * Windows 环境变量名不区分大小写，不能同时保留 `Path` 和 `PATH`；settings.json
 * 中显式配置的值应当覆盖启动器继承的旧值。
 */
function mergeEnvironment(base, settings, platform) {
  if (platform !== "win32") return { ...base, ...settings };
  const merged = { ...base };
  const index = new Map();
  for (const key of Object.keys(merged)) index.set(key.toUpperCase(), key);
  for (const [key, value] of Object.entries(settings)) {
    const existing = index.get(key.toUpperCase());
    if (existing && existing !== key) delete merged[existing];
    merged[key] = value;
    index.set(key.toUpperCase(), key);
  }
  return merged;
}

/**
 * 返回指定工具应当继承的环境变量。
 *
 * 目前只有 Claude Code 需要读取 settings.json；它会把 provider 切换写在该文件里，
 * 后台进程如果不合并就会误报“未登录”或继续使用旧网关。
 */
export async function agentEnv(
  agent,
  base = process.env,
  overrides = {},
  platform = process.platform,
) {
  if (agent !== "claude") return base;
  const settings = await claudeSettingsEnv({
    env: { ...base, ...overrides },
    platform,
  });
  return mergeEnvironment(base, settings, platform);
}
