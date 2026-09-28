import Foundation
import XCTest
@testable import CorptieMac

@MainActor
final class FeishuSettingsStoreTests: XCTestCase {
    private func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FeishuStoreURLProtocol.self]
        return URLSession(configuration: config)
    }

    func testInvalidCredentialsDoNotSendOrEnterMutationState() async {
        let network = session()
        defer { network.invalidateAndCancel() }
        FeishuStoreURLProtocol.handler = { _ in
            XCTFail("Validation must precede the request")
            return (500, "{}")
        }
        var lastError: String?
        let store = FeishuSettingsStore(
            baseURL: URL(string: "http://127.0.0.1:9999")!, urlSession: network,
            currentError: { lastError }, publishError: { lastError = $0 },
            decodeError: { String(data: $0, encoding: .utf8) }
        )
        let accepted = await store.addFeishuBot(appId: " ", appSecret: " secret ")
        XCTAssertFalse(accepted)
        XCTAssertFalse(store.isUpdatingFeishu)
        XCTAssertNotNil(lastError)
    }

    func testMutationRefreshesItsOwnInventory() async {
        let network = session()
        defer { network.invalidateAndCancel() }
        FeishuStoreURLProtocol.handler = { request in
            if request.httpMethod == "POST" {
                XCTAssertEqual(request.url?.path, "/feishu/bots")
                XCTAssertEqual(request.value(forHTTPHeaderField: "content-type"), "application/json")
                return (200, "{}")
            }
            XCTAssertEqual(request.url?.path, "/feishu/bots")
            return (200, #"{"bots":[]}"#)
        }
        var lastError: String? = "old error"
        let store = FeishuSettingsStore(
            baseURL: URL(string: "http://127.0.0.1:9999")!, urlSession: network,
            currentError: { lastError }, publishError: { lastError = $0 },
            decodeError: { String(data: $0, encoding: .utf8) }
        )
        let accepted = await store.addFeishuBot(appId: " app ", appSecret: " secret ")
        XCTAssertTrue(accepted)
        XCTAssertEqual(store.feishuBots.count, 0)
        XCTAssertFalse(store.isUpdatingFeishu)
        XCTAssertNil(lastError)
    }

    func testProfileRefreshPreservesUnrelatedErrorAndClearsGatewayError() async {
        let network = session()
        defer { network.invalidateAndCancel() }
        FeishuStoreURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/feishu/profiles")
            return (200, #"{"profiles":[]}"#)
        }
        var lastError: String? = "Session unavailable"
        let store = FeishuSettingsStore(
            baseURL: URL(string: "http://127.0.0.1:9999")!, urlSession: network,
            currentError: { lastError }, publishError: { lastError = $0 },
            decodeError: { String(data: $0, encoding: .utf8) }
        )
        await store.loadFeishuProfiles()
        XCTAssertEqual(lastError, "Session unavailable")
        lastError = "Feishu unavailable"
        await store.loadFeishuProfiles()
        XCTAssertNil(lastError)
    }

    func testMutationFailureEndsBusyStateAndDoesNotRefreshInventory() async {
        let network = session()
        defer { network.invalidateAndCancel() }
        FeishuStoreURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            return (409, "gateway conflict")
        }
        var lastError: String?
        let store = FeishuSettingsStore(
            baseURL: URL(string: "http://127.0.0.1:9999")!, urlSession: network,
            currentError: { lastError }, publishError: { lastError = $0 },
            decodeError: { String(data: $0, encoding: .utf8) }
        )
        let accepted = await store.addFeishuBot(profile: " profile ")
        XCTAssertFalse(accepted)
        XCTAssertFalse(store.isUpdatingFeishu)
        XCTAssertEqual(lastError, "gateway conflict")
    }
}

private final class FeishuStoreURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, String))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, body) = try Self.handler!(request)
            let response = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}
