import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMobileState

@MainActor
struct PadUnreadTests {
    private static func workspace() -> (PadWorkspace, UserDefaults, String) {
        let name = "pad-unread-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        return (PadWorkspace(defaults: defaults), defaults, name)
    }

    private static func sessions(_ json: String) throws -> [ClientSession] {
        try JSONDecoder().decode([ClientSession].self, from: Data(json.utf8))
    }

    @Test func rebuildGroupsProjectsUnreadSessionsWorksAndIndependentChats() throws {
        let (workspace, defaults, name) = Self.workspace()
        defer { defaults.removePersistentDomain(forName: name) }
        workspace.sessions = try Self.sessions("""
        [{"id":"done","title":"Done","workId":"w1","taskId":"t1","executionStatus":"completed","lastAgentMessageSequence":4,"lastReadMessageSequence":1,"updatedAt":"now"},
         {"id":"running","title":"Running","workId":"w2","taskId":"t2","executionStatus":"running","lastAgentMessageSequence":9,"lastReadMessageSequence":0,"updatedAt":"now"},
         {"id":"read","title":"Read","workId":"w2","sessionKind":"workChat","executionStatus":"completed","lastAgentMessageSequence":3,"lastReadMessageSequence":3,"updatedAt":"now"},
         {"id":"chat","title":"Chat","executionStatus":"idle","lastAgentMessageSequence":2,"lastReadMessageSequence":0,"updatedAt":"now"},
         {"id":"legacy","title":"Legacy","executionStatus":"completed","updatedAt":"now"}]
        """)
        workspace.rebuildGroups()
        #expect(workspace.unreadSessionIDs == ["done", "chat"])
        #expect(workspace.unreadWorkIDs == ["w1"])
        #expect(workspace.hasUnreadIndependentSessions)
        #expect(workspace.independentSessions.map(\.id) == ["chat", "legacy"])
    }

    @Test func openingSessionSubmitsReceiptOnceAndClearsDotLocally() async throws {
        let (workspace, defaults, name) = Self.workspace()
        defer { defaults.removePersistentDomain(forName: name) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ReadReceiptProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://read-receipt.invalid")!),
            bearerToken: "fixture", configuration: config)
        let connection = PadConnection(transportOverride: transport)
        workspace.sessions = try Self.sessions("""
        [{"id":"session:ok","title":"OK","workId":"w1","executionStatus":"completed","lastAgentMessageSequence":5,"lastReadMessageSequence":1,"updatedAt":"now"}]
        """)
        workspace.rebuildGroups()
        #expect(workspace.unreadSessionIDs == ["session:ok"])

        workspace.selection = "session:ok"
        workspace.acknowledgeOpenedSession(connection, isActive: false)
        #expect(workspace.unreadSessionIDs == ["session:ok"], "inactive scene never acknowledges")

        workspace.acknowledgeOpenedSession(connection, isActive: true)
        #expect(workspace.unreadSessionIDs.isEmpty, "the dot clears immediately")
        #expect(workspace.unreadWorkIDs.isEmpty)
        workspace.acknowledgeOpenedSession(connection, isActive: true)
        // The protocol log is process-wide (tests run in parallel); only this session's entries matter.
        let mine = { ReadReceiptProtocol.requests.filter { $0.contains("session:ok") } }
        for _ in 0..<200 where mine().isEmpty { try await Task.sleep(for: .milliseconds(2)) }
        try await Task.sleep(for: .milliseconds(20))
        #expect(mine() == ["/client/v1/sessions/session:ok/read-receipt:5"], "one receipt per sequence")

        // Newer agent output re-arms the dot until the next acknowledgement.
        workspace.sessions = try Self.sessions("""
        [{"id":"session:ok","title":"OK","workId":"w1","executionStatus":"completed","lastAgentMessageSequence":8,"lastReadMessageSequence":5,"updatedAt":"later"}]
        """)
        workspace.rebuildGroups()
        #expect(workspace.unreadSessionIDs == ["session:ok"])
    }

    @Test func failedReceiptRestoresUnreadState() async throws {
        let (workspace, defaults, name) = Self.workspace()
        defer { defaults.removePersistentDomain(forName: name) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ReadReceiptProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://read-receipt.invalid")!),
            bearerToken: "fixture", configuration: config)
        let connection = PadConnection(transportOverride: transport)
        workspace.sessions = try Self.sessions("""
        [{"id":"session:gone","title":"Gone","executionStatus":"completed","lastAgentMessageSequence":2,"lastReadMessageSequence":0,"updatedAt":"now"}]
        """)
        workspace.rebuildGroups()
        workspace.selection = "session:gone"
        workspace.acknowledgeOpenedSession(connection, isActive: true)
        #expect(workspace.unreadSessionIDs.isEmpty)
        for _ in 0..<500 where workspace.unreadSessionIDs.isEmpty { try await Task.sleep(for: .milliseconds(2)) }
        #expect(workspace.unreadSessionIDs == ["session:gone"], "rejected receipt rolls the local mark back")
        #expect(workspace.hasUnreadIndependentSessions)
    }
}

private final class ReadReceiptProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var requests: [String] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        let body = request.httpBody ?? request.httpBodyStream.map { stream -> Data in
            stream.open(); defer { stream.close() }
            var data = Data(); var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable { let read = stream.read(&buffer, maxLength: buffer.count); if read <= 0 { break }; data.append(buffer, count: read) }
            return data
        } ?? Data()
        let through = (try? JSONSerialization.jsonObject(with: body) as? [String: Int])?["throughSequence"] ?? -1
        Self.requests.append("\(path):\(through)")
        if path.contains("session:gone") {
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(#"{"code":"SESSION_NOT_AVAILABLE"}"#.utf8))
        } else {
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data("""
            {"schemaVersion":1,"sessionId":"session:ok","lastAgentMessageSequence":\(through),"lastReadMessageSequence":\(through)}
            """.utf8))
        }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
