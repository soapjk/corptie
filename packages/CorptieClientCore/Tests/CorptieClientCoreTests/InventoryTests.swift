import Foundation
import Testing
@testable import CorptieClientCore

struct InventoryTests {
    @Test func inventoryPresentationFieldsDecodeAdditively() throws {
        let decoder = JSONDecoder()
        let legacyWork = try decoder.decode(ClientWork.self,
            from: Data(#"{"id":"work:1","name":"W","status":"active","updatedAt":"now"}"#.utf8))
        #expect(legacyWork.hasAvatar == false)
        let work = try decoder.decode(ClientWork.self,
            from: Data(#"{"id":"work:1","name":"W","status":"active","hasAvatar":true,"updatedAt":"now"}"#.utf8))
        #expect(work.hasAvatar == true)
        #expect(work != legacyWork)

        let legacyTask = try decoder.decode(ClientTask.self,
            from: Data(#"{"id":"task:1","title":"T","workId":"work:1","lifecycleState":"active","executionStatus":"idle","currentSessionId":null,"updatedAt":"now"}"#.utf8))
        #expect(legacyTask.hasPendingScheduledWake == false)
        #expect(legacyTask.autoTitleEnabled == true)
        #expect(legacyTask.deletionStatus == nil)
        let task = try decoder.decode(ClientTask.self,
            from: Data(#"{"id":"task:1","title":"T","autoTitleEnabled":false,"workId":"work:1","lifecycleState":"active","executionStatus":"idle","currentSessionId":"session:1","hasPendingScheduledWake":true,"deletionStatus":"deleting","updatedAt":"now"}"#.utf8))
        #expect(task.hasPendingScheduledWake == true)
        #expect(task.autoTitleEnabled == false)
        #expect(task.deletionStatus == "deleting")
        #expect(task.currentSessionId == "session:1")

        let legacySession = try decoder.decode(ClientSession.self,
            from: Data(#"{"id":"session:1","title":"S","executionStatus":"completed","updatedAt":"now"}"#.utf8))
        #expect(legacySession.lastAgentMessageSequence == 0)
        #expect(legacySession.lastReadMessageSequence == 0)
        #expect(legacySession.needsUserAttention == false)
        let session = try decoder.decode(ClientSession.self,
            from: Data(#"{"id":"session:1","title":"S","workId":"work:1","taskId":"task:1","sessionKind":"task","executionStatus":"completed","activityStatus":null,"lastAgentMessageSequence":7,"lastReadMessageSequence":3,"updatedAt":"now"}"#.utf8))
        #expect(session.needsUserAttention == true)
        #expect(session.lastAgentMessageSequence == 7)
    }

    @Test func readAttentionMirrorsDesktopPolicy() {
        #expect(SessionReadAttention.needsUserAttention(executionStatus: "complete", lastAgentMessageSequence: 2, lastReadMessageSequence: 1))
        #expect(SessionReadAttention.needsUserAttention(executionStatus: "idle", lastAgentMessageSequence: 2, lastReadMessageSequence: 1))
        #expect(!SessionReadAttention.needsUserAttention(executionStatus: "running", lastAgentMessageSequence: 2, lastReadMessageSequence: 1))
        #expect(!SessionReadAttention.needsUserAttention(executionStatus: "complete", lastAgentMessageSequence: 2, lastReadMessageSequence: 2))
        #expect(SessionReadAttention.sequenceForOpenedSession(lastAgentMessageSequence: 5, lastReadMessageSequence: 2, alreadySubmittedSequence: nil) == 5)
        #expect(SessionReadAttention.sequenceForOpenedSession(lastAgentMessageSequence: 5, lastReadMessageSequence: 2, alreadySubmittedSequence: 5) == nil)
        #expect(SessionReadAttention.sequenceForOpenedSession(lastAgentMessageSequence: 5, lastReadMessageSequence: 5, alreadySubmittedSequence: nil) == nil)
        #expect(SessionReadAttention.sequenceForOpenedSession(lastAgentMessageSequence: 0, lastReadMessageSequence: 0, alreadySubmittedSequence: nil) == nil)
    }

    @Test func readReceiptPostsThroughSequence() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ReadReceiptProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://unit-test.invalid")!),
            bearerToken: "test-only", configuration: config)
        let receipt = try await ClientSessionAPI(transport: transport).readReceipt(sessionId: "session:one", throughSequence: 9)
        #expect(receipt == ClientReadReceipt(schemaVersion: 1, sessionId: "session:one", lastAgentMessageSequence: 9, lastReadMessageSequence: 9))
    }

    @Test func workAvatarUsesScopedRouteAndTreatsMissingAsNil() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AvatarProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://unit-test.invalid")!),
            bearerToken: "test-only", configuration: config)
        let inventory = ClientInventory(transport: transport)
        let found = try await inventory.workAvatar(id: "work:one")
        #expect(found?.contentType == "image/png")
        #expect(found?.data == Data([0x89, 0x50, 0x4E, 0x47]))
        #expect(try await inventory.workAvatar(id: "work:two") == nil)
        await #expect(throws: ClientConnectionError.self) { try await inventory.workAvatar(id: "../secret") }
    }
}

private final class AvatarProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-only")
        #expect(request.httpMethod == "GET")
        #expect(request.url?.query == nil)
        let path = request.url!.path
        if path == "/client/v1/works/work:one/avatar" {
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                headerFields: ["Content-Type": "image/png"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data([0x89, 0x50, 0x4E, 0x47]))
        } else {
            #expect(path == "/client/v1/works/work:two/avatar")
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(#"{"code":"AVATAR_NOT_FOUND"}"#.utf8))
        }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class ReadReceiptProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/client/v1/sessions/session:one/read-receipt")
        #expect(request.url?.query == nil)
        let body = request.httpBody ?? request.httpBodyStream.map { stream -> Data in
            stream.open(); defer { stream.close() }
            var data = Data(); var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable { let read = stream.read(&buffer, maxLength: buffer.count); if read <= 0 { break }; data.append(buffer, count: read) }
            return data
        } ?? Data()
        #expect(String(decoding: body, as: UTF8.self) == #"{"throughSequence":9}"#)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"schemaVersion":1,"sessionId":"session:one","lastAgentMessageSequence":9,"lastReadMessageSequence":9}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
