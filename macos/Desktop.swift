// macOS 宿主外壳：创建 NSWindow/WKWebView、托盘入口，并启动内置 Node 控制面。
// Swift 层只负责窗口生命周期、目录选择和权限存储，不包含桥接业务逻辑。
import Cocoa
import WebKit

// 后台写入的 UI 运行描述。
// appPid 只用于判断描述是否仍归属于一个存活的 App；旧版本或 CLI 启动时可能没有该字段。
private struct RuntimeDescriptor: Decodable {
    let pid: Int32
    let appPid: Int32?
    let url: String
    let token: String
    let version: String
}

// 健康检查只允许停留在本机地址，避免自定义 CSRF 头被 HTTP 重定向带到外部站点。
private final class LocalOnlySessionDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class BridgeApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler, NSWindowDelegate {
    private var window: NSWindow?
    private var web: WKWebView?
    private var backend: Process?
    private var adoptedBackendPID: pid_t?
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

        // 显式设置 Dock 与 App 切换器图标。
        // LaunchServices 可能按 bundle id 复用旧版本的图标缓存，因此这里直接读取当前包内资源。
        if let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
           let icon = NSImage(contentsOf: iconURL) {
            NSApp.applicationIconImage = icon
        }

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

    // 启动或接管内置 Node 控制面。
    // 先读取上次留下的运行描述；同版本且健康时直接复用，避免 App 重启或崩溃后产生第二个后台。
    private func startBackend() {
        guard let resources = Bundle.main.resourceURL else { return }
        // 数据目录继续使用旧名 AI Bridge，确保改名后仍能读到旧版本历史与配对凭证。
        let dataDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AI Bridge")
        do { try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true) }
        catch { showError(error.localizedDescription); return }

        guard let runtime = readRuntimeDescriptor(dataDir) else {
            launchBackend(resources: resources, dataDir: dataDir)
            return
        }

        // 只有格式正确、版本一致的本机地址才值得发起健康检查。
        if runtime.version == appVersion, let url = localBackendURL(runtime.url) {
            checkBackend(runtime, url: url) { [weak self] healthy in
                DispatchQueue.main.async {
                    guard let self = self, !self.shuttingDown else { return }
                    if healthy { self.adoptBackend(runtime, url: url) }
                    else { self.replaceBackend(runtime, resources: resources, dataDir: dataDir) }
                }
            }
            return
        }

        replaceBackend(runtime, resources: resources, dataDir: dataDir)
    }

    // 当前 App 的版本号。
    // 必须与后台描述一致，防止新版外壳误连到旧版控制面而缺少新接口。
    private var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }

    // 读取 ui-runtime.json。
    // 文件不存在表示首次启动；JSON 损坏时删除它，随后按正常流程启动新后台。
    private func readRuntimeDescriptor(_ dataDir: URL) -> RuntimeDescriptor? {
        let file = dataDir.appendingPathComponent("ui-runtime.json")
        guard let data = try? Data(contentsOf: file) else { return nil }
        do { return try JSONDecoder().decode(RuntimeDescriptor.self, from: data) }
        catch {
            try? FileManager.default.removeItem(at: file)
            return nil
        }
    }

    // 校验运行描述里的地址。
    // 只接受 127.0.0.1 的 HTTP 随机端口，且不允许用户名、查询参数或片段。
    private func localBackendURL(_ value: String) -> URL? {
        guard let url = URL(string: value), url.scheme == "http", url.host == "127.0.0.1",
              let port = url.port, (1...65535).contains(port), url.user == nil, url.password == nil,
              (url.path.isEmpty || url.path == "/"), url.query == nil, url.fragment == nil else { return nil }
        return url
    }

    // 请求 /api/version 验证后台确实可用。
    // 成功条件同时包括 HTTP 200、返回地址仍在本机、版本完全一致，避免只凭 PID 或端口猜测。
    private func checkBackend(_ runtime: RuntimeDescriptor, url: URL, completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: url.appendingPathComponent("api/version"))
        request.timeoutInterval = 2
        request.setValue(runtime.token, forHTTPHeaderField: "x-bridge-ui")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 2
        configuration.timeoutIntervalForResource = 3
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration, delegate: LocalOnlySessionDelegate(), delegateQueue: nil)
        session.dataTask(with: request) { data, response, error in
            defer { session.invalidateAndCancel() }
            guard error == nil, let http = response as? HTTPURLResponse, http.statusCode == 200,
                  http.url?.host == "127.0.0.1", http.url?.port == url.port, let data = data,
                  let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  body["version"] as? String == runtime.version else {
                completion(false)
                return
            }
            completion(true)
        }.resume()
    }

    // 复用已有后台。
    // 如果描述归属的 App 已经退出，就把后台记为本 App 接管；正常退出时一并清理。
    private func adoptBackend(_ runtime: RuntimeDescriptor, url: URL) {
        adoptedBackendPID = runtime.appPid.map(processExists) == true ? nil : pid_t(runtime.pid)
        loaded = true
        allowedURL = url
        appendDiagnostics("Adopted running backend (PID \(runtime.pid))\n")
        web?.load(URLRequest(url: url))
    }

    // 判断 PID 是否仍存在。
    // signal 0 只做权限和存在性检查，不会终止进程。
    private func processExists(_ pid: pid_t) -> Bool {
        pid > 0 && kill(pid, 0) == 0
    }

    // 确认 PID 确实是本项目目录下的控制面 Node。
    // 终止前必须过这一关，避免运行描述被篡改后误杀 Codex、Claude、Cursor 或 DeepSeek。
    private func bridgeProcessMatches(_ pid: pid_t, dataDir: URL) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-p", String(pid), "-ww", "-o", "command="]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0,
                  let data = try output.fileHandleForReading.readToEnd(),
                  let command = String(data: data, encoding: .utf8) else { return false }
            return command.contains("src/app/control.mjs") && command.contains(dataDir.path)
        } catch { return false }
    }

    // 处理不健康、旧版本或失联的运行描述。
    // 只有确认是旧版遗留后台时才终止；仍被另一个存活 App 使用时只提示，不抢也不杀。
    private func replaceBackend(_ runtime: RuntimeDescriptor, resources: URL, dataDir: URL) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            let ownsBridge = self.bridgeProcessMatches(pid_t(runtime.pid), dataDir: dataDir)
            let ownerAlive = runtime.appPid.map(self.processExists) ?? false
            if ownsBridge && ownerAlive {
                DispatchQueue.main.async {
                    self.showError("检测到一个仍在运行的 Agents Calling 后台，但版本或状态不匹配。请先退出旧窗口，再重新打开应用。")
                }
                return
            }
            guard ownsBridge else {
                try? FileManager.default.removeItem(at: dataDir.appendingPathComponent("ui-runtime.json"))
                DispatchQueue.main.async { self.launchBackend(resources: resources, dataDir: dataDir) }
                return
            }
            self.terminateOrphan(pid_t(runtime.pid), dataDir: dataDir) {
                DispatchQueue.main.async { self.launchBackend(resources: resources, dataDir: dataDir) }
            }
        }
    }

    // 优雅终止失联后台，超时后强制结束。
    // 每次发信号前都重新确认进程身份，清理范围仅限当前数据目录的控制面。
    private func terminateOrphan(_ pid: pid_t, dataDir: URL, completion: @escaping () -> Void) {
        kill(pid, SIGTERM)
        let deadline = Date().addingTimeInterval(2)
        func waitForExit() {
            if !processExists(pid) || Date() >= deadline {
                if processExists(pid) && bridgeProcessMatches(pid, dataDir: dataDir) { kill(pid, SIGKILL) }
                try? FileManager.default.removeItem(at: dataDir.appendingPathComponent("ui-runtime.json"))
                completion()
                return
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { waitForExit() }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { waitForExit() }
    }

    // 用登录 shell 启动 src/app/control.mjs。
    // 保留用户已有的 CLI 登录环境；读取 stdout 里的随机端口，并把自己的 PID 交给后台记录。
    private func launchBackend(resources: URL, dataDir: URL) {
        adoptedBackendPID = nil
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        // Preserve CLI authentication configured in the user's login shell. Paths remain argv values.
        process.arguments = ["-lic", "exec \"$@\"", "ai-bridge", resources.appendingPathComponent("node").path, resources.appendingPathComponent("src/app/control.mjs").path, dataDir.path, String(ProcessInfo.processInfo.processIdentifier)]
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
    // 本 App 启动的后台走 Process；从失联 App 接管的后台按 PID 做同样的优雅退出。
    func applicationWillTerminate(_ notification: Notification) {
        shuttingDown = true
        web?.configuration.userContentController.removeScriptMessageHandler(forName: "bridge")
        if let process = backend, process.isRunning {
            process.terminate()
            let deadline = Date().addingTimeInterval(2)
            while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        } else if let pid = adoptedBackendPID, processExists(pid) {
            kill(pid, SIGTERM)
            let deadline = Date().addingTimeInterval(2)
            while processExists(pid) && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
            if processExists(pid) { kill(pid, SIGKILL) }
            try? FileManager.default.removeItem(at: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AI Bridge/ui-runtime.json"))
        }
    }
}

let application = NSApplication.shared
let delegate = BridgeApp()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
