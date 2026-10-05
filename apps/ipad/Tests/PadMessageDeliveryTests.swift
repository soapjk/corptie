import Foundation
import CryptoKit
import Testing
import CorptieClientCore
import CorptieClientSecurity
@testable import CorptieMobileState

@MainActor
struct PadMessageDeliveryTests {
    @Test(arguments: [false, true])
    func authoritativeAndReceiptArrivalOrderLeavesOneCard(timelineFirst: Bool) throws {
        let name = "identity-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "session"
        workspace.outgoingMessages["session"] = [.init(id: "client:local", text: "same instruction")]
        workspace.outgoingStates["client:local"] = "Sending"
        let authoritative = try JSONDecoder().decode(ClientMessage.self, from: Data(
            #"{"id":"client:server","type":"userMessage","text":"same instruction","userMessageStatus":"processing"}"#.utf8))
        if timelineFirst { workspace.applyLatestWindow([authoritative], cursor: nil, revision: 1) }
        workspace.acknowledgeOutgoing(localID: "client:local", messageID: "client:server", sessionID: "session")
        if !timelineFirst { workspace.applyLatestWindow([authoritative], cursor: nil, revision: 1) }
        #expect(workspace.visibleMessages.map(\.id) == ["client:server"])
        #expect(workspace.outgoingMessages["session"]?.isEmpty == true)
        #expect(workspace.outgoingStates.isEmpty)
        let status = UserMessageStatusPresentation(authoritativeStatus: workspace.visibleMessages[0].userMessageStatus,
            legacyStatus: nil, localDeliveryState: "Sent")
        #expect(status?.kind == .processing)
        // A late/duplicate receipt cannot recreate or downgrade the card.
        workspace.acknowledgeOutgoing(localID: "client:local", messageID: "client:server", sessionID: "session")
        #expect(workspace.visibleMessages.count == 1)
        #expect(workspace.outgoingStates.isEmpty)
    }

    @Test func identicalTextDoesNotMergeDistinctRequestsOrOtherSessions() throws {
        let name = "identity-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "session"
        workspace.outgoingMessages["session"] = [.init(id: "client:one", text: "继续"), .init(id: "client:two", text: "继续")]
        workspace.outgoingMessages["other"] = [.init(id: "client:other", text: "继续")]
        let authoritative = ClientMessage(id: "client:one", text: "继续")
        workspace.applyLatestWindow([authoritative], cursor: nil, revision: 1)
        #expect(workspace.visibleMessages.map(\.id) == ["client:one", "client:two"])
        #expect(workspace.outgoingMessages["other"]?.count == 1)
    }

    @Test func receiptIdentityReplacementPreservesLocalInstructionOrder() {
        let workspace = PadWorkspace()
        workspace.selection = "session"
        workspace.outgoingMessages["session"] = [.init(id: "client:first-local", text: "first"), .init(id: "client:second", text: "second")]
        workspace.acknowledgeOutgoing(localID: "client:first-local", messageID: "client:first-server", sessionID: "session")
        #expect(workspace.visibleMessages.map(\.id) == ["client:first-server", "client:second"])
        workspace.acknowledgeOutgoing(localID: "client:first-server", messageID: "client:first-server", sessionID: "session")
        #expect(workspace.visibleMessages.map(\.id) == ["client:first-server", "client:second"])
    }

    @Test(arguments: [false, true])
    func oldAmbiguousRecordOrWrongRelayIdentityNeverReplays(wrongIdentity: Bool) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = ReliableMessageOutbox(directory: directory, key: SymmetricKey(size: .bits256))
        let record = ReliableOutgoingMessage(serverID: "server", deviceID: "device", sessionID: "session",
            displaySessionID: "session", text: "keep me", messageIdentityVersion: wrongIdentity ? 2 : nil)
        try await outbox.save(record)
        let harness = MigrationHarness(wrongIdentity: wrongIdentity)
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1")!),
            data: { request in try await harness.handle(request) }, bytes: { _ in throw URLError(.cancelled) })
        let connection = PadConnection(transportOverride: transport, credentials: .init(serverId: "server", deviceId: "device",
            accessToken: "test", refreshToken: "test", accessExpiresAt: .greatestFiniteMagnitude, refreshExpiresAt: .greatestFiniteMagnitude))
        connection.serverID = "server"; connection.connected = true
        let name = "migration-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let workspace = PadWorkspace(defaults: defaults, messageOutbox: outbox)
        workspace.selection = "session"
        await workspace.runMessageDelivery(connection)
        #expect(await harness.posts == 0)
        #expect(try await outbox.all().first?.state == .blocked)
        #expect(try await outbox.all().first?.text == "keep me")
        #expect(workspace.deliveryIssues["session"] == record.id)
    }

    @Test func unsupportedBackendDoesNotSilentlyFallBackToUnreliableSend() async throws {
        let workspace = PadWorkspace()
        workspace.selection = "session"
        workspace.drafts["session"] = "keep draft"
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1")!),
            data: { _ in Issue.record("No request should be dispatched"); throw URLError(.cancelled) },
            bytes: { _ in throw URLError(.cancelled) })
        await workspace.command(PadConnection(transportOverride: transport), stop: false)
        #expect(workspace.drafts["session"] == "keep draft")
        #expect(workspace.status.contains("身份一致"))
        #expect(workspace.pending == nil)
    }
    @Test(arguments: [false, true])
    func networkLossBeforeOrAfterReceptionRetriesTheSameMessage(loseAcknowledgement: Bool) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let harness = DeliveryHarness(loseAcknowledgement: loseAcknowledgement)
        let endpoint = try BackendEndpoint(URL(string: "http://127.0.0.1:4311")!)
        let transport = BackendTransport(endpoint: endpoint, data: { request in try await harness.handle(request) },
            bytes: { _ in throw URLError(.notConnectedToInternet) })
        let connection = PadConnection(transportOverride: transport, credentials: .init(serverId: "server", deviceId: "device",
            accessToken: "test", refreshToken: "test", accessExpiresAt: .greatestFiniteMagnitude, refreshExpiresAt: .greatestFiniteMagnitude))
        connection.serverID = "server"; connection.connected = true
        let outbox = ReliableMessageOutbox(directory: directory, key: SymmetricKey(size: .bits256))
        let name = "delivery-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let workspace = PadWorkspace(defaults: defaults, messageOutbox: outbox)
        workspace.selection = "session"
        workspace.drafts["session"] = "hello"
        await workspace.enqueueReliableMessage(connection, sessionID: "session", displaySessionID: "session",
            text: "hello", images: [], mentions: [], clearsDraft: true)
        #expect(workspace.drafts["session"] == "")
        #expect(workspace.pending == nil)
        let id = try #require(await outbox.all().first?.id)
        await workspace.enqueueReliableMessage(connection, sessionID: "session", displaySessionID: "session",
            text: "second instruction", images: [], mentions: [], clearsDraft: false)
        let secondID = try #require(await outbox.all().last?.id)
        let worker = Task { await workspace.runMessageDelivery(connection) }
        for _ in 0..<400 {
            if await harness.requestIDs.count >= 3, try await outbox.all().isEmpty { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        worker.cancel(); await worker.value; workspace.refreshWorker?.cancel()
        #expect(try await outbox.all().isEmpty)
        #expect(workspace.outgoingStates[ClientSessionAPI.messageID(deviceID: "device", requestID: id)] == "后端已接收")
        #expect(await harness.admissions == 2)
        #expect(await harness.requestIDs == [id, id, secondID])
        #expect(await harness.texts == ["hello", "hello", "second instruction"])
    }

    @Test func durableQueueIsIsolatedFromOtherServerAndDevice() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = ReliableMessageOutbox(directory: directory, key: SymmetricKey(size: .bits256))
        let record = ReliableOutgoingMessage(serverID: "other", deviceID: "other", sessionID: "session", displaySessionID: "session", text: "do not send")
        try await outbox.save(record)
        let harness = DeliveryHarness(loseAcknowledgement: false)
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1")!),
            data: { request in try await harness.handle(request) }, bytes: { _ in throw URLError(.notConnectedToInternet) })
        let connection = PadConnection(transportOverride: transport, credentials: .init(serverId: "server", deviceId: "device",
            accessToken: "test", refreshToken: "test", accessExpiresAt: 1, refreshExpiresAt: 1))
        connection.serverID = "server"; connection.connected = true
        let workspace = PadWorkspace(messageOutbox: outbox)
        await workspace.runMessageDelivery(connection)
        #expect(await harness.requestIDs.isEmpty)
        #expect(workspace.outgoingMessages.isEmpty)
        #expect(try await outbox.all().count == 1)
    }

    @Test func retryPolicyDistinguishesTemporaryFaultsFromRejections() {
        #expect(!PadWorkspace.deliveryFailureIsPermanent(URLError(.timedOut)))
        #expect(!PadWorkspace.deliveryFailureIsPermanent(ClientServiceFailure(statusCode: 503, code: "SESSION_BUSY")))
        #expect(!PadWorkspace.deliveryFailureIsPermanent(ClientServiceFailure(statusCode: 409, code: "SESSION_NOT_READY")))
        #expect(PadWorkspace.deliveryFailureIsPermanent(ClientServiceFailure(statusCode: 410, code: "MESSAGE_EXPIRED")))
        #expect(PadWorkspace.deliveryFailureIsPermanent(CloudRelayTransportError.responseTooLarge))
        #expect(!PadWorkspace.deliveryFailureIsPermanent(CloudRelayTransportError.disconnected))
        #expect(PadWorkspace.retryInterval(attempt: 1, jitter: 1) == 1)
        #expect(PadWorkspace.retryInterval(attempt: 100, jitter: 1) == 30)
    }
}

private actor MigrationHarness {
    let wrongIdentity: Bool
    var posts = 0
    init(wrongIdentity: Bool) { self.wrongIdentity = wrongIdentity }
    func handle(_ request: URLRequest) throws -> (Data, HTTPURLResponse) {
        if request.httpMethod == "POST" { posts += 1; throw URLError(.cancelled) }
        if request.url!.path.hasSuffix("/me") {
            let data = try JSONSerialization.data(withJSONObject: [
                "deviceId": wrongIdentity ? "cloud-relay-connector" : "device", "serverId": "server"
            ])
            return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        throw ClientServiceFailure(statusCode: 404, code: "COMMAND_NOT_FOUND")
    }
}

private actor DeliveryHarness {
    let loseAcknowledgement: Bool
    var requestIDs: [String] = []
    var texts: [String] = []
    var accepted = Set<String>()
    var admissions: Int { accepted.count }
    init(loseAcknowledgement: Bool) { self.loseAcknowledgement = loseAcknowledgement }
    func handle(_ request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        var response: [String: Any]
        if path.hasSuffix("/me") {
            response = ["deviceId": "device", "serverId": "server"]
        } else if path.hasSuffix("capabilities") {
            response = ["schemaVersion": 1, "sessionId": "session", "readMessages": true,
                "send": ["available": true], "stop": ["available": true],
                "reliableMessages": ["version": 1, "maximumAgeSeconds": 604800, "messageIdentityVersion": 2]]
        } else if path.hasSuffix("message-deliveries") {
            let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            let id = body["requestId"] as! String
            requestIDs.append(id); texts.append(body["text"] as! String)
            if requestIDs.count == 1 && !loseAcknowledgement { throw URLError(.networkConnectionLost) }
            accepted.insert(id)
            if requestIDs.count == 1 { throw URLError(.networkConnectionLost) }
            response = ["schemaVersion": 1, "sessionId": "session", "requestId": id,
                "kind": "send", "status": "accepted", "updatedAt": "now",
                "messageId": ClientSessionAPI.messageID(deviceID: "device", requestID: id)]
        } else if path.hasSuffix("messages") {
            response = ["schemaVersion": 1, "sessionId": "session", "items": [], "hasEarlier": false]
        } else { throw URLError(.cancelled) }
        return (try JSONSerialization.data(withJSONObject: response), HTTPURLResponse(url: request.url!,
            statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!)
    }
}
