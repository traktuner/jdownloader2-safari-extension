//
//  AppDelegate.swift  (SwiftUI App entry for MyJDownloader)
//
//  Native menu bar companion to the Safari extension.
//  MyJD data uses the bundled API in an ephemeral WKWebView. Native credentials
//  live in Keychain; Safari maintains its own independent login.
//  The app also answers Click'n'Load on 127.0.0.1:9666 like a local
//  JDownloader, for pages whose requests the extension cannot intercept.
//

import SwiftUI
import Combine
import WebKit
import ServiceManagement
import SafariServices
import Security
import Network
import UserNotifications

@main
struct MyJDownloaderApp: App {
    @NSApplicationDelegateAdaptor(AppLifecycle.self) private var lifecycle
    @StateObject private var jd = JDClient()
    @AppStorage("menuBarEnabled") private var menuBarEnabled = true

    var body: some Scene {
        // The primary window provides setup and remains reachable from Finder
        // even when the optional menu bar icon has been disabled.
        Window("MyJDownloader", id: "settings") {
            SettingsView(jd: jd)
        }
        .defaultSize(width: 480, height: 480)

        MenuBarExtra(isInserted: $menuBarEnabled) {
            MenuBarView(jd: jd)
        } label: {
            MenuBarLabel()
        }
        .menuBarExtraStyle(.window)
    }
}

/// The app lives in the menu bar and runs the Click'n'Load port, so closing
/// its only window must not quit it (SwiftUI's default for a single Window).
/// Opening the app again (Finder, Spotlight) shows the settings window, which
/// also covers a menu bar icon hidden behind the notch or disabled.
final class AppLifecycle: NSObject, NSApplicationDelegate {
    static var openSettings: (() -> Void)?

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { Self.openSettings?() }
        return true
    }
}

/// Menu bar icon; it exists for the app's whole lifetime, so it provides the
/// window-opening action for reopen events.
struct MenuBarLabel: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Image("MenuBarIcon")
            .onAppear { registerOpenSettings(openWindow) }
    }
}

func registerOpenSettings(_ openWindow: OpenWindowAction) {
    AppLifecycle.openSettings = {
        openWindow(id: "settings")
        NSApp.activate()
    }
}

// MARK: - MyJDownloader client (isolated, ephemeral WKWebView session)

@MainActor
final class JDClient: NSObject, ObservableObject {
    struct Device: Identifiable, Hashable { let id: String; let name: String }
    typealias Completion = (Bool, String?) -> Void
    private struct Request {
        let completion: Completion
        let timeout: Task<Void, Never>
    }

    @Published var connecting = false
    @Published var connected = false
    @Published private(set) var accountEmail = ""
    @Published var lastError: String?
    @Published var deviceError: String?
    @Published var devices: [Device] = []
    @Published var selectedDeviceId: String? {
        didSet {
            deviceGeneration += 1
            polling = false
            status = Status()
            deviceError = nil
            poll()
        }
    }
    /// Download controller state as reported by `/polling/poll`.
    struct Status: Equatable {
        var state: String?          // RUNNING, PAUSE, STOPPED_STATE, STOPPING, IDLE
        var speed: Double = 0       // bytes per second
        var eta: Double?            // seconds
        var loaded: Double?
        var total: Double?
    }
    @Published private(set) var status = Status()
    var isDownloading: Bool { status.state == "RUNNING" }
    var isPaused: Bool { status.state == "PAUSE" }
    var selectedDevice: Device? { devices.first { $0.id == selectedDeviceId } }

    // Click'n'Load listener state for the UI.
    @Published private(set) var clickNLoadState: ClickNLoadServer.State = .stopped
    @Published private(set) var lastClickNLoad: String?
    private let clickNLoadServer = ClickNLoadServer()
    private var panelsShowingStatus = 0

    private var webView: WKWebView!
    private var ready = false
    private var nextReqId = 1
    private var pending: [Int: Request] = [:]
    private var pollTask: Task<Void, Never>?
    private var readyTimeout: Task<Void, Never>?
    private var queued: (() -> Void)?
    private var polling = false
    private var deviceGeneration = 0
    private let resourceURL = Bundle.main.bundleURL
        .appendingPathComponent("Contents/PlugIns/MyJDownloader Extension.appex/Contents/Resources")
    private var bridgeURL: URL { resourceURL.appendingPathComponent("vendor/jdclient.html") }

    override init() {
        super.init()
        UserDefaults.standard.register(defaults: ["clickNLoadEnabled": true])
        clickNLoadServer.onStateChange = { [weak self] state in self?.clickNLoadState = state }
        clickNLoadServer.handler = { [weak self] request, respond in
            guard let self else { respond(false, nil); return }
            self.addClickNLoad(request, completion: respond)
        }
        setClickNLoad(enabled: UserDefaults.standard.bool(forKey: "clickNLoadEnabled"))
        loadBridge()
        tryConnectFromKeychain()
    }

    func setClickNLoad(enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: "clickNLoadEnabled")
        if enabled { clickNLoadServer.start() } else { clickNLoadServer.stop() }
    }

    private func loadBridge() {
        ready = false
        readyTimeout?.cancel()
        webView?.stopLoading()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "jd")
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(self, name: "jd")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.loadFileURL(bridgeURL, allowingReadAccessTo: resourceURL)
        readyTimeout = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(15)) } catch { return }
            self?.failBridge("Die Verbindungskomponente konnte nicht geladen werden.")
        }
    }

    private func resetSession() {
        connected = false
        connecting = false
        deviceError = nil
        for request in pending.values { request.timeout.cancel() }
        pending.removeAll()
        queued = nil
        devices = []
        selectedDeviceId = nil
    }

    private func failBridge(_ error: String) {
        readyTimeout?.cancel()
        ready = false
        resetSession()
        lastError = error
    }

    private func send(_ makeJS: (Int) -> String, _ completion: @escaping Completion) {
        guard ready else { completion(false, "Verbindungskomponente ist noch nicht bereit."); return }
        let id = nextReqId
        nextReqId += 1
        let timeout = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(30)) } catch { return }
            self?.finish(id, false, "Zeitüberschreitung bei MyJDownloader.")
        }
        pending[id] = Request(completion: completion, timeout: timeout)
        webView.evaluateJavaScript(makeJS(id)) { [weak self] _, error in
            if let error { self?.finish(id, false, error.localizedDescription) }
        }
    }

    private func finish(_ id: Int, _ ok: Bool, _ data: String?) {
        guard let request = pending.removeValue(forKey: id) else { return }
        request.timeout.cancel()
        request.completion(ok, data)
    }

    func connect(email: String, pass: String, automatically: Bool = false) {
        guard !connecting else { return }
        accountEmail = email
        resetSession()
        lastError = nil
        connecting = true
        if !automatically { UserDefaults.standard.set(true, forKey: "automaticLoginDisabled") }
        // jdapi has module-global state. Each login gets a new web content
        // context so an old handshake cannot restore a logged-out account.
        queued = { [weak self] in
            self?.send({ "window.bridge.connect(\(Self.js(email)), \(Self.js(pass)), \($0))" }) { [weak self] ok, data in
                guard let self else { return }
                self.connecting = false
                self.connected = ok
                if ok {
                    // Automatic login already read these exact credentials.
                    // Writing them back can trigger an unnecessary second
                    // Keychain authorization request.
                    // Exception: an item from an older version is rewritten once
                    // so the Safari extension can share this login.
                    if !automatically || !Keychain.isShared {
                        if let error = Keychain.save(email: email, pass: pass) {
                            self.lastError = error
                        } else {
                            UserDefaults.standard.set(false, forKey: "automaticLoginDisabled")
                        }
                    }
                    self.refreshDevices()
                } else {
                    self.lastError = data
                    // Stop late authentication responses after native timeout.
                    self.webView.evaluateJavaScript("window.bridge.disconnect()", completionHandler: nil)
                    self.loadBridge()
                }
            }
        }
        loadBridge()
    }

    func tryConnectFromKeychain() {
        guard !UserDefaults.standard.bool(forKey: "automaticLoginDisabled") else { return }
        if let credentials = Keychain.load() {
            connect(email: credentials.email, pass: credentials.pass, automatically: true)
        }
    }

    func disconnect() {
        UserDefaults.standard.set(true, forKey: "automaticLoginDisabled")
        webView.evaluateJavaScript("window.bridge.disconnect()", completionHandler: nil)
        resetSession()
        lastError = Keychain.clear()
        // Drop all in-memory cookies/session storage and reject old webview messages.
        loadBridge()
    }

    func refreshDevices() {
        guard connected else { return }
        send({ "window.bridge.listDevices(\($0))" }) { [weak self] ok, data in
            guard let self else { return }
            guard ok, let data, let list = Self.parseDevices(data) else {
                self.lastError = data ?? "Geräteliste konnte nicht geladen werden."
                return
            }
            self.lastError = nil
            self.devices = list
            if !list.contains(where: { $0.id == self.selectedDeviceId }) {
                let remembered = UserDefaults.standard.string(forKey: "selectedDeviceId")
                self.selectedDeviceId = list.first(where: { $0.id == remembered })?.id ?? list.first?.id
            }
            self.poll()
        }
    }

    func selectDevice(_ id: String) {
        UserDefaults.standard.set(id, forKey: "selectedDeviceId")
        selectedDeviceId = id
    }

    /// Status is polled only while a panel shows it; nothing runs in the
    /// background when the menu bar panel is closed.
    func statusPanel(visible: Bool) {
        // A login made in the Safari extension is stored in the shared item;
        // pick it up when the user looks at the app.
        if visible && !connected && !connecting { tryConnectFromKeychain() }
        panelsShowingStatus = max(0, panelsShowingStatus + (visible ? 1 : -1))
        pollTask?.cancel()
        pollTask = nil
        guard panelsShowingStatus > 0 else { return }
        pollTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                self?.poll()
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
            }
        }
    }

    private func poll() {
        guard connected, !polling, let device = selectedDeviceId else { return }
        polling = true
        let generation = deviceGeneration
        deviceCall(device, "/polling/poll", Self.jsonArray([Self.jsonString(["jdState": true, "aggregatedNumbers": true])])) { [weak self] ok, data in
            guard let self, self.connected, self.deviceGeneration == generation else { return }
            self.polling = false
            guard ok, let status = Self.parsePoll(data) else {
                self.status = Status()
                self.deviceError = data ?? "Gerät antwortet nicht."
                return
            }
            self.deviceError = nil
            self.status = status
        }
    }

    func deviceCall(_ deviceId: String, _ action: String, _ params: String = "[]",
                    _ completion: @escaping Completion) {
        send({ "window.bridge.deviceCall(\(Self.js(deviceId)), \(Self.js(action)), \(Self.js(params)), \($0))" }, completion)
    }
    private func control(_ action: String, params: String = "[]", optimisticState: String) {
        guard connected, let device = selectedDeviceId else { return }
        let generation = deviceGeneration
        status.state = optimisticState
        deviceCall(device, action, params) { [weak self] ok, error in
            guard let self, self.connected, self.deviceGeneration == generation else { return }
            self.deviceError = ok ? nil : error
            self.poll()
        }
    }
    /// Start resumes a paused controller; `/downloadcontroller/start` alone
    /// does not lift a pause.
    func start() {
        if isPaused { control("/downloadcontroller/pause", params: "[false]", optimisticState: "RUNNING") }
        else { control("/downloadcontroller/start", optimisticState: "RUNNING") }
    }
    func pause() { control("/downloadcontroller/pause", params: "[true]", optimisticState: "PAUSE") }
    func stop() { control("/downloadcontroller/stop", optimisticState: "STOPPING") }

    // MARK: Click'n'Load delivery

    func addClickNLoad(_ request: ClickNLoadServer.Request, completion: @escaping Completion) {
        let finish: Completion = { [weak self] ok, message in
            self?.lastClickNLoad = ok ? "Zuletzt gesendet: \(Date().formatted(date: .omitted, time: .shortened))"
                                      : "Fehlgeschlagen: \(message ?? "unbekannter Fehler")"
            ClickNLoadNotifier.post(ok: ok, device: self?.selectedDevice?.name, error: message)
            completion(ok, message)
        }
        guard connected else { finish(false, "Die App ist nicht bei MyJDownloader angemeldet."); return }
        guard let device = selectedDeviceId else { finish(false, "Kein JDownloader-Gerät online."); return }
        let fields = request.fields
        let action: String
        let params: [Any]
        if request.path == "/flash/addcrypted" {
            // CNL1 sends a base64 DLC container instead of crypted+jk.
            guard let dlc = fields["crypted"], !dlc.isEmpty else { finish(false, "Leere Click'n'Load-Daten."); return }
            action = "/linkgrabberv2/addContainer"
            params = ["DLC", "data:application/dlc;base64," + dlc]
        } else {
            var query: [String: Any] = ["permission": true]
            if let crypted = fields["crypted"], !crypted.isEmpty {
                // Same packaging as the extension: JDownloader decodes the hex
                // JSON fragment and decrypts crypted/jk itself.
                let json = Data(Self.jsonString(fields).utf8)
                query["links"] = "https://dummycnl.jdownloader.org/#" + json.map { String(format: "%02x", $0) }.joined()
            } else if let links = fields["urls"] ?? fields["links"], !links.isEmpty {
                query["links"] = links
            } else {
                finish(false, "Leere Click'n'Load-Daten.")
                return
            }
            if let source = fields["source"] ?? request.referer { query["sourceUrl"] = source }
            if let package = fields["package"], !package.isEmpty { query["packageName"] = package }
            if let passwords = fields["passwords"], !passwords.isEmpty { query["downloadPassword"] = passwords }
            action = "/linkgrabberv2/addLinks"
            params = [Self.jsonString(query)]
        }
        deviceCall(device, action, Self.jsonArray(params), finish)
    }

    private static func jsonString(_ object: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let string = String(data: data, encoding: .utf8) else { return "{}" }
        return string
    }
    private static func jsonArray(_ values: [Any]) -> String { jsonString(values) }

    private static func js(_ value: String) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let encoded = String(data: data, encoding: .utf8) else { return "\"\"" }
        return encoded
    }
    static func parseDevices(_ json: String) -> [Device]? {
        guard let data = json.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) else { return nil }
        let array: [[String: Any]]?
        if let dictionary = object as? [String: Any] {
            array = (dictionary["devices"] as? [[String: Any]]) ?? (dictionary["list"] as? [[String: Any]])
        } else { array = object as? [[String: Any]] }
        return array?.compactMap {
            guard let id = $0["id"] as? String, let name = $0["name"] as? String else { return nil }
            return Device(id: id, name: name)
        }
    }
    /// `/polling/poll` returns events: `jdState` carries the controller state
    /// string, `aggregatedNumbers` the speed/ETA/byte counters.
    static func parsePoll(_ json: String?) -> Status? {
        guard let json, let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) else { return nil }
        guard let events = ((object as? [String: Any])?["data"] as? [[String: Any]]) ?? (object as? [[String: Any]]) else { return nil }
        func number(_ value: Any?) -> Double? {
            guard let value = (value as? NSNumber)?.doubleValue, value.isFinite, value >= 0 else { return nil }
            return value
        }
        var status = Status()
        for event in events {
            guard let payload = (event["eventData"] as? [String: Any])?["data"] else { continue }
            if let state = payload as? String {
                status.state = state
            } else if let numbers = payload as? [String: Any] {
                status.speed = number(numbers["downloadSpeed"]) ?? 0
                status.eta = number(numbers["eta"])
                status.loaded = number(numbers["loadedBytes"])
                status.total = number(numbers["totalBytes"])
            }
        }
        return status
    }
}

extension JDClient: WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.webView === webView, message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.standardizedFileURL == bridgeURL.standardizedFileURL,
              let body = message.body as? [String: Any], let id = body["reqId"] as? Int else { return }
        let ok = body["ok"] as? Bool ?? false
        let data = body["data"] as? String
        if id == 0 {
            readyTimeout?.cancel()
            guard ok else { failBridge(data ?? "Verbindungskomponente ist nicht verfügbar."); return }
            ready = true
            let action = queued
            queued = nil
            action?()
        } else if id == -1 {
            failBridge(data ?? "Fehler in der Verbindungskomponente.")
        } else {
            finish(id, ok, data)
        }
    }
}

extension JDClient: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let allowed = navigationAction.targetFrame?.isMainFrame == true &&
            navigationAction.request.url?.standardizedFileURL == bridgeURL.standardizedFileURL
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if webView === self.webView { failBridge(error.localizedDescription) }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if webView === self.webView { failBridge(error.localizedDescription) }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView === self.webView { failBridge("Die Verbindung wurde beendet. Bitte erneut anmelden.") }
    }
}

// MARK: - Click'n'Load listener (127.0.0.1:9666, like a local JDownloader)

/// Minimal HTTP/1.1 endpoint for the Click'n'Load routes JDownloader serves.
/// The extension intercepts most requests inside the page; this listener
/// receives everything the page hooks cannot see (script-tag `jdcheck.js`,
/// navigations, popups, frames, strict-CSP pages) or that the extension hands
/// over while it is logged out.
final class ClickNLoadServer {
    enum State: Equatable { case stopped, listening, failed(String) }
    struct Request {
        let method: String
        let path: String
        let fields: [String: String]
        let referer: String?
    }
    typealias Handler = (Request, @escaping (Bool, String?) -> Void) -> Void

    var onStateChange: ((State) -> Void)?
    var handler: Handler?
    private var listener: NWListener?
    private static let port: NWEndpoint.Port = 9666
    private static let maxRequestSize = 4 * 1024 * 1024

    func start() {
        guard listener == nil else { return }
        let parameters = NWParameters.tcp
        // Loopback only: the port must never be reachable from the network.
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: Self.port)
        do {
            let listener = try NWListener(using: parameters)
            listener.newConnectionHandler = { [weak self] connection in
                MainActor.assumeIsolated { self?.accept(connection) }
            }
            listener.stateUpdateHandler = { [weak self] state in
                MainActor.assumeIsolated { self?.update(state) }
            }
            self.listener = listener
            listener.start(queue: .main)
        } catch {
            onStateChange?(.failed(Self.describe(error)))
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
        onStateChange?(.stopped)
    }

    private func update(_ state: NWListener.State) {
        switch state {
        case .ready:
            onStateChange?(.listening)
        case .failed(let error), .waiting(let error):
            listener?.cancel()
            listener = nil
            onStateChange?(.failed(Self.describe(error)))
        default:
            break
        }
    }

    private static func describe(_ error: Error) -> String {
        if case .posix(let code) = error as? NWError, code == .EADDRINUSE {
            return "Port 9666 ist belegt (läuft JDownloader lokal?)."
        }
        return error.localizedDescription
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: .main)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            MainActor.assumeIsolated {
                guard let self else { connection.cancel(); return }
                var buffer = buffer
                if let data { buffer.append(data) }
                switch Self.parse(buffer) {
                case .complete(let request):
                    self.route(request, on: connection)
                case .invalid:
                    self.respond(connection, status: "400 Bad Request", body: "failed\r\n")
                case .incomplete where error != nil || isComplete || buffer.count > Self.maxRequestSize:
                    self.respond(connection, status: "400 Bad Request", body: "failed\r\n")
                case .incomplete:
                    self.receive(connection, buffer: buffer)
                }
            }
        }
    }

    private func route(_ request: Request, on connection: NWConnection) {
        if request.method == "OPTIONS" {
            respond(connection, status: "204 No Content", body: "")
            return
        }
        switch request.path {
        case "/jdcheck.js":
            respond(connection, type: "text/javascript; charset=utf-8", body: "jdownloader=true;\r\nvar version='18507';\r\n")
        case "/crossdomain.xml":
            respond(connection, type: "text/xml; charset=utf-8", body: """
                <?xml version="1.0" ?>
                <cross-domain-policy>
                  <site-control permitted-cross-domain-policies="master-only"/>
                  <allow-access-from domain="*"/>
                  <allow-http-request-headers-from domain="*" headers="*"/>
                </cross-domain-policy>
                """)
        case "/", "/flash", "/flash/":
            respond(connection, body: "JDownloader\r\n")
        case "/flash/add", "/flash/addcrypted", "/flash/addcrypted2":
            guard let handler else {
                respond(connection, status: "503 Service Unavailable", body: "failed\r\n")
                return
            }
            handler(request) { [weak self] ok, _ in
                self?.respond(connection, status: ok ? "200 OK" : "500 Internal Server Error",
                              body: ok ? "success\r\n" : "failed\r\n")
            }
        default:
            respond(connection, status: "404 Not Found", body: "")
        }
    }

    private func respond(_ connection: NWConnection, status: String = "200 OK",
                         type: String = "text/plain; charset=utf-8", body: String) {
        let payload = Data(body.utf8)
        let head = [
            "HTTP/1.1 \(status)",
            "Content-Type: \(type)",
            "Content-Length: \(payload.count)",
            "Connection: close",
            "Cache-Control: no-store",
            "Access-Control-Allow-Origin: *",
            "Access-Control-Allow-Methods: GET, POST, OPTIONS",
            "Access-Control-Allow-Headers: *",
            "Access-Control-Allow-Private-Network: true",
        ].joined(separator: "\r\n") + "\r\n\r\n"
        connection.send(content: Data(head.utf8) + payload, completion: .contentProcessed { _ in connection.cancel() })
    }

    // MARK: HTTP parsing

    private enum Parse { case incomplete, invalid, complete(Request) }

    private static func parse(_ buffer: Data) -> Parse {
        guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else { return .incomplete }
        guard let head = String(data: buffer[..<headerEnd.lowerBound], encoding: .utf8) else { return .invalid }
        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else { return .invalid }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()] =
                line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = Int(headers["content-length"] ?? "0") ?? -1
        guard length >= 0, length <= maxRequestSize else { return .invalid }
        let body = buffer[headerEnd.upperBound...]
        guard body.count >= length else { return .incomplete }
        guard let url = URLComponents(string: "http://127.0.0.1" + requestLine[1]) else { return .invalid }

        var fields: [String: String] = [:]
        for item in url.percentEncodedQueryItems ?? [] {
            fields[decodeFormComponent(item.name)] = decodeFormComponent(item.value ?? "")
        }
        // Explicit body values take precedence over the query string.
        let bodyData = Data(body.prefix(length))
        let contentType = headers["content-type"]?.lowercased() ?? ""
        if contentType.hasPrefix("multipart/form-data"),
           let boundary = headers["content-type"]?.components(separatedBy: "boundary=").last?
               .trimmingCharacters(in: CharacterSet(charactersIn: "\" ")) {
            fields.merge(parseMultipart(bodyData, boundary: boundary)) { $1 }
        } else if contentType.hasPrefix("application/json") {
            let object = (try? JSONSerialization.jsonObject(with: bodyData)) as? [String: Any] ?? [:]
            fields.merge(object.compactMapValues { $0 as? String }) { $1 }
        } else if let text = String(data: bodyData, encoding: .utf8) {
            fields.merge(parseURLEncoded(text)) { $1 }
        }
        return .complete(Request(method: String(requestLine[0]).uppercased(),
                                 path: url.path.lowercased(),
                                 fields: fields,
                                 referer: headers["referer"] ?? headers["origin"]))
    }

    private static func decodeFormComponent(_ value: String) -> String {
        value.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? value
    }

    private static func parseURLEncoded(_ text: String) -> [String: String] {
        var fields: [String: String] = [:]
        for pair in text.split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let name = parts.first, !name.isEmpty else { continue }
            fields[decodeFormComponent(String(name))] = parts.count > 1 ? decodeFormComponent(String(parts[1])) : ""
        }
        return fields
    }

    private static func parseMultipart(_ data: Data, boundary: String) -> [String: String] {
        guard let text = String(data: data, encoding: .utf8) else { return [:] }
        var fields: [String: String] = [:]
        for part in text.components(separatedBy: "--" + boundary) {
            guard let split = part.range(of: "\r\n\r\n") else { continue }
            let partHead = part[..<split.lowerBound]
            guard let nameRange = partHead.range(of: "name=\""),
                  let nameEnd = partHead[nameRange.upperBound...].firstIndex(of: "\"") else { continue }
            var value = String(part[split.upperBound...])
            if value.hasSuffix("\r\n") { value.removeLast(2) }
            fields[String(partHead[nameRange.upperBound..<nameEnd])] = value
        }
        return fields
    }
}

/// Native Click'n'Load gives the page only "success"; a notification tells the
/// user where the links went.
enum ClickNLoadNotifier {
    static func post(ok: Bool, device: String?, error: String?) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = ok ? "Links an JDownloader gesendet" : "Click'n'Load fehlgeschlagen"
            content.body = ok ? "Gerät: \(device ?? "JDownloader")" : (error ?? "Unbekannter Fehler")
            center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }
}

// MARK: - Keychain (app-local credentials)

enum Keychain {
    struct Creds { let email: String; let pass: String }
    private static let service = "org.myjdownloader.MyJDownloader"
    private static let account = "myjd-credentials"

    static func save(email: String, pass: String) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: ["email": email, "pass": pass]) else {
            return "Anmeldedaten konnten nicht gespeichert werden."
        }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                   kSecAttrService as String: service, kSecAttrAccount as String: account]
        // An item's access list cannot be changed by SecItemUpdate, so the
        // item is recreated with one that also trusts the Safari extension.
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        if let access = sharedAccess() { attributes[kSecAttrAccess as String] = access }
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecSuccess { UserDefaults.standard.set(true, forKey: sharedFlag) }
        return status == errSecSuccess ? nil : "Schlüsselbund: " + errorMessage(status)
    }

    /// True once the item carries the access list shared with the extension.
    static var isShared: Bool { UserDefaults.standard.bool(forKey: sharedFlag) }
    private static let sharedFlag = "keychainSharedWithExtension"

    /// One login for app and extension: the extension's native handler reads
    /// (and writes) this item, so both bundles must be on its access list.
    private static func sharedAccess() -> SecAccess? {
        let app = Bundle.main.bundleURL
        let appex = app.appendingPathComponent("Contents/PlugIns/MyJDownloader Extension.appex")
        var trusted: [SecTrustedApplication] = []
        for url in [app, appex] {
            var application: SecTrustedApplication?
            if SecTrustedApplicationCreateFromPath(url.path, &application) == errSecSuccess, let application {
                trusted.append(application)
            }
        }
        var access: SecAccess?
        guard SecAccessCreate("MyJDownloader" as CFString, trusted as CFArray, &access) == errSecSuccess else { return nil }
        return access
    }
    private static func errorMessage(_ status: OSStatus) -> String {
        (SecCopyErrorMessageString(status, nil) as String?) ?? "Fehler \(status)"
    }
    static func load() -> Creds? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service, kSecAttrAccount as String: account,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let email = obj["email"], let pass = obj["pass"] else { return nil }
        return Creds(email: email, pass: pass)
    }
    static func clear() -> String? {
        let status = SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service,
                                    kSecAttrAccount as String: account] as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound ? nil : "Schlüsselbund: " + errorMessage(status)
    }
}

// MARK: - Menu bar panel

struct MenuBarView: View {
    @ObservedObject var jd: JDClient
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header

            if jd.connected {
                Text(speedText)
                    .font(.system(.title3, design: .rounded).weight(.semibold))
                    .monospacedDigit()
                Text(statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let progress {
                    ProgressView(value: progress).controlSize(.small)
                }

                Divider()

                HStack(spacing: 24) {
                    Spacer()
                    control("play.fill", jd.isPaused ? "Fortsetzen" : "Start", disabled: jd.isDownloading) { jd.start() }
                    control("pause.fill", "Pause", disabled: !jd.isDownloading) { jd.pause() }
                    control("stop.fill", "Stopp", disabled: !(jd.isDownloading || jd.isPaused)) { jd.stop() }
                    Spacer()
                }
                .font(.title2)
                .disabled(jd.selectedDeviceId == nil)
            } else {
                Text(jd.connecting ? "Verbinde…" : "Die Menüleisten-App ist nicht angemeldet.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                if !jd.connecting {
                    Button("Anmelden…") { showSettings() }
                }
            }

            if let error = jd.deviceError ?? jd.lastError {
                Text(error).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }

            Divider()

            ClickNLoadStatusView(jd: jd)

            Divider()

            HStack {
                Button("Einstellungen…") { showSettings() }
                Spacer()
                Button("Beenden") { NSApplication.shared.terminate(nil) }
            }
        }
        .controlSize(.small)
        .padding(12)
        .frame(width: 280)
        .onAppear { jd.statusPanel(visible: true) }
        .onDisappear { jd.statusPanel(visible: false) }
    }

    private func showSettings() {
        openWindow(id: "settings")
        NSApp.activate()
    }

    @ViewBuilder private var header: some View {
        if jd.devices.count > 1 {
            Menu {
                ForEach(jd.devices) { d in
                    Button { jd.selectDevice(d.id) } label: {
                        if d.id == jd.selectedDeviceId { Label(d.name, systemImage: "checkmark") } else { Text(d.name) }
                    }
                }
            } label: {
                Text(jd.selectedDevice?.name ?? "Gerät wählen").font(.headline)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        } else {
            Text(jd.selectedDevice?.name ?? (jd.connected ? "Kein Gerät online" : "MyJDownloader"))
                .font(.headline)
        }
    }

    private var speedText: String {
        guard jd.isDownloading else { return "—" }
        return Self.bytes(jd.status.speed) + "/s"
    }

    private var progress: Double? {
        guard let loaded = jd.status.loaded, let total = jd.status.total, total > 0,
              jd.isDownloading || jd.isPaused else { return nil }
        return min(1, loaded / total)
    }

    private var statusText: String {
        guard jd.selectedDeviceId != nil else { return "Kein JDownloader online" }
        var parts: [String]
        switch jd.status.state {
        case "RUNNING": parts = ["Lädt"]
        case "PAUSE": parts = ["Pausiert"]
        case "STOPPING": parts = ["Stoppt…"]
        case nil: parts = ["Status wird geladen…"]
        default: parts = ["Bereit"]
        }
        if let loaded = jd.status.loaded, let total = jd.status.total, total > 0, jd.isDownloading || jd.isPaused {
            parts.append("\(Self.bytes(loaded)) von \(Self.bytes(total))")
        }
        if jd.isDownloading, let eta = jd.status.eta, eta > 0 {
            let formatter = DateComponentsFormatter()
            formatter.unitsStyle = .abbreviated
            formatter.maximumUnitCount = 2
            if let text = formatter.string(from: eta) { parts.append("noch \(text)") }
        }
        return parts.joined(separator: " · ")
    }

    static func bytes(_ value: Double) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .decimal
        return formatter.string(fromByteCount: Int64(min(Double(Int64.max / 2), max(0, value))))
    }

    private func control(_ symbol: String, _ help: String, disabled: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol) }
            .buttonStyle(.borderless)
            .help(help)
            .disabled(disabled)
    }
}

struct ClickNLoadStatusView: View {
    @ObservedObject var jd: JDClient

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Circle().fill(color).frame(width: 7, height: 7)
                Text("Click'n'Load: " + title).font(.caption)
            }
            if let detail {
                Text(detail).font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var title: String {
        switch jd.clickNLoadState {
        case .stopped: return "aus"
        case .failed: return "nicht verfügbar"
        case .listening: return jd.connected && jd.selectedDeviceId != nil ? "bereit" : "wartet auf Anmeldung"
        }
    }
    private var color: Color {
        switch jd.clickNLoadState {
        case .stopped: return .secondary
        case .failed: return .orange
        case .listening: return jd.connected && jd.selectedDeviceId != nil ? .green : .orange
        }
    }
    private var detail: String? {
        if case .failed(let reason) = jd.clickNLoadState { return reason }
        return jd.lastClickNLoad
    }
}

// MARK: - Settings window

struct SettingsView: View {
    @ObservedObject var jd: JDClient
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(\.openWindow) private var openWindow
    @AppStorage("menuBarEnabled") private var menuBarEnabled = true
    @AppStorage("clickNLoadEnabled") private var clickNLoadEnabled = true
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
    @State private var loginItemError: String?
    @State private var extensionEnabled: Bool?
    @State private var extensionError: String?
    @State private var email = ""
    @State private var password = ""
    /// The window opens with every app launch. At a login-item launch with a
    /// saved account the menu bar is all the user needs, so close it then.
    private static var launchHandled = false

    var body: some View {
        Form {
            Section("MyJDownloader-Konto") {
                if jd.connected {
                    LabeledContent("Angemeldet als") { Text(jd.accountEmail) }
                    if jd.devices.isEmpty {
                        LabeledContent("Gerät") { Text("kein JDownloader online").foregroundStyle(.secondary) }
                    } else {
                        Picker("Gerät", selection: Binding(
                            get: { jd.selectedDeviceId ?? "" },
                            set: { jd.selectDevice($0) })) {
                            ForEach(jd.devices) { Text($0.name).tag($0.id) }
                        }
                    }
                    HStack {
                        Button("Geräte aktualisieren") { jd.refreshDevices() }
                        Spacer()
                        Button("Abmelden") { jd.disconnect() }
                    }
                } else {
                    TextField("E-Mail", text: $email)
                        .textContentType(.username)
                    SecureField("Passwort", text: $password)
                        .textContentType(.password)
                        .onSubmit(login)
                    Button(jd.connecting ? "Verbinde…" : "Anmelden", action: login)
                        .keyboardShortcut(.defaultAction)
                        .disabled(jd.connecting || email.isEmpty || password.isEmpty)
                }
                if let error = jd.lastError {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            }

            Section {
                Toggle("Click'n'Load über Port 9666 annehmen", isOn: $clickNLoadEnabled)
                    .onChange(of: clickNLoadEnabled) { _, on in jd.setClickNLoad(enabled: on) }
                ClickNLoadStatusView(jd: jd)
            } header: {
                Text("Click'n'Load")
            } footer: {
                Text("Fängt Click'n'Load ab, das die Safari-Erweiterung nicht sieht, und sendet es an das oben gewählte Gerät. Dafür muss die App laufen.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("App") {
                Toggle("Menüleisten-Symbol anzeigen", isOn: $menuBarEnabled)
                Toggle("Beim Anmelden am Mac starten", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, on in setLoginItem(on) }
                if let error = loginItemError { Text(error).font(.caption).foregroundStyle(.red) }
            }

            Section {
                LabeledContent("Status") {
                    switch extensionEnabled {
                    case .some(true):  Text("aktiviert").foregroundStyle(.green)
                    case .some(false): Text("deaktiviert").foregroundStyle(.orange)
                    case .none:        Text("unbekannt").foregroundStyle(.secondary)
                    }
                }
                Button("Safari-Einstellungen öffnen…") {
                    SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
                        DispatchQueue.main.async { extensionError = error?.localizedDescription }
                    }
                }
                if let extensionError { Text(extensionError).font(.caption).foregroundStyle(.red) }
            } header: {
                Text("Safari-Erweiterung")
            } footer: {
                Text("Die Erweiterung hat eine eigene Anmeldung im Safari-Symbolleistenmenü.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(minWidth: 460, idealWidth: 480, minHeight: 440, idealHeight: 560)
        .onChange(of: jd.connected) { _, connected in
            if connected { password = "" }
        }
        .onAppear {
            // Without a menu bar icon this window provides the reopen action.
            registerOpenSettings(openWindow)
            refreshExtensionState()
            // Opening the window must not read the saved password just to
            // display an email address. The client retains it in memory.
            if email.isEmpty { email = jd.accountEmail }
            if !Self.launchHandled {
                Self.launchHandled = true
                if menuBarEnabled && (jd.connecting || jd.connected) { dismissWindow(id: "settings") }
            }
        }
        // Reflect changes made in Safari's settings when the user comes back.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            refreshExtensionState()
            launchAtLogin = SMAppService.mainApp.status == .enabled
        }
    }

    private func login() {
        guard !jd.connecting, !email.isEmpty, !password.isEmpty else { return }
        jd.connect(email: email, pass: password)
    }

    private func setLoginItem(_ enabled: Bool) {
        do {
            loginItemError = nil
            if enabled {
                if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() }
            } else {
                if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            }
        } catch {
            loginItemError = error.localizedDescription
            launchAtLogin = SMAppService.mainApp.status == .enabled
        }
    }

    private func refreshExtensionState() {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { state, _ in
            DispatchQueue.main.async { extensionEnabled = state?.isEnabled }
        }
    }
}
