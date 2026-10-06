import Foundation
import CryptoKit
import CorptieClientCore
import OSLog

public struct PersistedClientTimeline: Codable, Sendable {
    public let schemaVersion: Int
    public let sessionID: String
    public let revision: Int
    public let messages: [ClientMessage]
    public let before: String?
    public let savedAt: Date

    public init(sessionID: String, revision: Int, messages: [ClientMessage], before: String?) {
        schemaVersion = 1; self.sessionID = sessionID; self.revision = revision
        self.messages = messages; self.before = before; savedAt = Date()
    }
}

/// Cache, never authority: authenticated device/server scope, atomic encrypted
/// message+cursor records, bounded storage and coalesced writes off the UI actor.
public actor PersistentTimelineCache {
    private struct Pending { let scope: String; let record: PersistedClientTimeline }
    private let directory: URL
    private let keyProvider: @Sendable () async throws -> SymmetricKey
    private var key: SymmetricKey?
    private var pending: [String: Pending] = [:]
    private var writer: Task<Void, Never>?
    private var writerGeneration: UUID?
    private static let log = Logger(subsystem: "com.corptie.connection", category: "TimelineCache")

    public init(directory: URL? = nil, keyProvider: @escaping @Sendable () async throws -> SymmetricKey) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Corptie/TimelineCache", isDirectory: true)
        self.keyProvider = keyProvider
    }

    private func hash(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
    private func prepare() async throws -> SymmetricKey {
        if key == nil { key = try await keyProvider() }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var url = directory, values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
        return key!
    }

    public func save(_ record: PersistedClientTimeline, scope: String) {
        guard record.revision >= 0, !scope.isEmpty, !record.sessionID.isEmpty else { return }
        let name = hash(scope) + "-" + hash(record.sessionID)
        if let previous = pending[name], previous.record.revision > record.revision { return }
        pending[name] = Pending(scope: scope, record: record)
        // Resident cache is bounded independently; don't let rapid account
        // changes accumulate unbounded pending disk work.
        if pending.count > 48, let oldest = pending.min(by: { $0.value.record.savedAt < $1.value.record.savedAt })?.key { pending.removeValue(forKey: oldest) }
        guard writer == nil else { return }
        let generation = UUID()
        writerGeneration = generation
        writer = Task {
            do { try await Task.sleep(for: .milliseconds(500)); try await self.writePending() }
            catch is CancellationError { }
            catch { Self.log.error("Timeline cache write unavailable; live state retained") }
            if self.writerGeneration == generation { self.writer = nil; self.writerGeneration = nil }
        }
    }

    public func flush() async throws {
        writer?.cancel(); writer = nil; writerGeneration = nil
        try await writePending()
    }

    private func writePending() async throws {
        let key = try await prepare()
        let records = pending
        pending.removeAll()
        for (name, entry) in records {
            let clear = try JSONEncoder().encode(entry.record)
            // Oversized windows are simply not persisted. Never store a cursor
            // without its full baseline, nor silently truncate structured data.
            guard clear.count <= 1024 * 1024 else { continue }
            let sealed = try AES.GCM.seal(clear, using: key, authenticating: Data(("timeline:" + entry.scope).utf8)).combined!
            let url = directory.appendingPathComponent(name + ".sealed")
            try sealed.write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        }
        let files = try ownedFiles().sorted { $0.date > $1.date }
        var bytes = 0
        for (index, file) in files.enumerated() {
            bytes += file.bytes
            if index >= 48 || bytes > 12 * 1024 * 1024 || Date().timeIntervalSince(file.date) > 7 * 86400 {
                try FileManager.default.removeItem(at: file.url)
            }
        }
    }

    public func load(scope: String) async throws -> [PersistedClientTimeline] {
        let key = try await prepare()
        let prefix = hash(scope) + "-"
        var records: [PersistedClientTimeline] = []
        for file in try ownedFiles().filter({ $0.url.lastPathComponent.hasPrefix(prefix) }).sorted(by: { $0.date > $1.date }).prefix(48) {
            guard file.bytes <= 1024 * 1024 + 64, Date().timeIntervalSince(file.date) <= 7 * 86400 else { continue }
            do {
                let data = try Data(contentsOf: file.url)
                let clear = try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: key, authenticating: Data(("timeline:" + scope).utf8))
                let record = try JSONDecoder().decode(PersistedClientTimeline.self, from: clear)
                guard record.schemaVersion == 1, record.revision >= 0,
                      file.url.lastPathComponent == prefix + hash(record.sessionID) + ".sealed" else { continue }
                records.append(record)
            } catch { Self.log.error("Timeline cache record unavailable; resync required") }
        }
        return records
    }

    private func ownedFiles() throws -> [(url: URL, date: Date, bytes: Int)] {
        try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey]).compactMap { url in
            let name = url.deletingPathExtension().lastPathComponent
            guard url.pathExtension == "sealed", name.count == 129,
                  name.allSatisfy({ $0.isHexDigit || $0 == "-" }) else { return nil }
            let values = try url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey])
            guard values.isRegularFile == true else { return nil }
            return (url, values.contentModificationDate ?? .distantPast, values.fileSize ?? 0)
        }
    }
}
