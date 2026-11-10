# Agents Calling Windows 技术版

这是 Windows x64 的技术预览构建，使用 Tauri 2 + WebView2 + NSIS。安装包内置
Node.js 26，用户不需要另外安装 Node。该版本用于验证桌面壳、安装器和 Windows
命令解析链路，**尚未在 Windows 真机完成端到端验收**。

## 获取安装包

安装包由 GitHub Actions 构建，工作流见 `.github/workflows/windows-desktop.yml`。
在 Actions 运行记录中下载 `Agents-Calling-Windows-technical` 产物，解压后运行
NSIS `.exe` 安装程序。

安装器是当前用户安装，不需要管理员权限。首次启动时如 WebView2 缺失，安装器会
使用微软 WebView2 bootstrapper 安装。

## 当前行为

- 单实例：再次双击只恢复已有窗口，不会启动第二个后台。
- 启动时优先接管仍然响应的 `ui-runtime.json` 控制面；没有可接管实例时才启动内置 Node。
- 关闭窗口默认隐藏到托盘；托盘菜单“退出”会先调用认证关闭接口，再结束桌面壳。
- 后台只监听 `127.0.0.1` 随机端口，UI 请求仍要求随机 CSRF token。
- 数据目录：`%LOCALAPPDATA%\AI Bridge`，后台日志：`%LOCALAPPDATA%\AI Bridge\server.log`。
- 卸载通过 Windows“设置 → 应用”完成；当前版本不安装 Windows 服务。

## Windows 工具运行时

Node 层会解析以下入口，不把提示词拼进 shell：

- 原生 `.exe` / `.com`；
- 只包含单条原生转发的 WinGet `.cmd`；
- npm 生成的 `.cmd` / `.ps1` 包装脚本，通过相邻 `package.json` 的 `bin` 字段定位入口；
- 只有一条 `exec ... "$@"` 的 Git Bash shim。

如果自动发现失败，可以用环境变量指定真实入口：

```powershell
$env:SIBYL_CODEX_PATH = 'C:\path\to\codex.exe'
$env:SIBYL_CLAUDE_PATH = 'C:\path\to\claude.exe'
$env:SIBYL_CURSOR_PATH = 'C:\path\to\cursor-agent.exe'
$env:SIBYL_DEEPSEEK_PATH = 'C:\path\to\dsh.exe'
```

Claude 的 `settings.json` 环境变量会在启动子进程时合并，Windows 下按不区分大小写处理。

## 更新

“设置 → 版本与更新”可以检查 GitHub Release。Windows 会优先选择 `.exe`，其次
`.msi`，下载后交给系统安装器。当前不是签名静默升级，也不保证安装器能自动覆盖
正在运行的进程。

## 验证边界与风险

- 本机开发环境是 macOS，本轮没有 Windows VM 或真机，因此没有资格声称“Windows 版已验收”。
- 安装包未做 Authenticode 代码签名，Windows SmartScreen 可能拦截。
- 桌面 App 自带 runtime 的自动发现尚未在 Windows 真机验证；当前可靠路径是 CLI、
  npm/WinGet shim，或显式 `SIBYL_*_PATH`。
- 首次发布前应在 Windows 10 和 Windows 11 x64 上分别验证：安装、启动、WebView2、
  托盘、单实例、CLI 诊断、关闭重开、升级、卸载和残留进程。
- 控制面崩溃后的残留 Node 会由下一次启动优先接管；强制结束桌面壳仍可能留下后台，
  需要后续加入 Windows Job Object 或服务守护。
