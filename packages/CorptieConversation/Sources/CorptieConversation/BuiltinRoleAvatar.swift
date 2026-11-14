import Foundation

/// Versioned, Provider-neutral references. Shared with backend builtinRoleAvatar.mjs.
/// Uploaded avatars keep their existing file paths; this scheme is never a file URL.
public enum BuiltinRoleAvatarCatalog {
    public static let prefix = "corptie-role-avatar://v1/"
    public static let ids = [
        "anime-girl", "ceramic-robot", "elderly-man", "cartoon-dog", "ink-boy", "pixel-robot"
    ]
    // Preserve stored references from the original 16-entry preview library.
    // Aliases affect display only; uploads and database values stay untouched.
    private static let legacyIDs = Dictionary(uniqueKeysWithValues: (1...16).map {
        (String(format: "robot-%02d", $0), ids[($0 - 1) % ids.count])
    })

    public static func id(from reference: String?) -> String? {
        guard let reference, reference.hasPrefix(prefix) else { return nil }
        let id = String(reference.dropFirst(prefix.count))
        return ids.contains(id) ? id : legacyIDs[id]
    }

    public static func reference(for id: String) -> String { prefix + id }

    public static func defaultReference(roleID: String) -> String {
        var hash: UInt32 = 2_166_136_261
        for byte in roleID.utf8 { hash = (hash ^ UInt32(byte)) &* 16_777_619 }
        return reference(for: ids[Int(hash % UInt32(ids.count))])
    }

    public static func randomReference() -> String { reference(for: ids.randomElement()!) }
}
