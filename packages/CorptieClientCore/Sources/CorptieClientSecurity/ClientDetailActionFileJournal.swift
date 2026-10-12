import Foundation
import CryptoKit
import Security
import CorptieClientCore

/// Bounded encrypted recovery identities. Authoritative receipts continue to
/// live in the existing server command journal. Hosts supply a stable protected
/// directory and a key obtained from their credential/keychain owner.
public actor ClientDetailActionFileJournal: ClientDetailActionJournal {
    private let directory: URL
    private let key: SymmetricKey
    private let maximumEntries = 100
    public init(directory: URL, key: SymmetricKey) { self.directory = directory; self.key = key }
    private func file(_ scope: ClientDetailActionScope) throws -> URL {
        let data = try authentication(scope)
        let name = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(name + ".pending")
    }
    private func authentication(_ scope: ClientDetailActionScope) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(scope)
    }
    public func pending(scope: ClientDetailActionScope) throws -> [ClientDetailPendingAction] {
        let path = try file(scope)
        guard FileManager.default.fileExists(atPath: path.path) else { return [] }
        let data = try Data(contentsOf: path, options: .mappedIfSafe)
        guard data.count <= 128 * 1024 else { throw ReliableOutboxError.full }
        let clear = try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: key, authenticating: authentication(scope))
        let records = try JSONDecoder().decode([ClientDetailPendingAction].self, from: clear)
        guard records.count <= maximumEntries, records.allSatisfy({ $0.scope == scope }),
              Set(records.map(\.requestID)).count == records.count else { throw ReliableOutboxError.corrupt }
        return records
    }
    private func write(_ records: [ClientDetailPendingAction], scope: ClientDetailActionScope) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        let data = try AES.GCM.seal(JSONEncoder().encode(records), using: key, authenticating: authentication(scope)).combined!
        guard data.count <= 128 * 1024 else { throw ReliableOutboxError.full }
        let path = try file(scope)
        #if os(iOS)
        try data.write(to: path, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: path, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
    }
    public func save(_ record: ClientDetailPendingAction) throws {
        guard UUID(uuidString: record.requestID) != nil,
              record.scope.isValid else { throw ReliableOutboxError.invalidIdentity }
        var records = try pending(scope: record.scope)
        if let previous = records.first(where: { $0.requestID == record.requestID }) {
            guard previous == record else { throw ReliableOutboxError.invalidIdentity }
            return
        }
        guard records.count < maximumEntries else { throw ReliableOutboxError.full }
        records.append(record)
        try write(records, scope: record.scope)
    }
    public func remove(scope: ClientDetailActionScope, requestID: String) throws {
        let records = try pending(scope: scope).filter { $0.requestID != requestID }
        if records.isEmpty { try clear(scope: scope) } else { try write(records, scope: scope) }
    }
    public func clear(scope: ClientDetailActionScope) throws {
        let path = try file(scope)
        if FileManager.default.fileExists(atPath: path.path) { try FileManager.default.removeItem(at: path) }
    }
}
