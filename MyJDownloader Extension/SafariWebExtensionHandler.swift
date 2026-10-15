//
//  SafariWebExtensionHandler.swift
//  MyJDownloader Extension
//
//  Native side of the extension: shares one MyJDownloader login with the
//  menu bar app through the login keychain, so the user logs in only once.
//

import SafariServices
import Security
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private let log = OSLog(subsystem: "org.myjdownloader.MyJDownloader.Extension", category: "login")

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey] as? [String: Any]
        var reply: [String: Any] = [:]

        switch message?["action"] as? String {
        case "get-credentials":
            let (credentials, status) = SharedCredentials.load()
            if let credentials {
                reply = ["email": credentials.email, "password": credentials.pass]
            } else {
                os_log(.default, log: log, "Shared login unavailable: %{public}d", status)
                reply = ["error": status == errSecItemNotFound ? "none" : "keychain \(status)"]
            }
        case "store-credentials":
            let email = message?["email"] as? String ?? ""
            let pass = message?["password"] as? String ?? ""
            let status = email.isEmpty || pass.isEmpty ? errSecParam : SharedCredentials.save(email: email, pass: pass)
            if status != errSecSuccess { os_log(.default, log: log, "Storing shared login failed: %{public}d", status) }
            reply = status == errSecSuccess ? ["ok": true] : ["error": "keychain \(status)"]
        case "app-version":
            reply = ["version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""]
        default:
            reply = ["error": "unknown action"]
        }

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: reply]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}

/// Same item as the menu bar app's `Keychain` (service/account/JSON layout).
/// Its access list trusts both the app and this extension.
enum SharedCredentials {
    struct Credentials { let email: String; let pass: String }
    private static let service = "org.myjdownloader.MyJDownloader"
    private static let account = "myjd-credentials"

    static func load() -> (Credentials?, OSStatus) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service, kSecAttrAccount as String: account,
                                    kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess else { return (nil, status) }
        guard let data = item as? Data,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let email = object["email"], let pass = object["pass"] else { return (nil, errSecDecode) }
        return (Credentials(email: email, pass: pass), errSecSuccess)
    }

    static func save(email: String, pass: String) -> OSStatus {
        guard let data = try? JSONSerialization.data(withJSONObject: ["email": email, "pass": pass]) else { return errSecParam }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        if let access = sharedAccess() { attributes[kSecAttrAccess as String] = access }
        return SecItemAdd(attributes as CFDictionary, nil)
    }

    /// …/MyJDownloader.app/Contents/PlugIns/MyJDownloader Extension.appex
    private static func sharedAccess() -> SecAccess? {
        let appex = Bundle.main.bundleURL
        let app = appex.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
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
}
