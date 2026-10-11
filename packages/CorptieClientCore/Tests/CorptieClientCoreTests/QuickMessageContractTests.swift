import Foundation
import Testing
@testable import CorptieClientCore

@MainActor
struct QuickMessageContractTests {
    private func result(_ count: Int, version: Int = 1) throws -> ClientQuickMessageRecommendations {
        try JSONDecoder().decode(ClientQuickMessageRecommendations.self, from: QuickMessageProtocol.payload(count, version: version))
    }

    @Test func bothClientContractsAcceptEightAndRejectOversizedOrUnknownVersions() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [QuickMessageProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://quick.invalid")!),
            bearerToken: "fixture", configuration: config)
        let api = ClientSessionAPI(transport: transport)
        for count in [3, 6, 7, 8] {
            #expect(try result(count).validated().items.count == count)
            #expect(try await api.quickMessages(sessionId: "\(count)").items.count == count)
        }
        #expect(throws: ClientConnectionError.self) { try result(9).validated() }
        #expect(throws: ClientConnectionError.self) { try result(3, version: 2).validated() }
        await #expect(throws: ClientConnectionError.self) { try await api.quickMessages(sessionId: "9") }
        await #expect(throws: ClientConnectionError.self) { try await api.quickMessages(sessionId: "version2") }
    }

    @Test func oldSixAndColdStartSnapshotsCanBeReplacedByEightWithoutClearingHistory() throws {
        let suite = "quick-contract-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let cache = ClientQuickMessageCache(defaults: defaults)
        cache.remember(try result(3).items + ClientQuickMessage.defaults, for: "old")
        #expect(cache.items(for: "old").count == 6)
        #expect(cache.items(for: "new") == ClientQuickMessage.defaults)
        for scope in ["old", "new"] {
            #expect(cache.remember(try result(8).validated().items, for: scope).count == 8)
            #expect(ClientQuickMessageCache(defaults: defaults).items(for: scope).count == 8)
        }
    }

    @Test func invalidationIsScopedAcrossSessionsAndRecoveryDoesNotClearCachedItems() throws {
        let suite = "quick-signals-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let cache = ClientQuickMessageCache(defaults: defaults)
        let a = ClientQuickMessageCache.scope(host: "host", taskID: "task:a", sessionID: "s1")
        let b = ClientQuickMessageCache.scope(host: "host", taskID: "task:b", sessionID: "s2")
        #expect(cache.revision(for: a) == 0 && cache.revision(for: b) == 0)
        let items = cache.remember(try result(8).items, for: a)
        cache.invalidate(host: "host", taskID: "task:a", sessionID: "s3")
        #expect(cache.revision(for: a) == 1 && cache.revision(for: b) == 0)
        cache.connectionRecovered()
        #expect(cache.revision(for: a) == 2 && cache.revision(for: b) == 1)
        #expect(cache.items(for: a) == items)
        let frame = Data(#"{"payload":{"schemaVersion":1,"sessionId":"s3","taskId":"task:a"}}"#.utf8)
        #expect(try ClientQuickMessageInvalidation.decodeEnvelope(frame).taskId == "task:a")
        #expect(throws: ClientConnectionError.self) {
            try ClientQuickMessageInvalidation.decodeEnvelope(Data(#"{"payload":{"schemaVersion":2,"sessionId":"s3"}}"#.utf8))
        }
    }

    @Test func parallelScopeReadsShareOneRequestAndFailuresPermitRetry() async throws {
        let suite = "quick-flight-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let cache = ClientQuickMessageCache(defaults: defaults)
        let expected = try result(8)
        @MainActor final class Counter { var calls = 0 }
        let counter = Counter()
        let load: @MainActor @Sendable () async throws -> ClientQuickMessageRecommendations = {
            counter.calls += 1
            try await Task.sleep(for: .milliseconds(30))
            return expected
        }
        async let first = cache.read(scope: "a", load: load)
        async let second = cache.read(scope: "a", load: load)
        let values = try await (first, second)
        #expect(values.0 == expected && values.1 == expected)
        #expect(counter.calls == 1 && cache.inFlightCount == 0)
        await #expect(throws: URLError.self) {
            try await cache.read(scope: "a") { throw URLError(.notConnectedToInternet) }
        }
        #expect(cache.inFlightCount == 0)
        #expect(try await cache.read(scope: "a", load: load) == expected)
        #expect(counter.calls == 2)
    }

    @Test func invalidationCancelsPreChangeFlightSoFreshReadersCannotJoinStaleRequest() async throws {
        let suite = "quick-stale-flight-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let cache = ClientQuickMessageCache(defaults: defaults)
        let scope = ClientQuickMessageCache.scope(host: "host", taskID: "task:a", sessionID: "s")
        let old = try result(6), fresh = try result(8)
        let waiter = Task { @MainActor in
            try await cache.read(scope: scope) {
                try await Task.sleep(for: .seconds(10))
                return old
            }
        }
        for _ in 0..<100 {
            if cache.inFlightCount == 1 { break }
            await Task.yield()
        }
        #expect(cache.inFlightCount == 1)
        cache.invalidate(host: "host", taskID: "task:a", sessionID: "s")
        #expect(try await cache.read(scope: scope) { fresh } == fresh)
        await #expect(throws: CancellationError.self) { try await waiter.value }
        #expect(cache.inFlightCount == 0)
    }
}

private final class QuickMessageProtocol: URLProtocol, @unchecked Sendable {
    static func payload(_ count: Int, version: Int = 1) -> Data {
        let items = (0..<count).map { ["id": "q\($0)", "text": "指令\($0)", "scope": "task", "count": 3] as [String: Any] }
        return try! JSONSerialization.data(withJSONObject: ["schemaVersion": version, "taskId": "task:a", "items": items])
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let id = request.url!.pathComponents.dropLast().last ?? ""
        let data = Self.payload(Int(id) ?? 3, version: id == "version2" ? 2 : 1)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
            httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
