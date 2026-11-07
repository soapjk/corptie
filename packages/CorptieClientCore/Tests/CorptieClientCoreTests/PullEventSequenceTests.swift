import Foundation
import Testing
@testable import CorptieClientCore

private actor PullByteSource {
    let bytes: [UInt8]
    var reads = 0
    init(_ text: String) { bytes = Array(text.utf8) }
    func next() -> UInt8? {
        guard reads < bytes.count else { return nil }
        defer { reads += 1 }
        return bytes[reads]
    }
}
private struct PullBytes: AsyncSequence, Sendable {
    typealias Element = UInt8
    let source: PullByteSource
    struct AsyncIterator: AsyncIteratorProtocol {
        let source: PullByteSource
        mutating func next() async throws -> UInt8? { try Task.checkCancellation(); return await source.next() }
    }
    func makeAsyncIterator() -> AsyncIterator { AsyncIterator(source: source) }
}
struct PullEventSequenceTests {
    @Test func slowConsumerDoesNotReadAheadAndEventsStayOrdered() async throws {
        let first = "id: 1\ndata: 你好\n\n"
        let source = PullByteSource(first + "id: 2\ndata: second\n\n" + String(repeating: "data: later\n\n", count: 1000))
        var events = ServerSentEventStream.events(from: PullBytes(source: source)).makeAsyncIterator()
        #expect(await source.reads == 0)
        #expect(try await events.next()?.data == "你好")
        #expect(await source.reads == first.utf8.count)
        for _ in 0..<20 { await Task.yield() }
        #expect(await source.reads == first.utf8.count)
        #expect(try await events.next()?.id == "2")
    }
    @Test func cancellationPreventsFurtherReads() async throws {
        let source = PullByteSource("data: must-not-read\n\n")
        let task = Task {
            while !Task.isCancelled { await Task.yield() }
            var events = ServerSentEventStream.events(from: PullBytes(source: source)).makeAsyncIterator()
            return try await events.next()
        }
        task.cancel()
        do { _ = try await task.value; Issue.record("Expected cancellation") }
        catch is CancellationError { }
        #expect(await source.reads == 0)
    }
    @Test func commentsAndFinalFrameAreDeliveredOnce() async throws {
        let source = PullByteSource(": heartbeat\r\n\r\ndata: final 中文")
        var events = ServerSentEventStream.events(from: PullBytes(source: source)).makeAsyncIterator()
        #expect(try await events.next()?.isComment == true)
        #expect(try await events.next()?.data == "final 中文")
        #expect(try await events.next() == nil)
        #expect(try await events.next() == nil)
    }
}

private final class NativePullProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
            httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("id: 1\ndata: native\n\nid: 2\ndata: second\n\n".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}
extension PullEventSequenceTests {
    @Test func nativeTransportBytesRemainReadableWithoutIntermediateProducer() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [NativePullProtocol.self]
        let endpoint = try BackendEndpoint(URL(string: "http://127.0.0.1:54321")!)
        let transport = try BackendTransport(endpoint: endpoint, configuration: config)
        let (bytes, _) = try await transport.bytes(for: endpoint.request(path: ["events"]))
        var events = ServerSentEventStream.events(from: bytes).makeAsyncIterator()
        #expect(try await events.next()?.data == "native")
        #expect(try await events.next()?.id == "2")
        #expect(try await events.next() == nil)
    }
}
