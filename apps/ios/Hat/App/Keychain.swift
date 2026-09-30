import Foundation
import HatKit
import Security

/// The connection lives in the keychain because it holds `HAT_AUTH_TOKEN`: a
/// bearer token in a plist is a bearer token in the iCloud backup. It is one
/// item, so the URL and the token can never be written out of step.
enum Keychain {
    private static let service = "chat.t3code.hat"
    private static let account = "hat.connection"

    private static var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    static func loadConfig() -> HatConfig? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return try? JSONDecoder().decode(HatConfig.self, from: data)
    }

    static func saveConfig(_ config: HatConfig) {
        guard let data = try? JSONEncoder().encode(config) else { return }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            // Readable once the device has been unlocked after boot, and never
            // migrated to another device through a backup.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        if SecItemUpdate(query as CFDictionary, attributes as CFDictionary) == errSecItemNotFound {
            SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        }
    }

    static func deleteConfig() {
        SecItemDelete(query as CFDictionary)
    }
}
