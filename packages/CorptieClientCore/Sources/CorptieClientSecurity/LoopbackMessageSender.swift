import Foundation
import CryptoKit

public enum LoopbackSubmissionError: Error { case awaitingConfirmation }

/// Desktop transport adapter for the same durable, encrypted outbox used by
/// remote clients. A transport failure never creates a new message identity.
public actor LoopbackMessageSender {
    private let makeOutbox: @Sendable () async throws -> ReliableMessageOutbox
    private var loadedOutbox: ReliableMessageOutbox?
    private let transport: @Sendable (URLRequest) async throws -> (Data, URLResponse)

    public init(outbox: ReliableMessageOutbox,
                transport: @escaping @Sendable (URLRequest) async throws -> (Data, URLResponse) = { try await URLSession.shared.data(for: $0) }) {
        self.makeOutbox = { outbox }
        self.loadedOutbox = outbox
        self.transport = transport
    }

    #if os(macOS)
    public init(directory: URL, credentialStore: MacAppCredentialStore,
                transport: @escaping @Sendable (URLRequest) async throws -> (Data, URLResponse) = { try await URLSession.shared.data(for: $0) }) {
        self.makeOutbox = {
            let key = try await credentialStore.cacheKey(purpose: "message-outbox", legacyDirectories: [directory])
            return ReliableMessageOutbox(directory: directory, key: key)
        }
        self.transport = transport
    }
    #endif

    private var active: Set<String> = []
    private var recovery: Task<Void, Never>?

    public func send(_ request: URLRequest, baseURL: URL, sessionID: String, messageID: String) async throws -> (Data, URLResponse) {
        guard let body = request.httpBody, let text = String(data: body, encoding: .utf8),
              let id = messageID.split(separator: ":").last, UUID(uuidString: String(id)) != nil else { throw ReliableOutboxError.invalidIdentity }
        let record = ReliableOutgoingMessage(serverID: baseURL.absoluteString, deviceID: identity,
            sessionID: sessionID, displaySessionID: sessionID, text: text, id: String(id))
        let outbox = try await resolveOutbox()
        try await outbox.save(record)
        defer { scheduleRecovery(baseURL) }
        return try await deliver(record, request: request, baseURL: baseURL, outbox: outbox)
    }

    public func resume(baseURL: URL) { scheduleRecovery(baseURL) }

    private func resolveOutbox() async throws -> ReliableMessageOutbox {
        if let loadedOutbox { return loadedOutbox }
        let candidate = try await makeOutbox()
        // A send and launch recovery can both await the credential store.
        if let loadedOutbox { return loadedOutbox }
        loadedOutbox = candidate
        return candidate
    }

    private var identity: String {
        "desktop:" + SHA256.hash(data: Data((Bundle.main.executableURL?.path ?? "desktop").utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private func scheduleRecovery(_ baseURL: URL) {
        guard recovery == nil else { return }
        recovery = Task {
            defer { recovery = nil }
            guard let outbox = try? await resolveOutbox() else { return }
            while !Task.isCancelled {
                let pending = (try? await outbox.all())?.filter { $0.serverID == baseURL.absoluteString && $0.deviceID == identity && $0.state == .waiting } ?? []
                if pending.isEmpty { break }
                for record in pending where !active.contains(record.id) {
                    var request = URLRequest(url: baseURL.appending(path: "sessions/\(record.sessionID)/messages"))
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "content-type")
                    request.httpBody = Data(record.text.utf8)
                    _ = try? await deliver(record, request: request, baseURL: baseURL, outbox: outbox)
                }
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }
    private func deliver(_ record: ReliableOutgoingMessage, request: URLRequest, baseURL: URL,
                         outbox: ReliableMessageOutbox) async throws -> (Data, URLResponse) {
        guard active.insert(record.id).inserted else { throw LoopbackSubmissionError.awaitingConfirmation }
        defer { active.remove(record.id) }
        let payload = try JSONSerialization.jsonObject(with: Data(record.text.utf8)) as? [String: Any]
        guard let messageID = payload?["messageId"] as? String else { throw ReliableOutboxError.invalidIdentity }
        for attempt in 0..<3 {
            do {
                var receipt = URLRequest(url: baseURL.appending(path: "sessions/\(record.sessionID)/messages/\(messageID)/receipt"))
                receipt.timeoutInterval = 10
                let (data, response) = try await transport(receipt)
                guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
                let receiptBody = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                if http.statusCode == 200, receiptBody?["accepted"] as? Bool == true,
                   receiptBody?["messageId"] as? String == messageID,
                   receiptBody?["sessionId"] as? String == record.sessionID {
                    try await outbox.remove(record.id)
                    return (data, response)
                }
                guard http.statusCode == 404, receiptBody?["code"] as? String == "MESSAGE_NOT_RECEIVED" else { throw LoopbackSubmissionError.awaitingConfirmation }
                let result = try await transport(request)
                if let received = result.1 as? HTTPURLResponse {
                    if (200..<300).contains(received.statusCode) { try await outbox.remove(record.id) }
                    else if (400..<500).contains(received.statusCode), ![408,429].contains(received.statusCode) {
                        var rejected = record; rejected.state = .rejected
                        try await outbox.save(rejected)
                    } else { throw LoopbackSubmissionError.awaitingConfirmation }
                }
                return result
            } catch {
                if attempt == 2 { throw LoopbackSubmissionError.awaitingConfirmation }
                try await Task.sleep(for: .milliseconds(250 * (attempt + 1)))
            }
        }
        throw LoopbackSubmissionError.awaitingConfirmation
    }
}
