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
