import AppKit
import WebKit

private struct NativeDownload {
    let download: WKDownload
    var destination: URL?
    var staging: URL?
}

final class WorkbenchWindow: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, NSMenuItemValidation {
    private let config: HostConfiguration
    private let connection: ServerConnection
    private let downloadDestination: (String) -> URL?
    private let web: WKWebView
    private let offline = NSView()
    private let detail = NSTextField(wrappingLabelWithString: "Checking the local server…")
    private let launchButton = NSButton(title: "Launch Server", target: nil, action: nil)
    private let progress = NSProgressIndicator()
    private let stopButton = NSButton(title: "Stop Server", target: nil, action: nil)
    private let banner = NSStackView()
    private let bannerText = NSTextField(wrappingLabelWithString: "")
    private let bannerButton = NSButton(title: "Launch Server", target: nil, action: nil)
    private var timer: Timer?
    private var checking = false
    private var launching = false
    private var stopping = false
    private var connectionRevision = 0
    private var keepStopFailure = false
    private var loaded = false
    private var loading = false
    private var needsReconnect = false
    private var healthy = false
    private var failureMessage: String?
    private var initialLoadAttempted = false
    private var allowClose = false
    private var webTop: NSLayoutConstraint!
    private var downloads = [ObjectIdentifier: NativeDownload]()

    /// Compose the native recovery controls around the unmodified online editor.
    /// @param config,downloadDestination: Trusted local settings and optional destination-picker capability.
    /// @pre Main thread; injected picker returns an authorized destination or nil on cancellation.
    /// @post Window owns webview/delegates and disconnected controls; no server is started.
    /// @return Window controller. @throws None.
    init(config: HostConfiguration, downloadDestination: ((String) -> URL?)? = nil) {
        self.config = config
        self.connection = ServerConnection(config: config)
        self.downloadDestination = downloadDestination ?? Self.chooseDownloadDestination
        let settings = WKWebViewConfiguration()
        settings.websiteDataStore = .default()
        settings.preferences.javaScriptCanOpenWindowsAutomatically = true
        self.web = WKWebView(frame: .zero, configuration: settings)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init(window: window)
        window.title = "Research Workbench"
        window.minSize = NSSize(width: 760, height: 520)
        window.setFrameAutosaveName("WorkbenchWindow")
        window.center()
        window.delegate = self
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isHidden = true
        composeContent()
        composeServerControl()
    }

    /// Reject archive construction; native controls require explicit trusted configuration.
    /// @param coder: Unused archive. @pre Unsupported path.
    /// @post Initialization fails. @return nil. @throws None.
    required init?(coder: NSCoder) { return nil }

    /// Choose an export destination through the normal native save dialog.
    /// @param filename: Suggested download name. @pre Main thread.
    /// @post User selects an authorized URL or cancels. @return URL?: Selected destination.
    /// @throws None.
    private static func chooseDownloadDestination(_ filename: String) -> URL? {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = filename
        return panel.runModal() == .OK ? panel.url : nil
    }

    /// Keep the shared backend stop action visible without adding controls to the online web UI.
    /// @param None. @pre Window exists; main thread.
    /// @post Native title-bar accessory owns an accessible Stop Server button.
    /// @return None. @throws None.
    private func composeServerControl() {
        stopButton.target = self
        stopButton.action = #selector(stopServer)
        stopButton.bezelStyle = .rounded
        stopButton.controlSize = .small
        stopButton.toolTip = "Stop the local server used by this app and other Workbench windows"
        stopButton.setAccessibilityLabel("Stop Server")
        stopButton.isEnabled = false
        let accessory = NSTitlebarAccessoryViewController()
        accessory.layoutAttribute = .right
        let holder = NSView(frame: NSRect(x: 0, y: 0, width: 120, height: 28))
        stopButton.frame = NSRect(x: 2, y: 2, width: 112, height: 24)
        holder.addSubview(stopButton)
        accessory.view = holder
        window!.addTitlebarAccessoryViewController(accessory)
    }

    /// Keep native menu actions aligned with lifecycle availability and single-flight operations.
    /// @param menuItem: Proposed native command. @pre Main thread.
    /// @post No mutation. @return Bool: Command may run. @throws None.
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(stopServer) { return healthy && !launching && !stopping }
        if menuItem.action == #selector(launchServer) { return !launching && !stopping }
        if menuItem.action == #selector(reloadEditor) { return healthy && loaded && !launching && !stopping }
        return true
    }

    /// Build native disconnected card and compact reconnect banner without modifying page DOM.
    /// @param None. @pre Window exists. @post Native actions target this controller.
    /// @return None. @throws None.
    private func composeContent() {
        let content = NSView()
        window!.contentView = content
        web.translatesAutoresizingMaskIntoConstraints = false
        offline.translatesAutoresizingMaskIntoConstraints = false
        banner.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(web)
        content.addSubview(offline)
        content.addSubview(banner)
        let symbol = NSImageView(image: NSImage(systemSymbolName: "network.slash", accessibilityDescription: "Local server unavailable")!)
        symbol.contentTintColor = .secondaryLabelColor
        let title = NSTextField(labelWithString: "Research Workbench")
        title.font = .systemFont(ofSize: 27, weight: .semibold)
        detail.alignment = .center
        detail.textColor = .secondaryLabelColor
        detail.font = .systemFont(ofSize: 14)
        detail.preferredMaxLayoutWidth = 420
        launchButton.target = self
        launchButton.action = #selector(launchServer)
        launchButton.bezelStyle = .rounded
        launchButton.controlSize = .large
        launchButton.keyEquivalent = "\r"
        launchButton.isEnabled = false
        progress.style = .spinning
        progress.controlSize = .small
        progress.isDisplayedWhenStopped = false
        let hint = NSTextField(wrappingLabelWithString: "Your research files stay on this computer.\nThe local server stays available when you close this window.")
        hint.alignment = .center
        hint.textColor = .tertiaryLabelColor
        hint.font = .systemFont(ofSize: 12)
        let card = NSStackView(views: [symbol, title, detail, launchButton, progress, hint])
        card.orientation = .vertical
        card.alignment = .centerX
        card.spacing = 20
        card.translatesAutoresizingMaskIntoConstraints = false
        offline.addSubview(card)
        banner.orientation = .horizontal
        banner.spacing = 12
        banner.edgeInsets = NSEdgeInsets(top: 9, left: 16, bottom: 9, right: 16)
        bannerText.font = .systemFont(ofSize: 12)
        bannerText.setContentHuggingPriority(.defaultLow, for: .horizontal)
        bannerButton.target = self
        bannerButton.action = #selector(launchServer)
        bannerButton.bezelStyle = .rounded
        banner.addArrangedSubview(bannerText)
        banner.addArrangedSubview(bannerButton)
        banner.isHidden = true
        webTop = web.topAnchor.constraint(equalTo: content.topAnchor)
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: content.leadingAnchor), web.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webTop, web.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            offline.leadingAnchor.constraint(equalTo: content.leadingAnchor), offline.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            offline.topAnchor.constraint(equalTo: content.topAnchor), offline.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            card.centerXAnchor.constraint(equalTo: offline.centerXAnchor), card.centerYAnchor.constraint(equalTo: offline.centerYAnchor),
            card.widthAnchor.constraint(lessThanOrEqualToConstant: 460), card.leadingAnchor.constraint(greaterThanOrEqualTo: offline.leadingAnchor, constant: 28),
            symbol.widthAnchor.constraint(equalToConstant: 48), symbol.heightAnchor.constraint(equalToConstant: 48),
            banner.leadingAnchor.constraint(equalTo: content.leadingAnchor), banner.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            banner.topAnchor.constraint(equalTo: content.topAnchor), banner.heightAnchor.constraint(equalToConstant: 56)
        ])
    }

    /// Show the window and begin non-destructive availability monitoring.
    /// @param None. @pre Main thread. @post One timer retained; server never auto-starts.
    /// @return None. @throws None.
    func start() {
        showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
        checkServer()
        timer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in self?.checkServer() }
    }

    /// Probe without overlap; preserve an existing page and its unsaved buffers during outages.
    /// @param None. @pre Main thread. @post At most one active health probe.
    /// @return None. @throws None.
    private func checkServer() {
        guard !checking && !launching && !stopping else { return }
        checking = true
        let revision = connectionRevision
        connection.check { [weak self] health in
            guard let self = self else { return }
            self.checking = false
            if !self.launching && !self.stopping && revision == self.connectionRevision { self.receive(health) }
        }
    }

    /// Present a health result with automatic first load and explicit existing-page recovery.
    /// @param health: Verified native health result. @pre Main thread.
    /// @post No loaded editor is automatically reloaded. @return None. @throws None.
    private func receive(_ health: ServerHealth) {
        healthy = health == .ready
        stopButton.isEnabled = healthy && !launching && !stopping
        if healthy {
            if !keepStopFailure { failureMessage = nil }
            if !loaded && !loading && !initialLoadAttempted {
                initialLoadAttempted = true
                loading = true
                web.load(URLRequest(url: config.baseURL)); detail.stringValue = "Opening your workspace…"
            }
            else if needsReconnect {
                bannerText.stringValue = failureMessage ?? "Server ready. Copy any unsaved text before reloading the editor."
                bannerButton.title = keepStopFailure ? "Retry Stop" : "Reload Editor"
                bannerButton.action = keepStopFailure ? #selector(stopServer) : #selector(reloadEditor)
                bannerButton.isEnabled = true
                banner.isHidden = false
                webTop.constant = 56
            }
        } else {
            let message = health == .occupied
                ? "Another service or an older Workbench is using the local port. Close it, then try Launch Server."
                : "The local server is offline. Launch it to open your workspace."
            if !loaded { detail.stringValue = failureMessage ?? message; launchButton.isEnabled = true }
            else {
                needsReconnect = true
                bannerText.stringValue = failureMessage ?? (health == .occupied
                    ? "The local port is busy or the server is still stopping. Your editor is kept."
                    : "Local server unavailable. Your open editor is kept; launch the server to reconnect.")
                bannerButton.title = "Launch Server"
                bannerButton.action = #selector(launchServer)
                bannerButton.isEnabled = true
                banner.isHidden = false
                webTop.constant = 56
            }
        }
    }

    /// Start from a native button/menu only; retryable failures leave the offline controls available.
    /// @param None. @pre Main thread. @post One bounded startup attempt; existing page preserved.
    /// @return None. @throws None; failure shown in native status.
    @objc func launchServer() {
        guard !launching && !stopping else { return }
        launching = true
        connectionRevision += 1
        keepStopFailure = false
        stopButton.isEnabled = false
        failureMessage = nil
        initialLoadAttempted = false
        launchButton.isEnabled = false
        bannerButton.isEnabled = false
        detail.stringValue = "Starting the local server…"
        bannerText.stringValue = "Starting the local server… Your open editor is kept."
        progress.startAnimation(nil)
        connection.launch { [weak self] result in
            guard let self = self else { return }
            self.launching = false
            self.progress.stopAnimation(nil)
            switch result {
            case .success: self.checkServer()
            case .failure(let error):
                self.failureMessage = error.localizedDescription
                self.detail.stringValue = error.localizedDescription
                self.bannerText.stringValue = error.localizedDescription
                self.launchButton.isEnabled = true
                self.bannerButton.isEnabled = true
            }
        }
    }

    /// Confirm shared impact and pending work, then request/verify graceful shutdown from native controls.
    /// @param None. @pre User action on main thread; verified healthy server and no other lifecycle action.
    /// @post Cancel sends no stop request; success retains editor DOM and offers explicit Launch Server.
    /// @return None. @throws None; failure remains visible with safe retry.
    @objc func stopServer() {
        guard healthy && !launching && !stopping else { return }
        stopping = true
        connectionRevision += 1
        stopButton.isEnabled = false
        launchButton.isEnabled = false
        bannerButton.isEnabled = false
        confirmStopping { [weak self] allowed in
            guard let self = self else { return }
            guard allowed else {
                self.stopping = false
                self.stopButton.isEnabled = self.healthy
                self.bannerButton.isEnabled = true
                self.launchButton.isEnabled = true
                return
            }
            self.failureMessage = nil
            self.keepStopFailure = false
            self.needsReconnect = true
            self.bannerText.stringValue = "Stopping the shared server… Active saves and builds will finish first."
            self.detail.stringValue = self.bannerText.stringValue
            if self.loaded { self.banner.isHidden = false; self.webTop.constant = 56 }
            self.connection.stop { [weak self] result in
                guard let self = self else { return }
                self.stopping = false
                switch result {
                case .success:
                    self.failureMessage = "Server stopped. Your open editor is kept. Choose Launch Server to reconnect."
                    self.receive(.offline)
                case .failure(let error):
                    self.failureMessage = error.localizedDescription
                    self.keepStopFailure = true
                    self.bannerText.stringValue = error.localizedDescription
                    self.detail.stringValue = error.localizedDescription
                    self.bannerButton.isEnabled = true
                    self.launchButton.isEnabled = true
                    self.checkServer()
                }
            }
        }
    }

    /// Present one stop-specific confirmation, adding the existing editor's pending-work warning.
    /// @param completion: Main-thread decision callback. @pre No shutdown HTTP request yet.
    /// @post Page remains untouched; user cancellation preserves the running shared server.
    /// @return None. @throws None.
    private func confirmStopping(_ completion: @escaping (Bool) -> Void) {
        hasPendingWork { pending in
            let alert = NSAlert()
            alert.messageText = "Stop the local server?"
            alert.informativeText = "Other Research Workbench windows and browser tabs will disconnect. Your open editor will stay here."
                + (pending ? "\n\nThis editor has unsaved changes or a save in progress. Keep the server running to finish saving, or copy unsaved text before stopping." : "")
            alert.alertStyle = .warning
            alert.addButton(withTitle: "Keep Server Running")
            alert.addButton(withTitle: "Stop Server")
            completion(alert.runModal() == .alertSecondButtonReturn)
        }
    }

    /// Reload only after readiness and the editor's existing beforeunload guard agree.
    /// @param None. @pre Native user action. @post Dirty/save-in-flight state requires confirmation.
    /// @return None. @throws None; errors retain the current page.
    @objc func reloadEditor() {
        guard !launching && !stopping else { return }
        let revision = connectionRevision
        connection.check { [weak self] health in
            guard let self = self else { return }
            guard revision == self.connectionRevision && !self.launching && !self.stopping else { return }
            guard health == .ready else { self.receive(health); return }
            self.confirmLeaving { allowed in
                if allowed && revision == self.connectionRevision && !self.launching && !self.stopping { self.web.reload() }
            }
        }
    }

    /// Read pending editor work through its existing unload event without exposing its private state.
    /// @param completion: Main-thread pending-work callback. @pre Trusted editor or offline screen.
    /// @post No navigation or mutation; query failure conservatively counts as pending.
    /// @return None. @throws None.
    private func hasPendingWork(_ completion: @escaping (Bool) -> Void) {
        guard loaded else { completion(false); return }
        web.evaluateJavaScript("(() => { const e = new Event('beforeunload', {cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented; })()") { value, error in
            completion(error != nil || value as? Bool != false)
        }
    }

    /// Query the existing public unload event without exporting page internals or launch privileges.
    /// @param completion: Main-thread permission callback. @pre Trusted loaded editor or offline screen.
    /// @post No navigation occurs; dirty/in-flight state and query failures require confirmation.
    /// @return None. @throws None.
    func confirmLeaving(_ completion: @escaping (Bool) -> Void) {
        guard loaded && !allowClose else { completion(true); return }
        hasPendingWork { pending in
            if !pending { completion(true); return }
            let alert = NSAlert()
            alert.messageText = "Leave this editor?"
            alert.informativeText = "There may be unsaved changes or a save in progress. Keep the editor open to preserve your work."
            alert.addButton(withTitle: "Keep Editing")
            alert.addButton(withTitle: "Leave Without Saving")
            completion(alert.runModal() == .alertSecondButtonReturn)
        }
    }

    /// Keep native close subject to the editor's unsaved-work protection.
    /// @param sender: Closing window. @pre Main thread.
    /// @post Timer stops only after allowed close; shared/starting server remains independently owned.
    /// @return Bool: Immediate permission. @throws None.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if allowClose { return true }
        confirmLeaving { [weak self] allowed in
            guard let self = self, allowed else { return }
            self.allowClose = true
            self.timer?.invalidate()
            sender.close()
            NSApp.terminate(nil)
        }
        return false
    }

    /// Reveal the real editor after successful navigation; first offline state never becomes a browser error.
    /// @param webView,navigation: Completed load. @pre Main thread.
    /// @post Native offline view hidden and recovery flag cleared. @return None. @throws None.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        loading = false
        needsReconnect = false
        offline.isHidden = true
        web.isHidden = false
        banner.isHidden = true
        webTop.constant = 0
    }

    /// Translate failed navigation into native retry feedback without discarding a previous editor.
    /// @param webView,navigation,error: Failed initial or reload navigation. @pre Main thread.
    /// @post Retry UI remains usable. @return None. @throws None.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loading = false
        if (error as NSError).code != NSURLErrorCancelled {
            failureMessage = "The editor could not load. Try Launch Server again."
            receive(.offline)
        }
    }

    /// Report committed-load failure through the same native recovery controls.
    /// @param webView,navigation,error: Failed load. @pre Main thread.
    /// @post Recovery controls shown. @return None. @throws None.
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        self.webView(webView, didFailProvisionalNavigation: navigation, withError: error)
    }

    /// Keep external websites in the default browser and route native WebKit downloads.
    /// @param webView,navigationAction,decisionHandler: Proposed navigation.
    /// @pre Main thread. @post Only exact local origin/blob content loads in this host.
    /// @return None. @throws None.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.shouldPerformDownload { decisionHandler(.download); return }
        if config.contains(url) || url.scheme == "blob" { decisionHandler(.allow); return }
        if ["https", "http", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    /// Download attachments and unsupported MIME content through a native save panel.
    /// @param webView,navigationResponse,decisionHandler: Response policy inputs.
    /// @pre Active navigation. @post Unsupported responses become downloads.
    /// @return None. @throws None.
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    /// Handle target=_blank without introducing an unguarded embedded browser window.
    /// @param webView,configuration,navigationAction,windowFeatures: Popup inputs.
    /// @pre Native popup request. @post Links open in browser without replacing an unsaved editor.
    /// @return nil: No new native webview. @throws None.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if ["https", "http", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    /// Present the online editor's alert with native controls.
    /// @param webView,message,frame,completionHandler: JavaScript dialog inputs.
    /// @pre Main thread. @post Callback once after dismissal. @return None. @throws None.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.runModal(); completionHandler()
    }

    /// Preserve JavaScript confirmation behavior used by destructive editor actions.
    /// @param webView,message,frame,completionHandler: JavaScript confirmation inputs.
    /// @pre Main thread. @post Callback once with user choice. @return None. @throws None.
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    /// Preserve JavaScript text prompts used by the existing editor.
    /// @param webView,prompt,defaultText,frame,completionHandler: Prompt inputs.
    /// @pre Main thread. @post Callback once, nil on cancel. @return None. @throws None.
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert(); alert.messageText = prompt
        let text = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24)); text.stringValue = defaultText ?? ""
        alert.accessoryView = text; alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn ? text.stringValue : nil)
    }

    /// Keep file inputs available for PDF/source imports.
    /// @param webView,parameters,frame,completionHandler: File input request.
    /// @pre Main thread. @post User-selected URLs returned; cancellation returns nil.
    /// @return None. @throws None.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel(); panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true; panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        completionHandler(panel.runModal() == .OK ? panel.urls : nil)
    }

    /// Retain a navigation-action download for its complete native lifecycle.
    /// @param webView,navigationAction,download: WebKit download handoff.
    /// @pre Main thread. @post Delegate installed. @return None. @throws None.
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        downloads[ObjectIdentifier(download)] = NativeDownload(download: download); download.delegate = self
    }

    /// Retain a response download through the same native lifecycle.
    /// @param webView,navigationResponse,download: Response handoff.
    /// @pre Main thread. @post Delegate installed. @return None. @throws None.
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        downloads[ObjectIdentifier(download)] = NativeDownload(download: download); download.delegate = self
    }

    /// Ask where to save exports, including blob URL ZIP/PDF downloads.
    /// @param download,response,suggestedFilename,completionHandler: Destination request.
    /// @pre Main thread. @post User selects destination or cancels; WebKit receives an absent staging path.
    /// @return None. @throws None.
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        guard let destination = downloadDestination(suggestedFilename) else { completionHandler(nil); return }
        let staging = destination.deletingLastPathComponent().appendingPathComponent(".workbench-download-" + UUID().uuidString)
        downloads[ObjectIdentifier(download)]?.destination = destination
        downloads[ObjectIdentifier(download)]?.staging = staging
        completionHandler(staging)
    }

    /// Release a completed download without affecting editor state.
    /// @param download: Completed transfer. @pre Retained handoff.
    /// @post Complete staging file atomically replaces selection; failure retains old destination.
    /// @return None. @throws None; publication errors shown natively and staging retained for recovery.
    func downloadDidFinish(_ download: WKDownload) {
        guard let state = downloads.removeValue(forKey: ObjectIdentifier(download)),
              let staging = state.staging, let destination = state.destination else { return }
        do {
            if FileManager.default.fileExists(atPath: destination.path) {
                _ = try FileManager.default.replaceItemAt(destination, withItemAt: staging)
            } else { try FileManager.default.moveItem(at: staging, to: destination) }
        } catch { NSAlert(error: error).runModal() }
    }

    /// Report download failure once and release retained transport.
    /// @param download,error,resumeData: Failed transfer and unused resume data.
    /// @pre Main thread. @post Download released; native error shown except user cancellation.
    /// @return None. @throws None.
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let state = downloads.removeValue(forKey: ObjectIdentifier(download)), let staging = state.staging,
           FileManager.default.fileExists(atPath: staging.path) {
            do { try FileManager.default.removeItem(at: staging) }
            catch { NSAlert(error: error).runModal() }
        }
        if (error as NSError).code != NSURLErrorCancelled { NSAlert(error: error).runModal() }
    }
}
