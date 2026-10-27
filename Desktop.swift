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

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出 AI Bridge", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
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
        item.button?.title = "AI Bridge"
        let trayMenu = NSMenu()
        let show = trayMenu.addItem(withTitle: "显示 AI Bridge", action: #selector(showWindow), keyEquivalent: "")
        show.target = self
        trayMenu.addItem(.separator())
        trayMenu.addItem(withTitle: "退出 AI Bridge", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.menu = trayMenu
        statusItem = item
        showWindow()
        startBackend()
    }

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
        window.title = "AI Bridge · 团队 AI 协作"
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
        web.loadHTMLString("<html><body style='background:#f7f8f3;color:#285b46;font:18px -apple-system;padding:60px'><h1>AI Bridge</h1><p>正在启动本机桥接服务…</p></body></html>", baseURL: nil)
        if let url = allowedURL { web.load(URLRequest(url: url)) }
        if let error = lastError { showError(error) }
    }

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

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    private func startBackend() {
        guard let resources = Bundle.main.resourceURL else { return }
        let dataDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AI Bridge")
        do { try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true) }
        catch { showError(error.localizedDescription); return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        // Preserve CLI authentication configured in the user's login shell. Paths remain argv values.
        process.arguments = ["-lic", "exec \"$@\"", "ai-bridge", resources.appendingPathComponent("node").path, resources.appendingPathComponent("control.mjs").path, dataDir.path]
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

    private func consume(_ text: String) {
        appendDiagnostics(text)
        guard !loaded, let marker = received.range(of: "BRIDGE_UI_READY=") else { return }
        let suffix = received[marker.upperBound...]
        guard let end = suffix.firstIndex(of: "\n"), let url = URL(string: String(suffix[..<end])),
              url.scheme == "http", url.host == "127.0.0.1", url.port != nil else { return }
        loaded = true; allowedURL = url
        web?.load(URLRequest(url: url))
    }

    private func appendDiagnostics(_ text: String) {
        received = String((received + text).suffix(16384))
    }

    private func showError(_ message: String) {
        lastError = message
        guard window != nil else { return }
        let alert = NSAlert(); alert.messageText = "AI Bridge 无法启动"; alert.informativeText = message; alert.runModal()
    }

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

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "about" || (url.host == "127.0.0.1" && url.port == allowedURL?.port) { decisionHandler(.allow) }
        else { decisionHandler(.cancel) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        showError("界面加载失败：" + error.localizedDescription + "\n" + String(received.suffix(4000)))
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showError("界面进程已退出。请关闭窗口，再从菜单栏重新打开。后台服务仍在运行。")
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
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
