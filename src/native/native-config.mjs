/**
 * 各 AI 工具的原生 MCP 配置写入器。
 *
 * 不同工具使用不同配置格式：
 * - Claude Code / Cursor：项目级 JSON，只有检测不到独立 CLI 时才写桌面 App 全局配置；
 * - Codex：用户级 config.toml，并只给 ai-bridge 工具自动审批；
 * - DeepSeek Harness：桌面 profile 的 YAML patch 层。
 *
 * 写入前会保留一次 .ai-bridge-backup，并使用临时文件 + rename 原子替换。
 * 配置成功只代表文件已写好，不代表原会话已经加载或 AI 已经理解。
 */
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  copyFile,
  constants,
  rm,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

/**
 * 首次修改前保留一份备份。
 *
 * 使用 COPYFILE_EXCL，已有备份时不再覆盖；
 * 这样用户第一次被修改前的原始配置始终可找回。
 */
const backupOnce = async (path) => {
  await copyFile(
    path,
    path + ".ai-bridge-backup",
    constants.COPYFILE_EXCL,
  ).catch((e) => {
    if (e.code !== "EEXIST") throw e;
  });
};

/**
 * 原子写入配置文件。
 *
 * 先写同目录临时文件，再 rename 覆盖目标；
 * 失败时清理临时文件，原文件保持完整。
 */
const writeAtomic = async (path, data) => {
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, data, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
};

// 触发规则只解决“什么时候想起来桥接”，不强制每次任务都调用。
// 用固定标记包住托管块，重复配置只替换这一段，不碰用户已有指令。
const bridgeRuleStart = "<!-- >>> Agents Calling bridge -->",
  bridgeRuleEnd = "<!-- <<< Agents Calling bridge -->",
  bridgeRule = [
    bridgeRuleStart,
    "Agents Calling bridge is available through MCP.",
    "When this task touches a module owned by another AI tool, a cross-project contract, or needs cross-tool verification, call bridge_context before deciding whether to communicate. bridge_context works before bridge_open_session and does not register a session.",
    "Do not call the bridge merely because it exists. If a useful target is returned and communication is warranted, call bridge_open_session once, then bridge_consult and follow the returned consultId.",
    bridgeRuleEnd,
    "",
  ].join("\n");

/**
 * 把触发规则合并进用户或项目指令文件。
 *
 * 首次修改前保留 .ai-bridge-backup；已有托管标记时原位替换，
 * 没有标记时追加到文件末尾，绝不改写用户原有内容。
 */
async function mergeBridgeRule(path, header = "") {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT")
      throw Error("Cannot read instructions: " + e.message);
  }
  const start = raw.indexOf(bridgeRuleStart),
    end = raw.indexOf(bridgeRuleEnd);
  let next;
  if (start >= 0 && end > start)
    next =
      raw.slice(0, start) +
      bridgeRule +
      raw.slice(end + bridgeRuleEnd.length).replace(/^\n+/, "");
  else {
    const prefix = raw.trimEnd();
    next = (prefix ? prefix + "\n\n" : header) + bridgeRule;
  }
  if (next !== raw) {
    if (raw) await backupOnce(path);
    await writeAtomic(path, next);
  }
  return path;
}
const instructions = {
  claude:
    "配置已写入。请在 Claude Code 原会话里用 /mcp 检查或重连 ai-bridge；若当前版本不能动态加载，续接原会话后再检查。任务可能涉及另一个 AI 工具负责的模块或跨项目契约时，先调用 bridge_context 只读查看目标；它无需登记，也不会创建会话。确认值得通信后，再调用 bridge_open_session 并主动调用 bridge_consult，只传工具名，不要让人转述；未绑定才使用当前项目。收到原会话问题后用 bridge_receive 接收、bridge_reply 回答；询问方用 bridge_ask/bridge_result 或 bridge_consult/bridge_consult_result 继续任务。",
  cursor:
    "配置已写入。请在 Cursor 的 MCP 设置启用 ai-bridge，回到原会话确认工具可见；必要时重新加载窗口并保留原聊天。如果使用 Cursor CLI，先在项目目录执行 cursor-agent mcp enable ai-bridge；本地咨询所需的 bridge_context、bridge_open_session、bridge_consult、bridge_consult_result 和 bridge_consult_stop 已加入项目白名单。任务可能涉及另一个 AI 工具负责的模块时，先调用 bridge_context 只读查看目标，无需登记；确认需要通信后再调用 bridge_open_session 和 bridge_consult。用 bridge_receive 接收原会话问题并用 bridge_reply 回答。",
  codex:
    '配置已写入。Codex 重新打开会话后确认 ai-bridge MCP 可见；该服务已设置 default_tools_approval_mode="approve"，只自动批准 ai-bridge 的工具调用，不改 Codex 其他审批设置。任务可能涉及另一个 AI 工具负责的模块或跨项目契约时，先调用 bridge_context 只读查看目标，无需登记；确认需要通信后再调用 bridge_open_session 和 bridge_consult，不要让人转述。用 bridge_receive/bridge_reply 收发原会话问题，目标项目由保存的绑定决定。',
  deepseek:
    "配置已写入 DeepSeek Harness 桌面 profile 的用户 patch 层。重启 DeepSeek Harness 桌面应用后，在原会话中确认 mcp__ai-bridge__ 工具可见。DeepSeek 的 MCP 子进程工作目录不是会话工作区，调用 bridge_context 或 bridge_open_session 时必须把 projectPath 设为当前会话工作目录。任务可能涉及另一个 AI 工具负责的模块时，先调用 bridge_context 只读查看目标，无需登记；确认需要通信后再调用 bridge_open_session 和 bridge_consult，不要让人转述。用 bridge_receive/bridge_reply 收发原会话问题，目标项目由保存的绑定决定。",
};
const desktopInstructions = {
  claude:
    "已写入 Claude Desktop 的全局 MCP 配置。完全退出并重启 Claude Desktop，在对话中确认 ai-bridge 工具可用；任务可能涉及另一个 AI 工具负责的模块时，先调用 bridge_context 只读查看目标，无需登记。确认需要通信后再调用 bridge_open_session 和 bridge_consult，只传工具名；用 bridge_receive/bridge_reply 收发原会话问题。无需单独安装 Claude Code CLI；桥接会复用 Claude Desktop 准备的内部运行时。",
  cursor:
    "已写入 Cursor Desktop 的全局 MCP 配置。重启 Cursor 或在 MCP 设置中重新加载 ai-bridge，在对话中确认工具可用；任务可能涉及另一个 AI 工具负责的模块时，先调用 bridge_context 只读查看目标，无需登记。确认需要通信后再调用 bridge_open_session 和 bridge_consult，只传工具名；用 bridge_receive/bridge_reply 收发原会话问题。无需单独安装 Cursor CLI；桥接会使用 Cursor Desktop 自带启动器准备 agent 运行时。",
};

/**
 * 选择真正生效的 Claude Desktop 配置。
 *
 * Claude Desktop 的 3p 部署把用户数据放在 `Claude-3p`，旧安装可能仍用 `Claude`。
 * 优先写当前存在的 `Claude-3p`，否则回退到标准目录。
 */
const claudeDesktopConfig = () => {
  const root = join(homedir(), "Library", "Application Support");
  const current = join(root, "Claude-3p", "claude_desktop_config.json");
  return existsSync(current) || existsSync(dirname(current))
    ? current
    : join(root, "Claude", "claude_desktop_config.json");
};

/**
 * 写入 Codex 用户级 MCP 配置。
 *
 * 只替换 `[mcp_servers.ai-bridge]` 这一段，保留用户其他 provider/model/MCP 设置。
 * 自动审批只覆盖 ai-bridge 的工具，不改变 Codex 全局审批策略。
 */
async function configureCodex({
  dir,
  nodePath,
  scriptPath,
  codexConfigPath,
  rulePath,
}) {
  const configPath =
    codexConfigPath ||
    join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  let raw = "";
  try {
    raw = await readFile(configPath, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT")
      throw Error("Cannot read Codex config: " + e.message);
  }
  if (/^\s*mcp_servers\s*=\s*\{/m.test(raw))
    throw Error(
      "Codex config uses an inline mcp_servers table; add ai-bridge manually",
    );
  const block = `[mcp_servers.ai-bridge]\ncommand = ${JSON.stringify(nodePath)}\nargs = [${[scriptPath, "--dir", resolve(dir), "--tool", "codex"].map(JSON.stringify).join(", ")}]\ndefault_tools_approval_mode = "approve"\ntool_timeout_sec = 120\n`;
  const header = /^\[\s*mcp_servers\.ai-bridge\s*\]\s*$/m.exec(raw);
  let next;
  if (header) {
    const after = header.index + header[0].length,
      rest = raw.slice(after),
      following = /^\[[^\n]+\]\s*$/m.exec(rest),
      end = following ? after + following.index : raw.length;
    next =
      raw.slice(0, header.index) + block + (following ? raw.slice(end) : "");
  } else {
    const prefix = raw && !raw.endsWith("\n") ? raw + "\n" : raw;
    next = prefix + (prefix.trim() ? "\n" : "") + block;
  }
  if (next !== raw) {
    if (raw) await backupOnce(configPath);
    await writeAtomic(configPath, next);
  }
  const rulesPath = await mergeBridgeRule(
    rulePath || join(dirname(configPath), "AGENTS.md"),
  );
  return {
    configPath,
    rulesPath,
    tool: "codex",
    instructions: instructions.codex,
    notice:
      "Codex 使用用户级配置；首次修改会留下 .ai-bridge-backup。自动审批只覆盖 ai-bridge 的 MCP 工具，只读 Worker 的权限仍由桥接层限制。",
  };
}

/**
 * 写入 DeepSeek Harness 桌面 profile 的 YAML patch。
 *
 * 使用显式起止注释包住托管块，重复运行只替换这一段；
 * 不写入固定 cwd，避免项目目录被移动后 MCP 子进程无法启动。
 */
async function configureDeepSeek({ dir, nodePath, scriptPath, dshHome }) {
  const home = dshHome || process.env.DSH_HOME || join(homedir(), ".dsh");
  const configPath = join(home, "profiles", "desktop", "cordis.patch.yml");
  const args = [scriptPath, "--dir", resolve(dir), "--tool", "deepseek"];
  const block =
    [
      "# >>> ai-bridge managed by Sibyl",
      "- insert:",
      "    - id: ai-bridge-sibyl",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      "        serverName: ai-bridge",
      "        transport: stdio",
      `        command: ${JSON.stringify(nodePath)}`,
      "        args:",
      ...args.map((value) => `          - ${JSON.stringify(value)}`),
      "        env: {}",
      "# <<< ai-bridge managed by Sibyl",
    ].join("\n") + "\n";
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  let raw = "";
  try {
    raw = await readFile(configPath, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT")
      throw Error("Cannot read DeepSeek Harness config: " + e.message);
  }
  const start = "# >>> ai-bridge managed by Sibyl",
    end = "# <<< ai-bridge managed by Sibyl";
  const startAt = raw.indexOf(start),
    endAt = raw.indexOf(end);
  let next;
  if (startAt >= 0 && endAt > startAt)
    next =
      raw.slice(0, startAt) +
      block +
      raw.slice(endAt + end.length).replace(/^\n+/, "");
  else if (raw.replace(/^#.*$/gm, "").trim() === "[]")
    next = raw.replace(/^(\s*)\[\s*\]\s*$/m, block.trimEnd());
  else {
    const prefix = raw && !raw.endsWith("\n") ? raw + "\n" : raw;
    next = prefix + (prefix.trim() ? "\n" : "") + block;
  }
  if (next !== raw) {
    if (raw) await backupOnce(configPath);
    await writeAtomic(configPath, next);
  }
  return {
    configPath,
    tool: "deepseek",
    instructions: instructions.deepseek,
    notice:
      "DeepSeek Harness 使用桌面 profile 的用户 patch 层；重启桌面应用后生效。配置成功不等于原会话已接入。",
  };
}

/**
 * 合并 JSON 格式的 MCP 配置。
 *
 * 保留原文件其他字段；只有在内容真的变化时才备份并原子写入。
 * JSON 解析失败时直接报错，原文件保持不动。
 */
async function mergeMcpJson(configPath, entry) {
  await mkdir(dirname(configPath), { recursive: true });
  let raw = null,
    config = {};
  try {
    raw = await readFile(configPath, "utf8");
    config = JSON.parse(raw);
  } catch (e) {
    if (e.code !== "ENOENT")
      throw Error("Cannot update MCP JSON: " + e.message);
  }
  if (
    !config ||
    Array.isArray(config) ||
    typeof config !== "object" ||
    (config.mcpServers !== undefined &&
      (!config.mcpServers ||
        typeof config.mcpServers !== "object" ||
        Array.isArray(config.mcpServers)))
  )
    throw Error("Invalid MCP JSON structure; original file preserved");
  const previous = config.mcpServers?.["ai-bridge"];
  if (JSON.stringify(previous) !== JSON.stringify(entry)) {
    if (raw !== null) await backupOnce(configPath);
    config.mcpServers = { ...config.mcpServers, "ai-bridge": entry };
    await writeAtomic(configPath, JSON.stringify(config, null, 2) + "\n");
  }
  return configPath;
}

/**
 * Cursor CLI 本地桥接流程的免审批白名单。
 *
 * Cursor 不认 MCP 的 readOnlyHint，headless 运行时会直接拒绝未列入
 * permissions.allow 的 MCP 调用。除了只读发现工具，还必须放行登记、
 * 发起、查询结果和停止这几个调用；否则 Agent 能看见目标但无法完成咨询。
 */
const cursorAllowedTools = [
  "bridge_context",
  "bridge_list_peers",
  "bridge_list_sessions",
  "bridge_open_session",
  "bridge_consult",
  "bridge_consult_result",
  "bridge_consult_stop",
];

/**
 * 合并 Cursor 项目级权限白名单。
 *
 * 只追加桥接自身工具，保留用户已有的 allow/deny 和其他字段；
 * 不修改全局 cli-config.json，也不放行其他 MCP 服务。
 */
async function mergeCursorReadPermissions(project) {
  const configPath = join(resolve(project), ".cursor", "cli.json");
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  let raw = null,
    config = {};
  try {
    raw = await readFile(configPath, "utf8");
    config = JSON.parse(raw);
  } catch (e) {
    if (e.code !== "ENOENT")
      throw Error("Cannot update Cursor permissions: " + e.message);
  }
  if (!config || Array.isArray(config) || typeof config !== "object")
    throw Error("Invalid Cursor permissions structure; original file preserved");
  if (
    config.permissions !== undefined &&
    (!config.permissions ||
      typeof config.permissions !== "object" ||
      Array.isArray(config.permissions))
  )
    throw Error("Invalid Cursor permissions structure; original file preserved");
  const permissions = config.permissions ?? {};
  const allow = permissions.allow ?? [];
  if (!Array.isArray(allow) || allow.some((entry) => typeof entry !== "string"))
    throw Error("Invalid Cursor allow list; original file preserved");
  const deny = permissions.deny ?? [];
  if (!Array.isArray(deny) || deny.some((entry) => typeof entry !== "string"))
    throw Error("Invalid Cursor deny list; original file preserved");
  const additions = cursorAllowedTools
    .map((tool) => `Mcp(ai-bridge:${tool})`)
    .filter((entry) => !allow.includes(entry));
  const changed = additions.length > 0 || permissions.deny === undefined;
  if (changed) {
    if (raw !== null) await backupOnce(configPath);
    config.permissions = {
      ...permissions,
      allow: [...allow, ...additions],
      deny,
    };
    await writeAtomic(configPath, JSON.stringify(config, null, 2) + "\n");
  }
  return configPath;
}

/**
 * 为指定 AI 工具写入 MCP 配置。
 *
 * desktopOnly 只对 Claude/Cursor 生效：用户没有独立 CLI 时必须写桌面 App 全局配置，
 * 否则原会话看不到 ai-bridge。Codex 和 DeepSeek 始终使用各自的用户级配置。
 */
export async function configureNativeTool({
  project,
  tool,
  dir,
  nodePath = process.execPath,
  scriptPath = fileURLToPath(new URL("./native-mcp.mjs", import.meta.url)),
  codexConfigPath,
  dshHome,
  desktopOnly = false,
  desktopConfigPath,
  rulePath,
} = {}) {
  if (!["claude", "cursor", "codex", "deepseek"].includes(tool))
    throw Error("Unsupported native tool");
  if (tool === "codex")
    return configureCodex({
      dir,
      nodePath,
      scriptPath,
      codexConfigPath,
      rulePath,
    });
  if (tool === "deepseek")
    return configureDeepSeek({ dir, nodePath, scriptPath, dshHome });
  const configPath = desktopOnly
    ? desktopConfigPath ||
      (tool === "claude"
        ? claudeDesktopConfig()
        : join(homedir(), ".cursor", "mcp.json"))
    : join(
        resolve(project),
        tool === "claude" ? ".mcp.json" : ".cursor/mcp.json",
      );
  const entry = {
    command: nodePath,
    args: [scriptPath, "--dir", resolve(dir), "--tool", tool],
  };
  if (tool === "claude") entry.type = "stdio";
  await mergeMcpJson(configPath, entry);
  const permissionsPath =
    tool === "cursor" && !desktopOnly
      ? await mergeCursorReadPermissions(project)
      : null;
  const rulesPath = await mergeBridgeRule(
    rulePath ||
      (tool === "claude"
        ? desktopOnly
          ? join(homedir(), ".claude", "CLAUDE.md")
          : join(resolve(project), "CLAUDE.md")
        : desktopOnly
          ? join(homedir(), ".cursor", "rules", "agents-calling.mdc")
          : join(resolve(project), ".cursor", "rules", "agents-calling.mdc")),
    tool === "cursor"
      ? "---\ndescription: Agents Calling bridge trigger\nalwaysApply: true\n---\n\n"
      : "",
  );
  const notice = desktopOnly
    ? "已写入桌面应用配置；重启对应桌面应用后生效。配置成功不等于原会话已接入。"
    : "登记与接收由原会话实际调用工具完成；配置成功不等于原会话已接入。bridge_consult 按预绑定项目启动只读托管咨询，但不会接管或唤醒目标原聊天。";
  return {
    configPath,
    permissionsPath,
    rulesPath,
    tool,
    instructions:
      (desktopOnly && desktopInstructions[tool]) || instructions[tool],
    notice,
  };
}
