import XCTest
import Foundation
import CryptoKit
@testable import CorptieClientSecurity

private actor LostAcknowledgementServer {
    var posts = 0
    let messageID: String
    init(_ messageID: String) { self.messageID = messageID }
    func respond(_ request: URLRequest) throws -> (Data, URLResponse) {
        if request.httpMethod == "POST" {
            posts += 1
            throw URLError(.networkConnectionLost)
        }
        let accepted = posts > 0
        let body: [String: Any] = accepted
            ? ["accepted": true, "messageId": messageID, "sessionId": "session"]
            : ["code": "MESSAGE_NOT_RECEIVED"]
        return (try JSONSerialization.data(withJSONObject: body), HTTPURLResponse(url: request.url!,
            statusCode: accepted ? 200 : 404, httpVersion: "HTTP/1.1", headerFields: nil)!)
    }
}
final class LoopbackMessageSenderTests: XCTestCase {
    func testCommittedMessageWithLostReplyIsReconciledWithoutSecondPost() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = ReliableMessageOutbox(directory: directory, key: SymmetricKey(size: .bits256))
        let messageID = "message:" + UUID().uuidString
        let server = LostAcknowledgementServer(messageID)
        let sender = LoopbackMessageSender(outbox: outbox, transport: { try await server.respond($0) })
        let base = URL(string: "http://127.0.0.1:47321")!
        var request = URLRequest(url: base.appending(path: "sessions/session/messages"))
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: ["messageId":messageID,"text":"hello"])
        let (_, response) = try await sender.send(request, baseURL: base, sessionID: "session", messageID: messageID)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let posts = await server.posts
        let remaining = try await outbox.all()
        XCTAssertEqual(posts, 1)
        XCTAssertTrue(remaining.isEmpty)
    }
}
