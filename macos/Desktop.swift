// macOS 宿主外壳：创建 NSWindow/WKWebView、托盘入口，并启动内置 Node 控制面。
// Swift 层只负责窗口生命周期、目录选择和权限存储，不包含桥接业务逻辑。
import Cocoa
import WebKit

final class BridgeApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler, NSWindowDelegate {
    private var window: NSWindow?
    private var web: WKWebView?
    private var backend: Process?
    private var statusItem: NSStatusItem?
    private var closeToTray = UserDefaults.standard.object(forKey: "closeToTray") as? Bool ?? true
    private var lastError: String?
    private var received = ""
    private var loaded = false
    private var allowedURL: URL?
    private var shuttingDown = false

    // 应用启动入口。
    // 创建菜单栏、托盘和主窗口，然后启动内置 Node 控制面。
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出 Agents Calling", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        for (title, selector, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        editItem.title = "编辑"; editItem.submenu = editMenu; menu.addItem(editItem)
        NSApp.mainMenu = menu
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "Agents Calling"
        let trayMenu = NSMenu()
        let show = trayMenu.addItem(withTitle: "显示 Agents Calling", action: #selector(showWindow), keyEquivalent: "")
        show.target = self
        trayMenu.addItem(.separator())
        trayMenu.addItem(withTitle: "退出 Agents Calling", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.menu = trayMenu
        statusItem = item
        showWindow()
        startBackend()
    }

    // 显示或重建主窗口。
    // 窗口已存在时置前；不存在时创建 WKWebView 并加载 UI。
    @objc private func showWindow() {
        if let window = window {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 860), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        self.window = window
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.title = "Agents Calling · 团队 AI 协作"
        window.minSize = NSSize(width: 850, height: 650)
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "bridge")
        let web = WKWebView(frame: window.contentView!.bounds, configuration: config)
        self.web = web
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        window.contentView = web
        window.center(); window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        web.loadHTMLString("<html><body style='background:#f7f8f3;color:#285b46;font:18px -apple-system;padding:60px'><h1>Agents Calling</h1><p>正在启动本机桥接服务…</p></body></html>", baseURL: nil)
        if let url = allowedURL { web.load(URLRequest(url: url)) }
        if let error = lastError { showError(error) }
    }

    // 处理关闭窗口。
    // closeToTray=true 时只销毁 WebView 并隐藏窗口；否则退出应用。
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if !closeToTray { NSApp.terminate(nil); return false }
        web?.stopLoading()
        web?.navigationDelegate = nil
        web?.configuration.userContentController.removeScriptMessageHandler(forName: "bridge")
        window?.contentView = nil
        web = nil
        window = nil
        return true
    }

    // 处理 Dock 图标重新打开。
    // 用户点击 Dock 时恢复主窗口。
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    // 启动内置 Node 控制面。
    // 用登录 shell 启动 src/app/control.mjs，保留用户已有的 CLI 登录环境；读取 stdout 里的随机端口。
    private func startBackend() {
        guard let resources = Bundle.main.resourceURL else { return }
        // 数据目录继续使用旧名 AI Bridge，确保改名后仍能读到旧版本历史与配对凭证。
        let dataDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AI Bridge")
        do { try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true) }
        catch { showError(error.localizedDescription); return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        // Preserve CLI authentication configured in the user's login shell. Paths remain argv values.
        process.arguments = ["-lic", "exec \"$@\"", "ai-bridge", resources.appendingPathComponent("node").path, resources.appendingPathComponent("src/app/control.mjs").path, dataDir.path]
        var environment = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        environment["PATH"] = "\(resources.path):\(home)/.local/bin:\(home)/.claude/local:\(home)/.cursor/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = environment
        process.currentDirectoryURL = dataDir
        let output = Pipe(), errors = Pipe()
        process.standardOutput = output; process.standardError = errors; process.standardInput = FileHandle.nullDevice
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.consume(text) }
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.appendDiagnostics(text) }
        }
        process.terminationHandler = { [weak self] task in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if !self.shuttingDown { self.showError("后台服务已退出（状态 \(task.terminationStatus)）。请退出并重新打开应用。\n" + String(self.received.suffix(4000))) }
            }
        }
        backend = process
        do {
            try process.run()
            DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
                guard let self = self, !self.loaded, !self.shuttingDown, process.isRunning else { return }
                self.showError("后台服务 30 秒内未就绪。请退出并重试。\n" + String(self.received.suffix(4000)))
            }
        }
        catch { showError(error.localizedDescription) }
    }

    // 消费后台 stdout。
    // 累积最近日志；发现 BRIDGE_UI_READY= 后校验必须是 127.0.0.1 并加载 UI。
    private func consume(_ text: String) {
        appendDiagnostics(text)
        guard !loaded, let marker = received.range(of: "BRIDGE_UI_READY=") else { return }
        let suffix = received[marker.upperBound...]
        guard let end = suffix.firstIndex(of: "\n"), let url = URL(string: String(suffix[..<end])),
              url.scheme == "http", url.host == "127.0.0.1", url.port != nil else { return }
        loaded = true; allowedURL = url
        web?.load(URLRequest(url: url))
    }

    // 保存最近诊断输出。
    // 只保留最后 16KB，用于后台启动失败时展示。
    private func appendDiagnostics(_ text: String) {
        received = String((received + text).suffix(16384))
    }

    // 显示启动错误。
    // 窗口还没创建时先缓存，等窗口创建后再弹 NSAlert。
    private func showError(_ message: String) {
        lastError = message
        guard window != nil else { return }
        let alert = NSAlert(); alert.messageText = "Agents Calling 无法启动"; alert.informativeText = message; alert.runModal()
    }

    // 处理前端 JS 消息。
    // 只接受本机主 frame；支持保存托盘偏好和打开目录选择器。
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.request.url?.host == "127.0.0.1",
              message.frameInfo.request.url?.port == allowedURL?.port,
              message.frameInfo.isMainFrame else { return }
        if let preference = message.body as? [String: Any],
           preference["action"] as? String == "preferences",
           let value = preference["closeToTray"] as? Bool {
            closeToTray = value
            UserDefaults.standard.set(value, forKey: "closeToTray")
            return
        }
        guard let action = message.body as? String, action == "chooseFolder", let window = window else { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false
        panel.message = "选择 AI 协作使用的本机项目目录"; panel.prompt = "选择项目"
        panel.beginSheetModal(for: window) { [weak self] result in
            guard result == .OK, let path = panel.url?.path,
                  let data = try? JSONSerialization.data(withJSONObject: [path]),
                  let json = String(data: data, encoding: .utf8) else { return }
            self?.web?.evaluateJavaScript("window.bridgeSetProject(\(json)[0])", completionHandler: nil)
        }
    }

    // 限制 WebView 导航。
    // 只允许 about:blank 和当前 127.0.0.1 控制面端口，其它地址一律取消。
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "about" || (url.host == "127.0.0.1" && url.port == allowedURL?.port) { decisionHandler(.allow) }
        else { decisionHandler(.cancel) }
    }

    // 处理页面加载失败。
    // 忽略用户主动取消；其它错误显示给用户。
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        showError("界面加载失败：" + error.localizedDescription + "\n" + String(received.suffix(4000)))
    }

    // 处理 WebContent 进程崩溃。
    // 提示用户重新打开应用，避免白屏。
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showError("界面进程已退出。请关闭窗口，再从菜单栏重新打开。后台服务仍在运行。")
    }

    // 关闭最后一个窗口时不退出。
    // 保持托盘和后台服务运行；真正退出走菜单或 closeToTray=false。
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // 应用退出清理。
    // 标记 shuttingDown 并终止后台 Node 进程。
    func applicationWillTerminate(_ notification: Notification) {
        shuttingDown = true
        web?.configuration.userContentController.removeScriptMessageHandler(forName: "bridge")
        if let process = backend, process.isRunning {
            process.terminate()
            let deadline = Date().addingTimeInterval(2)
            while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }
}

let application = NSApplication.shared
let delegate = BridgeApp()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
