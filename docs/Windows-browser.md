# Windows 浏览器版

在 Windows 上双击仓库中的 `start-browser.cmd`。它会选择 Node.js 26+，在当前用户的 `%LOCALAPPDATA%\AI Bridge` 启动后台，再打开浏览器。重复启动会复用已有服务。当前机器已经备有独立 Node 26，无需更换全局 Node。

命令行也可以运行：

```powershell
.\start-browser.ps1
.\start-browser.ps1 -NoOpen
.\start-browser.ps1 -Stop
```

指定目录可加 `-DataDir 'D:\my data\AI Bridge'`。也可把 `SIBYL_NODE` 指向 Node 26+ 的 `node.exe`。有 Node 26+ 时，跨平台启动命令是 `node browser.mjs`，后台直启为 `node control.mjs`。关闭浏览器标签不会退出后台。

## 接入原聊天

1. 在“项目”保存原聊天使用的本机目录。浏览器直接填写 Windows 绝对路径。
2. 在“本机 AI → 原会话 MCP 联络”选择这个项目，分别配置 Codex 和 Claude Code。
3. Codex 配置写入项目 `.codex/config.toml`；Claude Code 写入 `.mcp.json`。保留其他配置，已有文件首次改写会备份为 `.ai-bridge-backup`。不改模型、密钥或用户级设置。
4. 在原工具启用 `ai-bridge`。Codex 项目必须受信任；Claude 可用 `/mcp` 检查/重连。已打开的聊天若尚未看到工具，重载 MCP 或续接同一原会话。配置保存不等于工具已在当前聊天加载。

给双方原聊天的起始指令可以是：

> 在当前聊天调用 bridge_open_session，用清楚的任务主题登记，并保存返回的 sessionId。用 bridge_list_peers 找到本机（id 为 local），再用 bridge_list_sessions 查看同机原会话。收到针对本任务的问题时，在当前上下文中分析，再调用 bridge_reply；需要请对方帮忙时调用 bridge_ask。保留问题编号，若仍排队则用 bridge_result 查询，收到答复后继续当前任务，不重复发问。

本机联络无需配对自己或启动局域网接收服务。工具顺序：

```text
Codex 原聊天                               Claude 原聊天
bridge_open_session                        bridge_open_session
bridge_list_sessions(connectionId=local)
bridge_ask(targetSessionId=Claude句柄)   →   bridge_receive
                                        ←   bridge_reply
bridge_result（等待中才需要）
结合答复继续原工作                           可反向提问，流程相同
```

`bridge_ask` 最多等待 25 秒。如果接收方尚未回复，会返回 queued/delivered 和原 questionId；稍后用 `bridge_result`，不要重发。对方用收到消息中的 peerId 和 questionId 回复。不要跨聊天复制 sessionId。

普通 MCP 是主动收信模式，不会自动唤醒已闲置的聊天；收信需要原工具实际调用 `bridge_receive`。后台不会偷偷新建 CLI 会话代答，也不会因此扩大原任务权限。MCP 进程结束后其登记句柄失效，重连后需要在原聊天重新登记。

### 已打开的原会话与身份边界

项目配置写入后，已启动的宿主可能尚未加载新服务器。可以使用宿主支持的 MCP 重载，或通过官方续接功能继续**同一原会话**。续接时应核对原生会话 ID、原历史与实际工具调用记录；不要通过新建会话或 fork 来代替。

当前执行的模型也可以通过自己的现有工具驱动 MCP stdio 传输适配器。这不会另启模型，但它与“向桌面宿主热注入新工具”是不同的接入方式，需要如实记录。

路由由随机 `sessionId`、私有租约和目标 `targetSessionId` 决定，`nativeSessionId` 是自报备注，不参与身份验证。正常注销会立即使句柄失效；异常退出后，最后一次心跳 90 秒内仍可能显示在线，过期定时扫描每 30 秒执行。重建 MCP 后会取得新句柄，即使自报原生 ID 相同，也不会自动复用旧句柄。后台重启会将未完成问题标为 `interrupted`。

三个状态只说明以下事实：

| 状态 | 能证明的事情 |
| --- | --- |
| `available` | MCP 会话租约仍有效 |
| `delivered` | 目标句柄调用收信并取到了消息 |
| `answered` | 目标句柄的租约持有人提交了回复 |

这些状态不能单独证明模型仍在工作或原生身份可信。原会话验收应另保留实际执行会话 ID、宿主/续接记录、同一历史中的工具调用，以及对方收到答复后继续处理原任务的证据。MCP 进程重建后，旧进程内的询问恢复表不会自动迁移；保留原问题编号并检查后台状态，不应静默重发或用托管 CLI 代答。

已有原会话的执行工具也可调用 `scripts/live-session-mcp.mjs`：它仅保持 MCP 传输，不启动、续接或替换模型。传入 `--session 原生会话ID --tool codex`（或 `claude`），以 `open` 登记，再调用 `sessions / receive / ask / result / reply`；参数可用 `--args-file` 传入 JSON，避免 shell 引号问题。返回值是原始 MCP 结果，正文位于 `content[0].text`。多次命令复用同一连接；`close` 注销，或在 30 分钟无命令后自动退出。填写会话 ID 本身不会接管任何聊天，实际发起这些命令的仍必须是该原会话。

## 环境与可执行文件

### 通过中转使用 Claude Code

CCswitch、claude-code-router 一类工具会把 Claude Code 指向别的模型服务，provider 配置写在 `~/.claude/settings.json` 的 `env` 里（base URL、令牌、模型别名）。交互式 CLI 会读这个文件，但后台进程不会自动继承，表现为 CLI 报 `Not logged in · Please run /login`。

浏览器版启动器现在会合并该文件的 `env`，并以文件里的值为准（与 Claude Code 自身一致）：切换中转后，旧的 base URL 或模型别名不会继续生效。需要换位置时设置 `SIBYL_CLAUDE_SETTINGS`（直接指向文件）或 `CLAUDE_CONFIG_DIR`（指向配置目录）。

### WinGet 安装的 Codex

WinGet 只在 PATH 上放 `codex.cmd` 和 bash shim，不带 `.exe`。启动器会读取包装脚本里指向的原生可执行文件并直接启动它，不会执行批处理内容；无法解析时才需要 `SIBYL_CODEX_PATH` 指向真实 `.exe`。

## 诊断与验证

后台日志在数据目录的 `server.log`。可用 `SIBYL_CODEX_PATH` / `SIBYL_CLAUDE_PATH` 指向明确的原生可执行文件。支持安全解析 npm 启动入口，不需要将模型提示词拼接进 shell。

自动测试（无真实模型请求）：

```powershell
node --test --test-concurrency=1 --test-timeout=30000 *.test.mjs
```

真实模型验收需要客户端已登录，并会消耗模型额度：

```powershell
node scripts/verify-real-mcp.mjs --dir "$env:LOCALAPPDATA\AI Bridge" --report verification/real-mcp.json
```

`--check` 只验证可执行文件与后台连通性，不调用模型。正式验收在两段独立、持续存在的测试会话里验证实际 MCP 工具调用、双向问答及原上下文保留；它不接管桌面中已打开的其他聊天。报告只保留合成校验词、公开会话标识、工具名和通过状态，不保存认证信息。

此版本保留 macOS 原生壳；Windows 使用浏览器。跨电脑配对仍为独立功能，当前同机链路只监听回环地址。
