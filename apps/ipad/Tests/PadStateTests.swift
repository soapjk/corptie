import Foundation
import Testing
import CorptieClientCore
@testable import CorptiePadState

@MainActor
struct PadStateTests {
    @Test func sendRefreshPreservesHistoryAndReconcilesExactlyOneOutgoingMessage() throws {
        let workspace = PadWorkspace()
        workspace.selection = "session:a"
        let history = ClientMessage(id: "history", text: "previous")
        let outgoing = ClientMessage(id: "client:send", text: "new message")
        workspace.messages = [history]
        workspace.before = "earlier"
        workspace.lastTimelineRevision = 10
        workspace.outgoingMessages["session:a"] = [outgoing]
        workspace.outgoingStates[outgoing.id] = "Sent"
        workspace.applyLatestWindow([], cursor: nil, revision: 11)
        #expect(workspace.visibleMessages.map(\.id) == [history.id, outgoing.id])
        #expect(workspace.before == "earlier")
        let processing = try JSONDecoder().decode(ClientMessage.self, from: Data(#"{"id":"client:send","type":"userMessage","text":"new message","userMessageStatus":"processing"}"#.utf8))
        workspace.applyLatestWindow([history, processing], cursor: nil, revision: 12)
        #expect(workspace.visibleMessages.map(\.id) == [history.id, outgoing.id])
        #expect(workspace.outgoingMessages["session:a"]?.isEmpty == true)
        #expect(workspace.outgoingStates[outgoing.id] == nil)
        #expect(workspace.messages.last?.userMessageStatus == "processing")
        workspace.applyLatestWindow([], cursor: nil, revision: 11)
        workspace.applyLatestWindow([], cursor: nil, revision: 12)
        #expect(workspace.messages.count == 2)
        workspace.selection = "session:b"
        #expect(workspace.visibleMessages.isEmpty)
        #expect(workspace.lastTimelineRevision == nil)
    }

    @Test func sharedMessageStateNeverEquatesReceiptAcceptanceWithProcessing() {
        #expect(UserMessageProcessingState(authoritativeValue: nil, legacyStatus: "accepted") == nil)
        #expect(UserMessageProcessingState(authoritativeValue: nil, legacyStatus: "running") == .processing)
        #expect(UserMessageProcessingState(authoritativeValue: "consumed", legacyStatus: "running") == .consumed)
        #expect(UserMessageProcessingState(authoritativeValue: "future", legacyStatus: "running") == nil)
        #expect(ClientSessionAPI.messageID(deviceID: "device:one", requestID: "request_123") == "client:e1257168015d1940a75d46870e4a8d7b50f29d38f1d7506c461ff2111cc06b26")
    }
    @Test func startupWithoutSavedBackendFinishesAndDoesNotRetryAfterDisconnect() async {
        let connection = PadConnection()
        connection.address = ""
        connection.serverID = ""
        await connection.restoreLastConnection()
        #expect(!connection.restoringConnection)
        #expect(!connection.connected)
        connection.disconnect()
        let notice = connection.notice
        connection.address = "invalid"
        connection.serverID = "server:test"
        await connection.restoreLastConnection()
        #expect(connection.notice == notice)
        #expect(!connection.connected)
    }

    @Test func startupFailureReturnsToConnectionPage() async {
        let connection = PadConnection()
        connection.address = "invalid"
        connection.serverID = "server:test"
        await connection.restoreLastConnection()
        #expect(!connection.restoringConnection)
        #expect(!connection.connected)
        #expect(!connection.notice.isEmpty)
    }

    @Test func scanValidatesBeforeReplacingFieldsAndDoesNotPersistSecret() throws {
        let connection = PadConnection()
        let savedAddress = UserDefaults.standard.string(forKey: "serverAddress")
        connection.address = "https://previous.local"
        #expect(throws: (any Error).self) { try connection.applyPairingCode("https://not-a-pairing-code") }
        #expect(connection.address == "https://previous.local")
        let code = DevicePairingCode(address: "https://mac.local:8443", serverId: "server:scan",
            pairingId: UUID().uuidString, pairingSecret: String(repeating: "a", count: 43),
            expiresAt: Date().timeIntervalSince1970 * 1000 + 300_000)
        try connection.applyPairingCode(code.encoded())
        #expect(connection.address == code.address)
        #expect(connection.serverID == code.serverId)
        #expect(connection.secret == code.pairingSecret)
        #expect(!connection.connected)
        #expect(connection.claim == nil)
        #expect(UserDefaults.standard.string(forKey: "serverAddress") == savedAddress)
        connection.busy = true
        #expect(throws: (any Error).self) { try connection.applyPairingCode(code.encoded()) }
    }
    @Test func paginationPreservesIdentityAndReplacesUpdatedRows() {
        struct Row: Identifiable { let id: String; let value: Int }
        let rows = PadWorkspace.merge([Row(id: "a", value: 1), Row(id: "b", value: 2)], [Row(id: "a", value: 3), Row(id: "c", value: 4)])
        #expect(rows.map(\.id) == ["a", "b", "c"])
        #expect(rows.map(\.value) == [3, 2, 4])
    }

    @Test func missingSessionIsOnlyUnavailableAfterInventoryIsComplete() throws {
        let workspace = PadWorkspace()
        workspace.sessionCursor = "more"
        #expect(!workspace.sessionIsKnownUnavailable("session:missing"))
        workspace.sessionCursor = nil
        #expect(workspace.sessionIsKnownUnavailable("session:missing"))
        let session = try JSONDecoder().decode(ClientSession.self, from: Data(#"{"id":"session:known","title":"Known","sessionKind":"worker","executionStatus":"completed","updatedAt":"now"}"#.utf8))
        workspace.sessions = [session]
        workspace.rebuildGroups()
        #expect(!workspace.sessionIsKnownUnavailable("session:known"))
    }

    @Test func restartRetainsUnknownCommandAndOnlyMatchingReceiptClearsDraft() throws {
        let name = "corptie-ipad-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let command = PendingCommand(requestID: "request_123", sessionID: "session:a", kind: "send", serverID: "server:a", address: "https://example.invalid")
        defaults.set(try JSONEncoder().encode(command), forKey: "pendingCommand")
        let workspace = PadWorkspace(defaults: defaults)
        #expect(workspace.pending?.requestID == "request_123")
        workspace.drafts["session:a"] = "Keep me"
        workspace.draftImages["session:a"] = [ClientDraftImage(fileName: "test.png", data: Data([1]))]
        workspace.draftMentions["session:a"] = [ClientDraftMention(targetType: "work", targetId: "work:a", displayName: "A")]
        func receipt(_ id: String, _ status: String) throws -> ClientCommandReceipt {
            try JSONDecoder().decode(ClientCommandReceipt.self, from: Data("{\"schemaVersion\":1,\"sessionId\":\"session:a\",\"requestId\":\"\(id)\",\"kind\":\"send\",\"status\":\"\(status)\",\"updatedAt\":\"now\"}".utf8))
        }
        workspace.settle(try receipt("request_123", "unknown"))
        #expect(workspace.pending != nil)
        workspace.settle(try receipt("other", "accepted"))
        #expect(workspace.pending != nil)
        #expect(workspace.drafts["session:a"] == "Keep me")
        #expect(workspace.draftImages["session:a"]?.count == 1)
        #expect(workspace.draftMentions["session:a"]?.count == 1)
        workspace.settle(try receipt("request_123", "accepted"))
        #expect(workspace.pending == nil)
        #expect(workspace.status.isEmpty)
        #expect(workspace.drafts["session:a"] == "")
        #expect(workspace.draftImages["session:a"]?.isEmpty == true)
        #expect(workspace.draftMentions["session:a"]?.isEmpty == true)
        #expect(PadWorkspace(defaults: defaults).pending == nil)
    }

    @Test func selectingAnotherSessionNeverCarriesMessagesOrCapabilities() {
        let workspace = PadWorkspace()
        workspace.status = "old receipt"
        workspace.conversationNotice = "old error"
        workspace.before = "old-anchor"
        workspace.configuringComposer = true
        let composerGeneration = workspace.composerGeneration
        workspace.clearSelectionState()
        #expect(workspace.before == nil)
        #expect(workspace.capabilities == nil)
        #expect(workspace.status.isEmpty)
        #expect(workspace.conversationNotice.isEmpty)
        #expect(!workspace.configuringComposer)
        #expect(workspace.composerConfiguration == nil)
        #expect(workspace.composerGeneration > composerGeneration)
    }

    @Test func structuredNotFoundDoesNotClaimAnActiveSessionWasArchived() {
        let message = PadConnection.explain(ClientServiceFailure(statusCode: 404, code: "SESSION_NOT_AVAILABLE"))
        #expect(message.contains("归档") == false)
        #expect(message.contains("刷新"))
    }

    @Test func conversationLoadIsNotDroppedByBackgroundWorkAndUsesResolvedSessionID() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ConversationProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://conversation.invalid")!),
            bearerToken: "fixture", configuration: config)
        let connection = PadConnection(transportOverride: transport)
        connection.connected = true
        connection.busy = true
        connection.notice = "stale error"
        ConversationProtocol.paths = []
        let workspace = PadWorkspace()
        workspace.selection = "logical:test"

        await workspace.load(connection)

        #expect(workspace.conversationNotice.isEmpty)
        #expect(workspace.capabilities?.sessionId == "session:resolved")
        #expect(workspace.messages.first?.text == "available")
        #expect(ConversationProtocol.paths.contains("/client/v1/sessions/session:resolved/messages"))
    }

    @Test func serializedOperationsRejectConcurrentDuplicate() async {
        let connection = PadConnection()
        var calls = 0
        await connection.perform {
            calls += 1
            await connection.perform { calls += 1 }
        }
        #expect(calls == 1)
        #expect(!connection.busy)
    }
}

private final class ConversationProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var paths: [String] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        Self.paths.append(path)
        let json = path.hasSuffix("/capabilities")
            ? #"{"schemaVersion":1,"sessionId":"session:resolved","readMessages":true,"send":{"available":true},"stop":{"available":false}}"#
            : #"{"schemaVersion":1,"sessionId":"session:resolved","hasEarlier":false,"items":[{"id":"item:1","type":"agentMessage","text":"available"}]}"#
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
            httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
