/**
 * 项目路径身份工具。
 *
 * 项目路径会被写入 SQLite、用来自动匹配 MCP 会话，也会出现在远端项目目录里。
 * Windows 的盘符、大小写和斜杠写法不统一，因此比较身份时必须先转成规范路径：
 * - 先 `resolve + realpath`，消除相对路径、`..` 和符号链接；
 * - 统一使用 `/`；
 * - 只有 Windows 才忽略大小写。
 *
 * `projectKey` 返回的字符串只用于比较，不能当作文件系统路径使用。
 */
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 规范化路径文本。
 *
 * 保留根路径 `/`，去掉末尾多余分隔符；Windows 额外转小写并统一使用 `/`。
 */
export function normalizedPath(value, { platform = process.platform } = {}) {
  let path = String(value).replace(/\\/g, "/");
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return platform === "win32" ? path.toLowerCase() : path;
}

/**
 * 返回真实存在的目录路径。
 *
 * 项目只能是目录；不存在的路径、文件路径或无效字符串都直接拒绝，避免后续任务
 * 在错误目录里执行。
 */
export function canonicalProjectPath(input) {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.length > 1024 ||
    /[\x00\r\n]/.test(input)
  )
    throw Error("Invalid project path");
  const real = realpathSync(resolve(input));
  if (!statSync(real).isDirectory())
    throw Error("Project path must be a directory");
  return real;
}

/**
 * 返回用于比较的项目身份。
 *
 * 路径不可信时返回 null，调用方应退回到显式项目选择，不能猜测绑定关系。
 */
export function projectKey(input, options) {
  try {
    return normalizedPath(canonicalProjectPath(input), options);
  } catch {
    return null;
  }
}
