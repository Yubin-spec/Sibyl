# AI Bridge

在同一网络中的 Mac 之间连接 AI 编程工具，减少开发问题由人转述的步骤。也支持本机不同工具之间交流。

当前版本 **0.3.0**。桌面端使用 Swift / AppKit / 系统 WebView，桥接服务使用 Node.js，项目与讨论记录使用 SQLite。无第三方 npm 依赖。

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

- 五个页面：会话、电脑、本机 AI、项目、设置。
- 短码审批配对、多设备记录、双向状态同步和撤销。
- 多项目专用 CLI 讨论、消息持久化、SSE 增量更新和定向取消。
- Claude Code / Cursor 项目级 MCP 配置，原聊天登记、定向收件、询问与答复回传。

专用 CLI 讨论与原工具已有聊天是两种接入方式。普通 MCP 需要原聊天调用收信/查询工具，不能自动唤醒未接收消息的空闲聊天。原会话 ID 备注不代表独立核验或接管聊天。

专用 CLI 跨设备对话已有实测；原会话 MCP 有真实 HTTP 和独立进程自动测试。真实 CC / Cursor 原会话的跨设备闭环仍待联调，本机 CC 最近一次检查在初始模型请求阶段超时。详见 [使用说明](使用说明.md)。

## 源码入口

| 文件 | 职责 |
| --- | --- |
| `Desktop.swift` | macOS 窗口、菜单栏、目录选择与后台生命周期 |
| `desktop.html` / `desktop.js` / `desktop.css` | 五页桌面界面 |
| `control.mjs` | 本机 UI API、任务编排与事件流 |
| `bridge.mjs` / `pairing.mjs` | 跨设备协议、工具 CLI 适配与配对 |
| `workspace.mjs` | SQLite 项目、会话、消息与设置 |
| `native-inbox.mjs` / `native-mcp.mjs` | 原聊天收件与 MCP 工具 |
| `native-config.mjs` | 合并项目 MCP 配置 |
| `claude-diagnostics.mjs` | 脱敏诊断摘要 |
| `*.test.mjs` | 自动测试 |
| `build-app.sh` | macOS 打包与临时签名 |

## 数据与提交

桌面运行数据保存在 `~/Library/Application Support/AI Bridge/`，包含配对凭证与聊天记录，不能放进代码仓库。CLI 默认使用的 `.bridge-state/` 和 `.bridge-connections/` 也已排除。

开发过程笔记保留在本机 `.codex-local/` 等目录，使用 Git 本地排除规则，不作为项目内容提交。仓库未复制历史安装包、实际配对凭证、模型密钥或个人机器专用启动脚本。

Git 主分支为 `main`，远程仓库为 [Yubin-spec/Sibyl](https://github.com/Yubin-spec/Sibyl)。`private: true` 仅用于防止意外发布 npm 包，不影响 Git 上传。

## 许可

内置 Node.js 的第三方许可见 [Node-LICENSE](Node-LICENSE)。项目自身的开源许可证尚未指定。
