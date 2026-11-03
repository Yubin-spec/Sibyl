# AI Bridge

在同一网络中的 Mac 之间连接 AI 编程工具，减少开发问题由人转述的步骤。也支持本机不同工具之间交流。

当前版本 **0.5.0**。桌面端使用 Swift / AppKit / 系统 WebView，桥接服务使用 Node.js，项目、讨论与核对线程使用 SQLite。无第三方 npm 依赖。

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

构建产物是 `dist/AI Bridge.app`，内置构建时使用的 Node.js。构建脚本执行本地临时签名，未进行 Apple 开发者签名或公证。成品、安装包和运行数据由 `.gitignore` 排除。

## 能力与验证边界

- 六个页面：会话、运行台、电脑、本机 AI、项目、设置。
- 短码审批配对、同时连接多台电脑、双向状态同步和逐台撤销。
- 多项目专用 CLI 讨论与频道协作：固定轮数或 agent 自主对话，收件侧线不打断主任务，消息持久化、SSE 增量更新和定向取消。
- 原 AI 会话内跨工具核对：在“本机 AI”配置项目 MCP 时一并绑定“询问方项目 + 目标工具 → 目标项目”，`bridge_consult` 只传工具名即可在后台启动隔离的只读 Worker，并立即返回 `consultId`；未绑定才回退当前项目，不接管目标原聊天。
- 核对线程与止损：同一来源会话续接同一 Worker 线程；精确重复请求复用原线程；由代码执行 10 分钟 12 次预算、同目标 2 个并发上限、3 分钟总时长、2 分钟无进展停止。App“运行台”显示路由、轮次、进展、结果与停止原因。
- 待处理队列：运行台顶部只显示一项最需要人工处理的事项，侧边栏显示数量；可逐项同意/拒绝配对、查看停止的核对或打开失败会话。非配对项支持“稍后处理”并持久化，避免重复打扰。
- Claude Code / Cursor 项目级 MCP 配置，Codex 用户级 MCP 配置（仅对 ai-bridge 工具自动审批）；原聊天登记、定向收件、询问与答复回传。

专用 CLI 讨论与原工具已有聊天是两种接入方式。普通 MCP 需要原聊天调用收信/查询工具，不能自动唤醒未接收消息的空闲聊天。原会话 ID 备注不代表独立核验或接管聊天。

专用 CLI 跨设备对话已有实测；原会话 MCP 有真实 HTTP 和独立进程自动测试。本机 Codex 原会话 → Claude 只读 Worker → 结果回传已实测；跨设备原会话闭环、Cursor 自动推送仍未验证。详见 [使用说明](使用说明.md)。

## 源码入口

| 文件 | 职责 |
| --- | --- |
| `Desktop.swift` | macOS 窗口、菜单栏、目录选择与后台生命周期 |
| `desktop.html` / `desktop.js` / `desktop.css` | 六页桌面界面 |
| `control.mjs` | 本机 UI API、任务编排与事件流 |
| `attention.mjs` | 待处理队列的优先级、隐藏规则与跨页面提醒数据 |
| `consult-policy.mjs` | 核对路由指纹、预算、并发与进展判定 |
| `bridge.mjs` / `pairing.mjs` | 跨设备协议、工具 CLI 适配与配对 |
| `workspace.mjs` | SQLite 项目、会话、消息与设置 |
| `native-inbox.mjs` / `native-mcp.mjs` | 原聊天收件与 MCP 工具 |
| `native-config.mjs` | 合并项目 MCP 配置与 Codex 用户级配置 |
| `claude-diagnostics.mjs` | 脱敏诊断摘要 |
| `*.test.mjs` | 自动测试 |
| `build-app.sh` | macOS 打包与临时签名 |

## 数据与提交

桌面运行数据保存在 `~/Library/Application Support/AI Bridge/`，包含配对凭证与聊天记录，不能放进代码仓库。CLI 默认使用的 `.bridge-state/` 和 `.bridge-connections/` 也已排除。

开发过程笔记保留在本机 `.codex-local/` 等目录，使用 Git 本地排除规则，不作为项目内容提交。仓库未复制历史安装包、实际配对凭证、模型密钥或个人机器专用启动脚本。

Git 主分支为 `main`，远程仓库为 [Yubin-spec/Sibyl](https://github.com/Yubin-spec/Sibyl)。`private: true` 仅用于防止意外发布 npm 包，不影响 Git 上传。

## 许可

内置 Node.js 的第三方许可见 [Node-LICENSE](Node-LICENSE)。项目自身的开源许可证尚未指定。
