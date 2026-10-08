import Foundation
import CryptoKit
import Testing
import CorptieClientCore
@testable import CorptieClientSecurity

struct ReliableMessageOutboxTests {
    @Test func onlyTerminalRejectedOrCancelledPayloadsCanBeDiscarded() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let key = SymmetricKey(size: .bits256)
        let outbox = ReliableMessageOutbox(directory: directory, key: key)
        for state in [ReliableOutgoingMessage.State.waiting, .blocked, .accepted, .rejected, .cancelled] {
            var message = ReliableOutgoingMessage(serverID: "server", deviceID: "device", sessionID: "session",
                displaySessionID: "session", text: "body", images: [.init(fileName: "image", data: Data([1, 2]))])
            message.state = state
            try await outbox.save(message)
            let discarded = try await outbox.discardTerminal(message.id)
            #expect(discarded == (state == .rejected || state == .cancelled))
            let remaining = try await outbox.all().contains(where: { $0.id == message.id })
            #expect(remaining == !discarded)
        }
        #expect(try await ReliableMessageOutbox(directory: directory, key: key).all().count == 3)
    }
    @Test func identityJournalHasABoundedRetentionIndependentOfPayloads() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let key = SymmetricKey(size: .bits256)
        let store = ReliableMessageOutbox(directory: directory, key: key)
        for _ in 0...ReliableMessageOutbox.maximumAcknowledgements {
            let record = ReliableOutgoingMessage(serverID: "server", deviceID: "device", sessionID: "session",
                displaySessionID: "session", text: "not retained")
            try await store.acknowledge(record, messageID: record.messageID)
        }
        let restored = ReliableMessageOutbox(directory: directory, key: key)
        #expect(try await restored.acceptedIdentities().count == ReliableMessageOutbox.maximumAcknowledgements)
        #expect(try await restored.all().isEmpty)
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).count == ReliableMessageOutbox.maximumAcknowledgements)
    }
    @Test func encryptedIdentityJournalSurvivesPayloadReleaseAndRestart() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let key = SymmetricKey(size: .bits256)
        let outbox = ReliableMessageOutbox(directory: directory, key: key)
        var message = ReliableOutgoingMessage(serverID: "server", deviceID: "device", sessionID: "session",
            displaySessionID: "logical", text: "private body", images: [.init(fileName: "image", data: Data([1, 2, 3]))])
        try await outbox.save(message)
        message.state = .accepted; message.authoritativeMessageID = "client:authoritative"
        try await outbox.save(message)
        let restored = ReliableMessageOutbox(directory: directory, key: key)
        #expect(try await restored.all().first?.authoritativeMessageID == "client:authoritative")
        try await restored.acknowledge(message, messageID: "client:authoritative")
        try await restored.remove(message.id)
        let afterRelease = ReliableMessageOutbox(directory: directory, key: key)
        #expect(try await afterRelease.all().isEmpty)
        let ack = try #require(await afterRelease.acceptedIdentities().first)
        #expect(ack.localMessageID == message.messageID)
        #expect(ack.messageID == "client:authoritative")
        #expect(ack.sessionID == "logical")
        let raw = try Data(contentsOf: directory.appendingPathComponent(message.id + ".ack"))
        #expect(raw.range(of: Data("client:authoritative".utf8)) == nil)
        await #expect(throws: (any Error).self) {
            _ = try await ReliableMessageOutbox(directory: directory, key: SymmetricKey(size: .bits256)).acceptedIdentities()
        }
        await #expect(throws: ReliableOutboxError.self) { try await afterRelease.acknowledge(message, messageID: "client:conflict") }
    }
    @Test func queueIsBoundedAndCannotOverwriteAnExistingIntent() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ReliableMessageOutbox(directory: directory, key: SymmetricKey(size: .bits256))
        let first = ReliableOutgoingMessage(serverID: "server", deviceID: "device", sessionID: "session", displaySessionID: "session", text: "first")
        try await store.save(first)
        let changed = ReliableOutgoingMessage(serverID: "server", deviceID: "device", sessionID: "session", displaySessionID: "session",
            text: "different intent", id: first.id, createdAt: first.createdAt)
        await #expect(throws: ReliableOutboxError.self) { try await store.save(changed) }
        for _ in 1..<ReliableMessageOutbox.maximumMessages {
            try await store.save(ReliableOutgoingMessage(serverID: "server", deviceID: "device", sessionID: "session", displaySessionID: "session", text: "queued"))
        }
        await #expect(throws: ReliableOutboxError.self) {
            try await store.save(ReliableOutgoingMessage(serverID: "server", deviceID: "device", sessionID: "session", displaySessionID: "session", text: "over capacity"))
        }
        #expect(try await store.all().count == ReliableMessageOutbox.maximumMessages)
        #expect(try await store.all().first?.text == "first")
    }
    @Test func encryptedQueueRestoresExactMessageAndAttachmentsAfterRestart() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let key = SymmetricKey(size: .bits256)
        let message = ReliableOutgoingMessage(serverID: "server", deviceID: "device", sessionID: "session",
            displaySessionID: "logical", text: "private message", images: [.init(fileName: "photo.png", data: Data([1, 2, 3]))])
        let first = ReliableMessageOutbox(directory: directory, key: key)
        try await first.save(message)
        let raw = try Data(contentsOf: directory.appendingPathComponent(message.id + ".sealed"))
        #expect(raw.range(of: Data("private message".utf8)) == nil)
        let restarted = ReliableMessageOutbox(directory: directory, key: key)
        let restored = try #require(await restarted.all().first)
        #expect(restored.id == message.id)
        #expect(restored.messageID == message.messageID)
        #expect(restored.text == message.text)
        #expect(restored.images.first?.data == Data([1, 2, 3]))
        var deferred = restored; deferred.attempts = 4
        try await restarted.save(deferred)
        #expect(try Data(contentsOf: directory.appendingPathComponent(message.id + ".sealed")) == raw)
        let afterRetryRestart = ReliableMessageOutbox(directory: directory, key: key)
        #expect(try await afterRetryRestart.all().first?.attempts == 4)
        #expect(try await restarted.all().first?.attempts == 4)
        try await restarted.remove(message.id)
        #expect(try await ReliableMessageOutbox(directory: directory, key: key).all().isEmpty)
    }

    @Test func wrongKeyPreservesCiphertextAndIdentity() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ReliableMessageOutbox(directory: directory, key: SymmetricKey(size: .bits256))
        let message = ReliableOutgoingMessage(serverID: "server", deviceID: "device", sessionID: "session", displaySessionID: "session", text: "preserve")
        try await store.save(message)
        let wrong = ReliableMessageOutbox(directory: directory, key: SymmetricKey(size: .bits256))
        await #expect(throws: (any Error).self) { _ = try await wrong.all() }
        #expect(FileManager.default.fileExists(atPath: directory.appendingPathComponent(message.id + ".sealed").path))
    }

    @Test func smallHeartbeatAndReceiptFlushWithoutReachingSixteenKiB() {
        for event in ["event: heartbeat\ndata: {}\n\n", "event: command-receipt\r\ndata: {}\r\n\r\n"] {
            var buffer = CloudRelaySSEBuffer(), chunks: [Data] = []
            for byte in event.utf8 { if let chunk = buffer.append(byte) { chunks.append(chunk) } }
            #expect(chunks == [Data(event.utf8)])
            #expect(buffer.remainder.isEmpty)
        }
        var buffer = CloudRelaySSEBuffer(), output = Data()
        for byte in Data(repeating: 65, count: 40000) { if let chunk = buffer.append(byte) { #expect(chunk.count <= 16384); output.append(chunk) } }
        output.append(buffer.remainder)
        #expect(output.count == 40000)
    }
}
