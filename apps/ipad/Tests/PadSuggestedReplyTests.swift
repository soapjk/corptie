import Foundation
import Testing
import CryptoKit
import CorptieClientCore
import CorptieClientSecurity
@testable import CorptieMobileState

@MainActor
@Suite(.serialized)
struct PadSuggestedReplyTests {
    @Test func suggestedReplyUsesOrdinarySendWithoutConsumingTheDraft() async throws {
        SuggestedReplyProtocol.reset()
        let name = "corptie-suggested-reply-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SuggestedReplyProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://suggested.invalid")!),
            bearerToken: "fixture", configuration: config)
        let connection = PadConnection(transportOverride: transport, credentials: .init(serverId: "server:a", deviceId: "device",
            accessToken: "fixture", refreshToken: "fixture", accessExpiresAt: .greatestFiniteMagnitude, refreshExpiresAt: .greatestFiniteMagnitude))
        connection.serverID = "server:a"
        connection.connected = true
        connection.address = "https://suggested.invalid"
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = ReliableMessageOutbox(directory: directory, key: SymmetricKey(size: .bits256))
        let workspace = PadWorkspace(defaults: defaults, messageOutbox: outbox)
        defer { workspace.refreshWorker?.cancel() }
        workspace.selection = "session:a"
        workspace.capabilities = try JSONDecoder().decode(ClientSessionCapabilities.self, from: Data(
            #"{"schemaVersion":1,"sessionId":"session:a","readMessages":true,"send":{"available":true},"stop":{"available":true},"reliableMessages":{"version":1,"maximumAgeSeconds":604800,"messageIdentityVersion":2}}"#.utf8))
        workspace.drafts["session:a"] = "Unfinished user draft"
        workspace.draftImages["session:a"] = [ClientDraftImage(fileName: "draft.png", data: Data([1]))]

        await workspace.sendSuggestedReply(connection, sessionID: "session:a", text: "Continue")
        #expect(try await outbox.all().first?.text == "Continue")
        await workspace.runMessageDelivery(connection)

        let body = try #require(SuggestedReplyProtocol.body)
        #expect(SuggestedReplyProtocol.path == "/client/v1/sessions/session:a/message-deliveries")
        #expect(body["text"] as? String == "Continue")
        #expect(body["images"] == nil)
        #expect(body["mentions"] == nil)
        #expect(workspace.pending == nil)
        #expect(workspace.drafts["session:a"] == "Unfinished user draft")
        #expect(workspace.draftImages["session:a"]?.count == 1)

        SuggestedReplyProtocol.reset()
        workspace.selection = "session:b"
        await workspace.sendSuggestedReply(connection, sessionID: "session:a", text: "Stale option")
        #expect(SuggestedReplyProtocol.body == nil)
    }
}

private final class SuggestedReplyProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var capturedBody: [String: Any]?
    nonisolated(unsafe) private static var capturedPath: String?
    static var body: [String: Any]? { lock.withLock { capturedBody } }
    static var path: String? { lock.withLock { capturedPath } }
    static func reset() { lock.withLock { capturedBody = nil; capturedPath = nil } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let isIdentity = request.url?.path.hasSuffix("/me") == true
        if !isIdentity, body != nil { Self.lock.withLock { Self.capturedBody = body; Self.capturedPath = request.url?.path } }
        let response: [String: Any] = isIdentity ? ["deviceId": "device", "serverId": "server:a"] : ["schemaVersion": 1, "sessionId": "session:a",
            "requestId": body?["requestId"] as? String ?? "invalid", "kind": "send",
            "status": "accepted", "updatedAt": "now",
            "messageId": ClientSessionAPI.messageID(deviceID: "device", requestID: body?["requestId"] as? String ?? "invalid")]
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
            httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!,
            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: response))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
