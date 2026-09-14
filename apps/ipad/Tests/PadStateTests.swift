import Foundation
import Testing
import CorptieClientCore
@testable import CorptiePadState

@MainActor
struct PadStateTests {
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

    @Test func restartRetainsUnknownCommandAndOnlyMatchingReceiptClearsDraft() throws {
        let name = "corptie-ipad-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let command = PendingCommand(requestID: "request_123", sessionID: "session:a", kind: "send", serverID: "server:a", address: "https://example.invalid")
        defaults.set(try JSONEncoder().encode(command), forKey: "pendingCommand")
        let workspace = PadWorkspace(defaults: defaults)
        #expect(workspace.pending?.requestID == "request_123")
        workspace.drafts["session:a"] = "Keep me"
        func receipt(_ id: String, _ status: String) throws -> ClientCommandReceipt {
            try JSONDecoder().decode(ClientCommandReceipt.self, from: Data("{\"schemaVersion\":1,\"sessionId\":\"session:a\",\"requestId\":\"\(id)\",\"kind\":\"send\",\"status\":\"\(status)\",\"updatedAt\":\"now\"}".utf8))
        }
        workspace.settle(try receipt("request_123", "unknown"))
        #expect(workspace.pending != nil)
        workspace.settle(try receipt("other", "accepted"))
        #expect(workspace.pending != nil)
        #expect(workspace.drafts["session:a"] == "Keep me")
        workspace.settle(try receipt("request_123", "accepted"))
        #expect(workspace.pending == nil)
        #expect(workspace.drafts["session:a"] == "")
        #expect(PadWorkspace(defaults: defaults).pending == nil)
    }

    @Test func selectingAnotherSessionNeverCarriesMessagesOrCapabilities() {
        let workspace = PadWorkspace()
        workspace.status = "old receipt"
        workspace.before = "old-anchor"
        workspace.clearSelectionState()
        #expect(workspace.before == nil)
        #expect(workspace.capabilities == nil)
        #expect(workspace.status.isEmpty)
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
