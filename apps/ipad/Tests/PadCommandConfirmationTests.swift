import Foundation
import Testing
import CorptieClientCore
@testable import CorptiePadState

@MainActor
@Suite(.serialized)
struct PadCommandConfirmationTests {
    private func fixture(_ text: String) throws -> (PadWorkspace, PadConnection, UserDefaults, String) {
        ConfirmationProtocol.reset()
        let name = "corptie-confirmation-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ConfirmationProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://confirmation.invalid")!),
            bearerToken: "fixture", configuration: config)
        let connection = PadConnection(transportOverride: transport)
        connection.serverID = "server:a"
        connection.address = "https://confirmation.invalid"
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "session:a"
        workspace.messages = [ClientMessage(id: "history", text: "history")]
        workspace.drafts["session:a"] = text
        return (workspace, connection, defaults, name)
    }

    @Test(arguments: ["/goal clear", "/clear"])
    func confirmationIsRequiredAndOnlyConversationClearResetsHistory(_ text: String) async throws {
        let (workspace, connection, defaults, name) = try fixture(text)
        defer { defaults.removePersistentDomain(forName: name) }
        await workspace.command(connection, stop: false)
        let proposal = try #require(workspace.commandConfirmation)
        #expect(workspace.pending == nil)
        #expect(workspace.drafts["session:a"] == text)
        #expect(workspace.messages.first?.id == "history")
        #expect(connection.notice.isEmpty)
        await workspace.command(connection, stop: false, confirmation: proposal)
        #expect(ConfirmationProtocol.count == 2)
        #expect(ConfirmationProtocol.distinctIDs == 2)
        #expect(workspace.commandConfirmation == nil)
        #expect(workspace.pending == nil)
        #expect(workspace.drafts["session:a"] == "")
        #expect(workspace.messages.isEmpty == (text == "/clear"))
        #expect(workspace.status.isEmpty)
        await workspace.command(connection, stop: false, confirmation: proposal)
        #expect(ConfirmationProtocol.count == 2) // consumed consent cannot be reused
    }

    @Test(arguments: ["edit-and-restore", "server", "address", "selection", "binding", "images", "cancel"])
    func changedIntentCannotUseOldConfirmation(_ change: String) async throws {
        let (workspace, connection, defaults, name) = try fixture("/goal clear")
        defer { defaults.removePersistentDomain(forName: name) }
        await workspace.command(connection, stop: false)
        let proposal = try #require(workspace.commandConfirmation)
        switch change {
        case "edit-and-restore":
            workspace.drafts["session:a"] = "/goal another"
            workspace.drafts["session:a"] = "/goal clear"
        case "server": connection.serverID = "server:b"
        case "address": connection.address = "https://other.invalid"
        case "selection": workspace.selection = "session:b"
        case "binding":
            workspace.capabilities = try JSONDecoder().decode(ClientSessionCapabilities.self, from: Data(#"{"schemaVersion":1,"sessionId":"session:new","readMessages":true,"send":{"available":true},"stop":{"available":true}}"#.utf8))
        case "images": workspace.draftImages["session:a"] = [ClientDraftImage(fileName: "a.png", data: Data([1]))]
        default: workspace.commandConfirmation = nil
        }
        await workspace.command(connection, stop: false, confirmation: proposal)
        #expect(ConfirmationProtocol.count == 1)
        #expect(workspace.pending == nil)
        #expect(workspace.commandConfirmation == nil)
        #expect(workspace.drafts["session:a"] == "/goal clear")
        #expect(workspace.status.contains("重新发送并确认"))
    }
}

private final class ConfirmationProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var requestIDs: [String] = []
    static var count: Int { lock.withLock { requestIDs.count } }
    static var distinctIDs: Int { lock.withLock { Set(requestIDs).count } }
    static func reset() { lock.withLock { requestIDs = [] } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        #expect(request.httpMethod == "POST")
        #expect(request.url!.path == "/client/v1/sessions/session:a/conversation-commands")
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
        let body = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        let id = body["requestId"] as! String
        Self.lock.withLock { Self.requestIDs.append(id) }
        let confirmed = body["confirmed"] as? Bool == true
        let clearsConversation = body["name"] as? String == "clear"
        let json: [String: Any] = confirmed ? ["schemaVersion": 1, "sessionId": "session:a", "requestId": id,
            "kind": "conversation_command", "status": "completed", "updatedAt": "now",
            "commandResult": ["text": "已清除", "truncated": false, "conversationCleared": clearsConversation]]
            : ["code": "COMMAND_CONFIRMATION_REQUIRED"]
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: confirmed ? 200 : 409,
            httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: json))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
