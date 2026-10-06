import Foundation
import CryptoKit
import Security
import CorptieClientCore

public struct ReliableOutgoingMessage: Codable, Sendable, Identifiable {
    public enum State: String, Codable, Sendable { case waiting, blocked, rejected, accepted, cancelled }
    public let id: String
    public let serverID: String
    public let deviceID: String
    public let sessionID: String
    public let displaySessionID: String
    public let createdAt: String
    public let enqueuedAt: Date
    public let text: String
    public let images: [ClientDraftImage]
    public let mentions: [ClientDraftMention]
    public var state: State = .waiting
    public var attempts = 0
    public var nextAttemptAt: Date = .distantPast
    public var errorCode: String?
    /// Nil on pre-fix records: their remote ownership may be ambiguous.
    public let messageIdentityVersion: Int?
    public var authoritativeMessageID: String?

    public init(serverID: String, deviceID: String, sessionID: String, displaySessionID: String,
                text: String, images: [ClientDraftImage] = [], mentions: [ClientDraftMention] = [],
                id: String = UUID().uuidString, createdAt: String = Date().ISO8601Format(),
                messageIdentityVersion: Int? = 2) {
        self.id = id; self.serverID = serverID; self.deviceID = deviceID
        self.sessionID = sessionID; self.displaySessionID = displaySessionID
        self.createdAt = createdAt; self.text = text; self.images = images; self.mentions = mentions
        enqueuedAt = Date()
        self.messageIdentityVersion = messageIdentityVersion
    }
    public var messageID: String { ClientSessionAPI.messageID(deviceID: deviceID, requestID: id) }
}

/// Compact encrypted identity journal, independent of attachment ownership.
public struct ReliableMessageAcknowledgement: Codable, Sendable {
    public let requestID: String
    public let serverID: String
    public let deviceID: String
    public let sessionID: String
    public let localMessageID: String
    public let messageID: String
    public let acceptedAt: Date
    public init(_ message: ReliableOutgoingMessage, messageID: String) {
        requestID = message.id; serverID = message.serverID; deviceID = message.deviceID
        sessionID = message.displaySessionID; localMessageID = message.messageID
        self.messageID = messageID; acceptedAt = Date()
    }
}

public enum ReliableOutboxError: Error { case full, corrupt, keychain(OSStatus), invalidIdentity }

/// Bounded, encrypted, crash-safe local ownership. UI and network work never run
/// on this actor. Each atomic file is one message; unrelated retries cannot
/// rewrite the whole queue. Test callers can inject a directory and key.
public actor ReliableMessageOutbox {
    private struct Status: Codable {
        let state: ReliableOutgoingMessage.State
        let attempts: Int
        let nextAttemptAt: Date
        let errorCode: String?
        let authoritativeMessageID: String?
        init(_ message: ReliableOutgoingMessage) {
            state = message.state; attempts = message.attempts
            nextAttemptAt = message.nextAttemptAt; errorCode = message.errorCode
            authoritativeMessageID = message.authoritativeMessageID
        }
    }
    private let directory: URL
    private let injectedKey: SymmetricKey?
    private var key: SymmetricKey?
    private var records: [String: ReliableOutgoingMessage] = [:]
    private var sizes: [String: Int] = [:]
    private var statusSizes: [String: Int] = [:]
    private var loaded = false
    private var acknowledgements: [String: ReliableMessageAcknowledgement] = [:]
    private var acknowledgementsLoaded = false
    public static let maximumAcknowledgements = 1000
    public static let maximumMessages = 100
    public static let maximumBytes = 48 * 1024 * 1024

    public init(directory: URL? = nil, key: SymmetricKey? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory,
            in: .userDomainMask)[0].appendingPathComponent("Corptie/MessageOutbox", isDirectory: true)
        injectedKey = key
    }

    public func all() throws -> [ReliableOutgoingMessage] {
        try load()
        return records.values.sorted {
            $0.enqueuedAt == $1.enqueuedAt ? $0.id < $1.id : $0.enqueuedAt < $1.enqueuedAt
        }
    }

    public func save(_ message: ReliableOutgoingMessage) throws {
        try load()
        guard UUID(uuidString: message.id) != nil, !message.serverID.isEmpty, !message.deviceID.isEmpty else {
            throw ReliableOutboxError.invalidIdentity
        }
        if let previous = records[message.id] {
            guard previous.serverID == message.serverID, previous.deviceID == message.deviceID,
                  previous.sessionID == message.sessionID, previous.createdAt == message.createdAt,
                  previous.displaySessionID == message.displaySessionID, previous.enqueuedAt == message.enqueuedAt,
                  previous.text == message.text,
                  previous.messageIdentityVersion == message.messageIdentityVersion,
                  previous.images.count == message.images.count,
                  zip(previous.images, message.images).allSatisfy({ pair in
                      pair.0.fileName == pair.1.fileName && pair.0.data == pair.1.data
                  }),
                  previous.mentions == message.mentions else {
                throw ReliableOutboxError.invalidIdentity
            }
            // Original text/attachments are immutable and written once. Retry
            // bookkeeping must not base64-encode and rewrite megabytes of images.
            let status = try AES.GCM.seal(JSONEncoder().encode(Status(message)), using: key!,
                authenticating: Data((message.id + ":state").utf8)).combined!
            let delta = status.count - (statusSizes[message.id] ?? 0)
            guard sizes.values.reduce(0, +) + delta <= Self.maximumBytes else { throw ReliableOutboxError.full }
            try write(status, to: directory.appendingPathComponent(message.id + ".state"))
            sizes[message.id, default: 0] += delta; statusSizes[message.id] = status.count
            records[message.id] = message
            return
        } else if records.count >= Self.maximumMessages { throw ReliableOutboxError.full }
        let data = try AES.GCM.seal(JSONEncoder().encode(message), using: key!,
            authenticating: Data(message.id.utf8)).combined!
        guard sizes.values.reduce(0, +) - (sizes[message.id] ?? 0) + data.count <= Self.maximumBytes else {
            throw ReliableOutboxError.full
        }
        let url = directory.appendingPathComponent(message.id + ".sealed")
        try write(data, to: url)
        records[message.id] = message; sizes[message.id] = data.count
    }

    private func write(_ data: Data, to url: URL) throws {
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    public func remove(_ id: String) throws {
        try load()
        guard records[id] != nil else { return }
        let state = directory.appendingPathComponent(id + ".state")
        if FileManager.default.fileExists(atPath: state.path) { try FileManager.default.removeItem(at: state) }
        try FileManager.default.removeItem(at: directory.appendingPathComponent(id + ".sealed"))
        records.removeValue(forKey: id); sizes.removeValue(forKey: id)
        statusSizes.removeValue(forKey: id)
    }

    public func acceptedIdentities() throws -> [ReliableMessageAcknowledgement] {
        try load(); try loadAcknowledgements()
        return Array(acknowledgements.values)
    }

    public func acknowledge(_ message: ReliableOutgoingMessage, messageID: String) throws {
        try load(); try loadAcknowledgements()
        guard UUID(uuidString: message.id) != nil, messageID.hasPrefix("client:"), messageID.count <= 200 else {
            throw ReliableOutboxError.invalidIdentity
        }
        let acknowledgement = ReliableMessageAcknowledgement(message, messageID: messageID)
        if let previous = acknowledgements[message.id] {
            guard previous.serverID == message.serverID, previous.deviceID == message.deviceID,
                  previous.localMessageID == message.messageID, previous.messageID == messageID else {
                throw ReliableOutboxError.invalidIdentity
            }
            return
        }
        // Bound this journal separately; it never retains prompt text or images.
        while acknowledgements.count >= Self.maximumAcknowledgements,
              let oldest = acknowledgements.values.min(by: { $0.acceptedAt < $1.acceptedAt }) {
            try FileManager.default.removeItem(at: directory.appendingPathComponent(oldest.requestID + ".ack"))
            acknowledgements.removeValue(forKey: oldest.requestID)
        }
        let data = try AES.GCM.seal(JSONEncoder().encode(acknowledgement), using: key!,
            authenticating: Data((message.id + ":ack").utf8)).combined!
        try write(data, to: directory.appendingPathComponent(message.id + ".ack"))
        acknowledgements[message.id] = acknowledgement
    }

    private func loadAcknowledgements() throws {
        guard !acknowledgementsLoaded else { return }
        let files = try FileManager.default.contentsOfDirectory(at: directory,
            includingPropertiesForKeys: [.fileSizeKey]).filter { $0.pathExtension == "ack" }
        guard files.count <= Self.maximumAcknowledgements else { throw ReliableOutboxError.corrupt }
        var recovered: [String: ReliableMessageAcknowledgement] = [:]
        for file in files {
            let id = file.deletingPathExtension().lastPathComponent
            guard UUID(uuidString: id) != nil,
                  (try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 4096 else {
                throw ReliableOutboxError.corrupt
            }
            let data = try Data(contentsOf: file)
            let clear = try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: key!,
                authenticating: Data((id + ":ack").utf8))
            let acknowledgement = try JSONDecoder().decode(ReliableMessageAcknowledgement.self, from: clear)
            guard acknowledgement.requestID == id else { throw ReliableOutboxError.corrupt }
            if Date().timeIntervalSince(acknowledgement.acceptedAt) > 7 * 86400 {
                try FileManager.default.removeItem(at: file)
            } else { recovered[id] = acknowledgement }
        }
        acknowledgements = recovered; acknowledgementsLoaded = true
    }

    private func load() throws {
        guard !loaded else { return }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        var protectedDirectory = directory
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try protectedDirectory.setResourceValues(values)
        key = try injectedKey ?? loadKey()
        let files = try FileManager.default.contentsOfDirectory(at: directory,
            includingPropertiesForKeys: [.fileSizeKey]).filter { $0.pathExtension == "sealed" }
        guard files.count <= Self.maximumMessages else { throw ReliableOutboxError.full }
        var recovered: [String: ReliableOutgoingMessage] = [:], recoveredSizes: [String: Int] = [:]
        var recoveredStatusSizes: [String: Int] = [:]
        for file in files {
            let id = file.deletingPathExtension().lastPathComponent
            guard UUID(uuidString: id) != nil else { throw ReliableOutboxError.corrupt }
            let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard recoveredSizes.values.reduce(0, +) + size <= Self.maximumBytes else { throw ReliableOutboxError.full }
            let data = try Data(contentsOf: file)
            let clear = try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: key!, authenticating: Data(id.utf8))
            var record = try JSONDecoder().decode(ReliableOutgoingMessage.self, from: clear)
            guard record.id == id else { throw ReliableOutboxError.corrupt }
            let stateURL = directory.appendingPathComponent(id + ".state")
            var stateSize = 0
            if FileManager.default.fileExists(atPath: stateURL.path) {
                stateSize = try stateURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard stateSize <= 4096, recoveredSizes.values.reduce(0, +) + size + stateSize <= Self.maximumBytes else {
                    throw ReliableOutboxError.corrupt
                }
                let stateData = try Data(contentsOf: stateURL)
                let stateClear = try AES.GCM.open(AES.GCM.SealedBox(combined: stateData), using: key!,
                    authenticating: Data((id + ":state").utf8))
                let status = try JSONDecoder().decode(Status.self, from: stateClear)
                record.state = status.state; record.attempts = status.attempts
                record.nextAttemptAt = status.nextAttemptAt; record.errorCode = status.errorCode
                record.authoritativeMessageID = status.authoritativeMessageID
            }
            recovered[id] = record; recoveredSizes[id] = data.count + stateSize
            recoveredStatusSizes[id] = stateSize
        }
        records = recovered; sizes = recoveredSizes; statusSizes = recoveredStatusSizes; loaded = true
    }

    /// Local cache encryption shares the device-only key, with distinct AAD.
    public func timelinePersistenceKey() throws -> SymmetricKey {
        try load()
        return key!
    }

    private func loadKey() throws -> SymmetricKey {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.corptie.client.message-outbox",
            kSecAttrAccount as String: "encryption-v1", kSecAttrSynchronizable as String: false]
        var read = query; read[kSecReturnData as String] = true; read[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(read as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data, data.count == 32 { return SymmetricKey(data: data) }
        guard status == errSecItemNotFound else { throw ReliableOutboxError.keychain(status) }
        // Never replace a missing key if ciphertext exists: preserve recovery evidence.
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        guard !files.contains(where: { $0.pathExtension == "sealed" }) else { throw ReliableOutboxError.corrupt }
        let generated = SymmetricKey(size: .bits256)
        let data = generated.withUnsafeBytes { Data($0) }
        var insert = query; insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(insert as CFDictionary, nil)
        if added == errSecDuplicateItem { return try loadKey() }
        guard added == errSecSuccess else { throw ReliableOutboxError.keychain(added) }
        return generated
    }
}
