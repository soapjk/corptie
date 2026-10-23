#if os(macOS)
import Foundation
import CryptoKit
import CorptieClientCore

/// Permission-protected local secrets. These files do not isolate programs
/// running as the same OS user. iOS continues to use its platform vault.
public actor MacAppCredentialStore {
    private struct CloudEntry: Codable {
        var generation: Int
        var credential: CloudCredential?
    }
    private struct Envelope: Codable {
        var schemaVersion = 1
        var revision = 0
        let environmentId: String
        var cloud: [String: CloudEntry] = [:]
        var cacheKeys: [String: Data] = [:]
        var migration: [String: String] = [:]
    }
    public struct CloudState: Sendable {
        public let credential: CloudCredential?
        public let generation: Int?
    }
    private let file: PrivateCredentialFile
    private let environmentId: String
    public init(directory: URL, environmentId: String) {
        file = PrivateCredentialFile(directory: directory, name: "app-credentials.v1.json", maximumBytes: 1024 * 1024)
        self.environmentId = environmentId
    }
    private func account(_ configuration: CloudOAuthConfiguration) throws -> String {
        guard let host = configuration.endpoint.baseURL.host?.lowercased(),
              let scheme = configuration.endpoint.baseURL.scheme else { throw LocalCredentialError.corrupt }
        let port = configuration.endpoint.baseURL.port ?? (scheme == "https" ? 443 : 80)
        return SHA256.hash(data: Data("\(scheme)://\(host):\(port)|\(configuration.clientID)".utf8))
            .map { String(format: "%02x", $0) }.joined()
    }
    private func validate(_ value: CloudCredential) throws {
        guard value.identity.kind == .mac, value.identity.privateKey.count == 32, !value.identity.displayName.isEmpty,
              value.identity.displayName.count <= 80, !value.tokens.accessToken.isEmpty,
              value.tokens.accessToken.utf8.count < 256 * 1024,
              (value.tokens.refreshToken?.utf8.count ?? 0) < 256 * 1024 else { throw LocalCredentialError.corrupt }
    }
    private func decode(_ data: Data?) throws -> Envelope {
        guard let data else { return Envelope(environmentId: environmentId) }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: text) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            guard let date = formatter.date(from: text) else { throw LocalCredentialError.corrupt }
            return date
        }
        let snapshot: Envelope
        do { snapshot = try decoder.decode(Envelope.self, from: data) }
        catch { throw LocalCredentialError.corrupt }
        guard snapshot.schemaVersion == 1 else { throw LocalCredentialError.unsupportedVersion }
        guard snapshot.environmentId == environmentId, snapshot.revision >= 0,
              snapshot.revision < 9_007_199_254_740_991,
              snapshot.cacheKeys.values.allSatisfy({ $0.count == 32 }) else { throw LocalCredentialError.corrupt }
        for entry in snapshot.cloud.values {
            guard entry.generation > 0, entry.generation < 9_007_199_254_740_990 else { throw LocalCredentialError.corrupt }
            if let credential = entry.credential { try validate(credential) }
        }
        return snapshot
    }
    private func read<T>(_ operation: (Envelope) throws -> T) throws -> T {
        try file.access { root in try operation(decode(file.read(at: root))) }
    }
    private func update<T>(_ operation: (inout Envelope) throws -> T) throws -> T {
        try file.access { root in
            var snapshot = try decode(file.read(at: root))
            let value = try operation(&snapshot)
            snapshot.revision += 1
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .custom { date, encoder in
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                var value = encoder.singleValueContainer()
                try value.encode(formatter.string(from: date))
            }
            encoder.outputFormatting = [.sortedKeys]
            try file.write(encoder.encode(snapshot), at: root)
            return value
        }
    }
    public func state(configuration: CloudOAuthConfiguration) throws -> CloudState {
        let key = try account(configuration)
        return try read { .init(credential: $0.cloud[key]?.credential, generation: $0.cloud[key]?.generation) }
    }
    @discardableResult
    public func save(_ credential: CloudCredential, configuration: CloudOAuthConfiguration,
                     expectedGeneration: Int?) throws -> Int {
        try validate(credential)
        let key = try account(configuration)
        return try update {
            guard $0.cloud[key]?.generation == expectedGeneration else { throw LocalCredentialError.conflict }
            let generation = (expectedGeneration ?? 0) + 1
            $0.cloud[key] = .init(generation: generation, credential: credential)
            return generation
        }
    }
    public func remove(configuration: CloudOAuthConfiguration) throws {
        let key = try account(configuration)
        try update {
            $0.cloud[key] = .init(generation: ($0.cloud[key]?.generation ?? 0) + 1, credential: nil)
        }
    }
    public func cacheKey(purpose: String, legacyDirectories: [URL]) throws -> SymmetricKey {
        guard ["detail-action-recovery", "message-outbox", "timeline-cache"].contains(purpose) else {
            throw LocalCredentialError.corrupt
        }
        if let data = try read({ $0.cacheKeys[purpose] }) { return SymmetricKey(data: data) }
        // All consumers are inventoried, including journal-only installations.
        for directory in legacyDirectories where FileManager.default.fileExists(atPath: directory.path) {
            let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            if files.contains(where: { ["sealed", "state", "ack", "pending"].contains($0.pathExtension) }) {
                throw LocalCredentialError.migrationRequired
            }
        }
        return try update {
            if let data = $0.cacheKeys[purpose] { return SymmetricKey(data: data) }
            let key = SymmetricKey(size: .bits256)
            $0.cacheKeys[purpose] = key.withUnsafeBytes { Data($0) }
            return key
        }
    }
    /// Explicit migration only. Never overwrite a new login or another key.
    public func importCloud(_ credential: CloudCredential, configuration: CloudOAuthConfiguration) throws {
        try validate(credential)
        let key = try account(configuration)
        try update {
            if let existing = $0.cloud[key] {
                guard let old = existing.credential, old.identity == credential.identity,
                      old.tokens.accessToken == credential.tokens.accessToken,
                      old.tokens.refreshToken == credential.tokens.refreshToken,
                      old.tokens.scope == credential.tokens.scope,
                      old.tokens.tokenType == credential.tokens.tokenType,
                      abs(old.tokens.expiresAt.timeIntervalSince(credential.tokens.expiresAt)) < 0.001 else {
                    throw LocalCredentialError.conflict
                }
            } else { $0.cloud[key] = .init(generation: 1, credential: credential) }
            $0.migration["cloud:" + key] = "imported"
        }
    }
    public func importCacheKey(_ data: Data, purposes: [String]) throws {
        guard data.count == 32, !purposes.isEmpty,
              purposes.allSatisfy({ ["detail-action-recovery", "message-outbox", "timeline-cache"].contains($0) }) else {
            throw LocalCredentialError.corrupt
        }
        try update {
            for purpose in purposes {
                if let previous = $0.cacheKeys[purpose], previous != data { throw LocalCredentialError.conflict }
                $0.cacheKeys[purpose] = data
            }
            $0.migration["cache"] = "imported_unverified"
        }
    }
}
#endif
