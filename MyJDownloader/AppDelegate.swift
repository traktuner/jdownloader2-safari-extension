//
//  AppDelegate.swift  (SwiftUI App entry for MyJDownloader)
//
//  Native menu bar companion to the Safari extension.
//  MyJD data uses the bundled API in an ephemeral WKWebView. Native credentials
//  live in Keychain; Safari maintains its own independent login.
//

import SwiftUI
import Combine
import WebKit
import ServiceManagement
import SafariServices
import Security

@main
struct MyJDownloaderApp: App {
    @StateObject private var jd = JDClient()
    @AppStorage("menuBarEnabled") private var menuBarEnabled = true

    var body: some Scene {
        // The primary window provides setup and remains reachable from Finder
        // even when the optional menu bar icon has been disabled.
        Window("MyJDownloader", id: "settings") {
            SettingsView(jd: jd)
        }
        .defaultSize(width: 480, height: 480)

        MenuBarExtra("MyJDownloader", image: "MenuBarIcon", isInserted: $menuBarEnabled) {
            MenuBarView(jd: jd)
        }
        .menuBarExtraStyle(.window)
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
    @Published var lastError: String?
    @Published var deviceError: String?
    @Published var devices: [Device] = []
    @Published var selectedDeviceId: String? {
        didSet {
            deviceGeneration += 1
            polling = false
            speedBytesPerSec = 0
            isDownloading = false
            poll()
        }
    }
    @Published var speedBytesPerSec: Double = 0
    @Published var isDownloading = false
    var selectedDevice: Device? { devices.first { $0.id == selectedDeviceId } }

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
        loadBridge()
        tryConnectFromKeychain()
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
        pollTask?.cancel()
        pollTask = nil
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
                    if let error = Keychain.save(email: email, pass: pass) {
                        self.lastError = error
                    } else {
                        UserDefaults.standard.set(false, forKey: "automaticLoginDisabled")
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
            self.devices = list
            if !list.contains(where: { $0.id == self.selectedDeviceId }) { self.selectedDeviceId = list.first?.id }
            self.pollTask?.cancel()
            self.pollTask = Task { @MainActor [weak self] in
                while !Task.isCancelled {
                    self?.poll()
                    do { try await Task.sleep(for: .seconds(2)) } catch { return }
                }
            }
        }
    }

    private func poll() {
        guard connected, !polling, let device = selectedDeviceId else { return }
        polling = true
        let generation = deviceGeneration
        deviceCall(device, "/downloadcontroller/getSpeedInBps") { [weak self] ok, data in
            guard let self, self.connected, self.deviceGeneration == generation else { return }
            self.polling = false
            guard ok, let speed = Self.parseNumber(data), speed.isFinite, speed >= 0 else {
                self.speedBytesPerSec = 0
                self.isDownloading = false
                self.deviceError = data ?? "Gerät antwortet nicht."
                return
            }
            self.deviceError = nil
            self.speedBytesPerSec = speed
            self.isDownloading = speed > 0
        }
    }

    func deviceCall(_ deviceId: String, _ action: String, _ params: String = "[]",
                    _ completion: @escaping Completion) {
        send({ "window.bridge.deviceCall(\(Self.js(deviceId)), \(Self.js(action)), \(Self.js(params)), \($0))" }, completion)
    }
    private func control(_ action: String, params: String = "[]") {
        guard connected, let device = selectedDeviceId else { return }
        let generation = deviceGeneration
        deviceCall(device, action, params) { [weak self] ok, error in
            guard let self, self.connected, self.deviceGeneration == generation else { return }
            self.deviceError = ok ? nil : error
            self.poll()
        }
    }
    func start() { control("/downloadcontroller/start") }
    func pause() { control("/downloadcontroller/pause", params: "[true]") }
    func stop() { control("/downloadcontroller/stop") }

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
    static func parseNumber(_ string: String?) -> Double? {
        guard let string else { return nil }
        if let value = Double(string) { return value }
        guard let data = string.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed) else { return nil }
        if let number = object as? NSNumber { return number.doubleValue }
        return ((object as? [String: Any])?["data"] as? NSNumber)?.doubleValue
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
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var attributes = query
            attributes[kSecValueData as String] = data
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
            status = SecItemAdd(attributes as CFDictionary, nil)
        }
        return status == errSecSuccess ? nil : "Schlüsselbund: " + errorMessage(status)
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
    @AppStorage("launchAtLogin") private var launchAtLogin = false
    @State private var loginItemError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header

            Text(speedText)
                .font(.system(.title3, design: .rounded).weight(.semibold))
                .monospacedDigit()
            Text(statusText)
                .font(.caption)
                .foregroundStyle(.secondary)

            Divider()

            HStack(spacing: 24) {
                Spacer()
                control("play.fill", "Start") { jd.start() }
                control("pause.fill", "Pause") { jd.pause() }
                control("stop.fill", "Stopp") { jd.stop() }
                Spacer()
            }
            .font(.title2)
            .disabled(!jd.connected || jd.selectedDeviceId == nil)

            Divider()

            Toggle("Beim Anmelden starten", isOn: $launchAtLogin)
                .onChange(of: launchAtLogin) { _, on in setLoginItem(on) }
                .frame(maxWidth: .infinity)
            if let error = loginItemError { Text(error).font(.caption).foregroundStyle(.red) }
            if let error = jd.deviceError ?? jd.lastError { Text(error).font(.caption).foregroundStyle(.red) }

            Divider()

            HStack {
                Button("Einstellungen…") {
                    NSApp.activate(ignoringOtherApps: true)
                    openWindow(id: "settings")
                }
                Spacer()
                Button("Beenden") { NSApplication.shared.terminate(nil) }
            }
            .controlSize(.small)
        }
        .toggleStyle(.switch)
        .controlSize(.small)
        .padding(12)
        .frame(width: 260)
        .onAppear { launchAtLogin = (SMAppService.mainApp.status == .enabled) }
    }

    @ViewBuilder private var header: some View {
        if jd.devices.count > 1 {
            Menu {
                ForEach(jd.devices) { d in Button(d.name) { jd.selectedDeviceId = d.id } }
            } label: {
                HStack(spacing: 4) {
                    Text(jd.selectedDevice?.name ?? "Gerät").font(.headline)
                    Image(systemName: "chevron.down").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        } else {
            Text(jd.selectedDevice?.name ?? (jd.connected ? "Kein Gerät" : "Nicht verbunden"))
                .font(.headline)
        }
    }

    private var speedText: String {
        guard jd.connected else { return "—" }
        let f = ByteCountFormatter()
        f.countStyle = .decimal
        f.allowsNonnumericFormatting = false
        return f.string(fromByteCount: Int64(min(Double(Int64.max / 2), max(0, jd.speedBytesPerSec)))) + "/s"
    }

    private var statusText: String {
        if jd.connecting { return "Verbinde…" }
        if !jd.connected { return "Nicht verbunden" }
        return jd.isDownloading ? "Lädt" : "Bereit"
    }

    private func control(_ symbol: String, _ help: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol) }
            .buttonStyle(.borderless)
            .help(help)
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
            launchAtLogin = (SMAppService.mainApp.status == .enabled)
        }
    }
}

// MARK: - Settings window

struct SettingsView: View {
    @ObservedObject var jd: JDClient
    @AppStorage("menuBarEnabled") private var menuBarEnabled = true
    @State private var extensionEnabled: Bool?
    @State private var email = ""
    @State private var password = ""

    var body: some View {
        Form {
            Section("MyJDownloader-Konto") {
                if jd.connected {
                    LabeledContent("Status") { Text("verbunden").foregroundStyle(.green) }
                    Button("Geräte aktualisieren") { jd.refreshDevices() }
                    Button("Abmelden") { jd.disconnect() }
                    if let error = jd.lastError {
                        Text(error).font(.caption).foregroundStyle(.red)
                    }
                } else {
                    TextField("E-Mail", text: $email)
                    SecureField("Passwort", text: $password)
                    Button(jd.connecting ? "Verbinde…" : "Verbinden") {
                        jd.connect(email: email, pass: password)
                    }
                    .disabled(jd.connecting || email.isEmpty || password.isEmpty)
                    if let e = jd.lastError {
                        Text(e).font(.caption).foregroundStyle(.red)
                    }
                }
            }

            Section {
                Toggle("Menüleisten-App aktivieren", isOn: $menuBarEnabled)
            }

            Section("Safari-Erweiterung") {
                LabeledContent("Status") {
                    switch extensionEnabled {
                    case .some(true):  Text("aktiviert").foregroundStyle(.green)
                    case .some(false): Text("deaktiviert").foregroundStyle(.secondary)
                    case .none:        Text("unbekannt").foregroundStyle(.secondary)
                    }
                }
                Button("In Safari aktivieren…") {
                    SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in }
                }
            }
        }
        .formStyle(.grouped)
        .frame(minWidth: 460, idealWidth: 480, minHeight: 440, idealHeight: 480)
        .fixedSize(horizontal: false, vertical: true)
        .onChange(of: jd.connected) { _, connected in
            if connected { password = "" }
        }
        .onAppear {
            refreshExtensionState()
            if let c = Keychain.load() { email = c.email }
        }
    }

    private func refreshExtensionState() {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { state, _ in
            DispatchQueue.main.async { extensionEnabled = state?.isEnabled }
        }
    }
}
