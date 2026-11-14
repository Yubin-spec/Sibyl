# Agents Calling

在同一网络中的 Mac / Windows 之间连接 AI 编程工具，减少开发问题由人转述的步骤。也支持本机不同工具之间交流。

当前版本 **0.5.1**。macOS 桌面端使用 Swift / AppKit / 系统 WebView；Windows 技术版使用 Tauri 2 / WebView2。桥接服务使用 Node.js，项目、讨论与核对线程使用 SQLite。无第三方 npm 依赖。

下载安装包：[yubin-spec.github.io/Sibyl](https://yubin-spec.github.io/Sibyl/)（直达 GitHub Releases，无网盘或广告跳转）。App 的“设置 → 版本与更新”可直接检查并下载新版本。

## 开发与构建

开发需要 Node.js 26 或更新版本。构建桌面 App 还需要 Apple Silicon Mac、Xcode Command Line Tools；成品支持 macOS 13.5 以上。

```sh
npm test
npm start
npm run build
```

不需要执行 `npm install`。`npm start` 启动本地服务并输出界面地址；完整的原生目录选择与菜单栏功能需要运行桌面 App。

打包需要可独立运行的 macOS arm64 Node.js（仅依赖 macOS 系统库）。部分 Homebrew Node 依赖外部动态库，脚本会在打包前拒绝，避免生成无法启动的 App。可以通过第二参数或环境变量指定独立二进制：

```sh
AI_BRIDGE_NODE=/path/to/standalone/node npm run build
```

构建产物是 `dist/Agents Calling.app`，内置构建时使用的 Node.js。构建脚本执行本地临时签名，未进行 Apple 开发者签名或公证。成品、安装包和运行数据由 `.gitignore` 排除。

Windows 安装包由 GitHub Actions 的 `Windows desktop technical build` 工作流构建。工作流使用 Node.js 26，把 `node.exe` 打进 Tauri 资源，并产出 NSIS 安装器。当前是技术预览：代码和构建链已就位，但没有 Windows 真机验收；安装包未签名，SmartScreen 可能拦截。详见 [Windows 桌面版说明](docs/Windows-desktop.md)。

## 能力与验证边界

- 六个页面：会话、运行台、电脑、本机 AI、项目、设置。
- 短码审批配对、同时连接多台电脑、双向状态同步和逐台撤销。
- 接收项目可在接收服务运行中实时切换；未选项目时，用户显式开启“本机只读访问”后，远端 AI 仍可在只读范围内执行核对，不会修改本机文件。
- 多项目专用 CLI 讨论与频道协作：固定轮数或 agent 自主对话，收件侧线不打断主任务，消息持久化、SSE 增量更新和定向取消。
- 原 AI 会话内跨工具核对：在“本机 AI”配置项目 MCP 时一并绑定“询问方项目 + 目标工具 → 目标项目”。Agent 先调用 `bridge_open_session`，再用 `bridge_context` 查看已保存目标；需要核对时主动调用 `bridge_consult`，只传工具名即可在后台启动隔离的只读 Worker，并立即返回 `consultId`。未绑定才回退当前项目，不接管目标原聊天。
- 核对线程与止损：同一来源会话续接同一 Worker 线程；精确重复请求复用原线程；由代码执行 10 分钟 12 次预算、同目标 2 个并发上限、3 分钟总时长、2 分钟无进展停止。App“运行台”显示路由、轮次、进展、结果与停止原因。
- 待处理队列：运行台顶部只显示一项最需要人工处理的事项，侧边栏显示数量；可逐项同意/拒绝配对、查看停止的核对或打开失败会话。非配对项支持“稍后处理”并持久化，避免重复打扰。
- Claude Code / Cursor 项目级 MCP 配置，Codex 用户级 MCP 配置（仅对 ai-bridge 工具自动审批），DeepSeek Harness 桌面 profile 用户 patch 层配置；只安装 Claude/Cursor 桌面 App 时自动写入桌面全局 MCP 配置。Cursor CLI 未绑定目标时只自动放行只读发现工具，保存绑定后才放行本地咨询链路。原聊天登记、定向收件、询问与答复回传。

专用 CLI 讨论与原工具已有聊天是两种接入方式。桌面 App 检测不依赖终端 PATH；Codex、DeepSeek Harness 和 Claude Desktop 可直接发现 App 内置运行时，Cursor 可通过桌面 App 自带启动器准备 agent 运行时。只装桌面 App 时仍可配置原会话 MCP；运行时尚未准备好时，本机诊断和托管咨询会明确提示，不会伪装成已可用。普通 MCP 需要原聊天调用收信/查询工具，不能自动唤醒未接收消息的空闲聊天。原会话 ID 备注不代表独立核验或接管聊天。

专用 CLI 跨设备对话已有实测；原会话 MCP 有真实 HTTP 和独立进程自动测试。本机 Codex 原会话 → Claude 只读 Worker、Cursor CLI 原会话跨独立实例收信回复已实测（loopback 与真实 LAN IP 双向配对）；DeepSeek Harness headless 只读调用、session 续接及桌面 GUI 原会话 MCP 调用已实测。两台物理电脑、Cursor GUI 原会话和主动推送仍未验证。详见 [使用说明](使用说明.md)。

## 源码入口

| 文件 | 职责 |
| --- | --- |
| `macos/Desktop.swift` | macOS 窗口、菜单栏、目录选择与后台生命周期 |
| `src/ui/desktop.html` / `desktop.js` / `desktop.css` | 六页桌面界面 |
| `src/app/control.mjs` | 本机 UI API、任务编排与事件流 |
| `src/app/workspace.mjs` | SQLite 项目、会话、消息与设置 |
| `src/bridge/bridge.mjs` / `pairing.mjs` | 跨设备协议、工具运行时适配与配对 |
| `src/bridge/attention.mjs` / `consult-policy.mjs` / `channel*.mjs` | 待处理队列、核对预算与自主频道策略 |
| `src/native/native-inbox.mjs` / `native-mcp.mjs` | 原聊天收件与 MCP 工具 |
| `src/native/native-config.mjs` | 合并 Claude/Cursor 项目 MCP、Codex 用户级配置与 DeepSeek Harness 用户 patch 层配置 |
| `src/platform/claude-diagnostics.mjs` / `update.mjs` | 脱敏诊断摘要与远程更新检查 |
| `src/platform/runtime.mjs` / `project-path.mjs` | Windows 命令入口解析、Claude 环境合并与项目路径身份 |
| `src-tauri/` / `windows/frontend/` | Windows Tauri 壳、图标与启动页 |
| `.github/workflows/windows-desktop.yml` | Windows Node 测试、Tauri 构建与安装包产物 |
| `tests/*.test.mjs` | 自动测试 |
| `macos/build-app.sh` | macOS 打包与临时签名 |

## 数据与提交

macOS 桌面运行数据保存在 `~/Library/Application Support/AI Bridge/`；Windows 技术版保存在 `%LOCALAPPDATA%\AI Bridge`。目录名沿用旧版，包含配对凭证与聊天记录，不能放进代码仓库。CLI 默认使用的 `.bridge-state/` 和 `.bridge-connections/` 也已排除。

开发过程笔记保留在本机 `.codex-local/` 等目录，使用 Git 本地排除规则，不作为项目内容提交。仓库未复制历史安装包、实际配对凭证、模型密钥或个人机器专用启动脚本。

Git 主分支为 `main`，远程仓库为 [Yubin-spec/Sibyl](https://github.com/Yubin-spec/Sibyl)。`private: true` 仅用于防止意外发布 npm 包，不影响 Git 上传。

## 许可

内置 Node.js 的第三方许可见 [Node-LICENSE](Node-LICENSE)。项目自身的开源许可证尚未指定。
