import Foundation
import CryptoKit

public struct ClientQuickMessage: Codable, Equatable, Identifiable, Sendable {
    public static let maximumRecommendations = 8
    public let id: String
    public let text: String
    public let scope: String
    public let count: Int

    public init(id: String, text: String, scope: String, count: Int) {
        self.id = id; self.text = text; self.scope = scope; self.count = count
    }

    public static let defaults: [Self] = ["继续", "开始开发", "给我一个完整方案"].map {
        Self(id: "default:\($0)", text: $0, scope: "default", count: 0)
    }
}

/// A small, non-observed last-good snapshot, isolated by host and Task. Reads
/// use bounded snapshots rather than transcript scans or per-chip observation.
@MainActor
public final class ClientQuickMessageCache {
    public static let shared = ClientQuickMessageCache()
    private let defaults: UserDefaults
    private let maximumScopes: Int
    private let indexKey = "quickMessageSnapshots.v1.index"
    private var keys: [String]
    private var resident: [String: [ClientQuickMessage]] = [:]

    public init(defaults: UserDefaults = .standard, maximumScopes: Int = 128) {
        self.defaults = defaults
        self.maximumScopes = max(1, maximumScopes)
        keys = defaults.stringArray(forKey: indexKey) ?? []
        while keys.count > self.maximumScopes {
            defaults.removeObject(forKey: keys.removeFirst())
        }
    }

    public static func scope(host: String, taskID: String?, sessionID: String) -> String {
        let identity = [host, taskID == nil ? "session" : "task", taskID ?? sessionID]
        let encoded = (try? JSONEncoder().encode(identity)) ?? Data()
        return "quickMessageSnapshots.v1." + SHA256.hash(data: encoded).map { String(format: "%02x", $0) }.joined()
    }

    public func items(for scope: String) -> [ClientQuickMessage] {
        if let items = resident[scope] { return items }
        guard keys.contains(scope), let data = defaults.data(forKey: scope),
              let items = try? JSONDecoder().decode([ClientQuickMessage].self, from: data) else {
            return ClientQuickMessage.defaults
        }
        let normalized = Self.normalized(items)
        resident[scope] = normalized
        return normalized
    }

    @discardableResult
    public func remember(_ items: [ClientQuickMessage], for scope: String) -> [ClientQuickMessage] {
        // A successful refresh replaces the snapshot. Network failures never
        // call this method, so they still retain the last good recommendations.
        let normalized = Self.normalized(items)
        let changed = resident[scope] != normalized
        resident[scope] = normalized
        if changed, let data = try? JSONEncoder().encode(normalized) { defaults.set(data, forKey: scope) }
        keys.removeAll { $0 == scope }
        keys.append(scope)
        while keys.count > maximumScopes {
            let evicted = keys.removeFirst()
            resident.removeValue(forKey: evicted)
            defaults.removeObject(forKey: evicted)
        }
        defaults.set(keys, forKey: indexKey)
        return normalized
    }

    private static func normalized(_ items: [ClientQuickMessage]) -> [ClientQuickMessage] {
        var seen = Set<String>()
        let learned = items.filter { item in
            item.scope != "default" && !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && seen.insert(item.text.lowercased()).inserted
        }
        var result = Array(learned.prefix(ClientQuickMessage.maximumRecommendations))
        for item in ClientQuickMessage.defaults where result.count < ClientQuickMessage.maximumRecommendations {
            if seen.insert(item.text.lowercased()).inserted { result.append(item) }
        }
        return result
    }
}

public struct ClientQuickMessageRecommendations: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let taskId: String?
    public let items: [ClientQuickMessage]
}
