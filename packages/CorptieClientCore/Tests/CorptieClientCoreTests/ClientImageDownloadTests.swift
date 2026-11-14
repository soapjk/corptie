import Foundation
import CryptoKit
import Testing
@testable import CorptieClientCore

struct ClientImageDownloadTests {
    @Test func previewsNeverFetchRemoteOriginalsOrAcceptLegacyBytes() async throws {
        let endpoint = try BackendEndpoint(URL(string: "http://127.0.0.1")!)
        let api = ClientSessionAPI(transport: BackendTransport(endpoint: endpoint,
            data: { _ in throw URLError(.unsupportedURL) }, bytes: { request in
                #expect(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.contains(.init(name: "variant", value: "preview")) == true)
                let chunks = AsyncThrowingStream<Data, Error> { $0.yield(Data([1,2,3])); $0.finish() }
                return (BackendByteStream(chunks: chunks), HTTPURLResponse(url: request.url!, statusCode: 200,
                    httpVersion: nil, headerFields: ["Content-Length":"3"])!)
            }))
        let preview = ClientMessageImageResource(sessionID: "s", sourceItemID: "m", source: .managed(path: "owned"), variant: .preview)
        await #expect(throws: URLError.self) { try await api.messageImage(preview) }
        let remote = ClientMessageImageResource(sessionID: "s", sourceItemID: "m", source: .publicRemote(url: URL(string: "https://invalid.invalid/original")!), variant: .preview)
        await #expect(throws: URLError.self) { try await api.messageImage(remote) }
        #expect(ClientImageTransfer(resource: preview) == nil)
    }

    @Test func immutableImageResumesVerifiedOffsetAndChecksHash() async throws {
        let data = Data(repeating: 37, count: 32_768)
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let resource = ClientMessageImageResource(sessionID: "s", sourceItemID: "m",
            source: .messageReference(destination: "artifact:a?version=1&hash=\(hash)"))
        let transfer = try #require(ClientImageTransfer(resource: resource))
        let probe = DownloadProbe(data: data, hash: hash)
        let endpoint = try BackendEndpoint(URL(string: "http://127.0.0.1")!)
        let api = ClientSessionAPI(transport: BackendTransport(endpoint: endpoint,
            data: { _ in throw URLError(.unsupportedURL) }, bytes: { try await probe.read($0) }))
        await #expect(throws: URLError.self) { try await api.messageImage(resource, transfer: transfer) }
        let result = try await api.messageImage(resource, transfer: transfer)
        #expect(result == data)
        #expect(await probe.ranges == [nil, "bytes=16384-"])
    }

    @Test func invalidResumeHeadersCannotSpliceBytesAndLegacyResponseRestarts() throws {
        let hash = String(repeating: "a", count: 64)
        let resource = ClientMessageImageResource(sessionID: "s", sourceItemID: "m",
            source: .messageReference(destination: "artifact:a?version=1&hash=\(hash)"))
        let transfer = try #require(ClientImageTransfer(resource: resource))
        let url = URL(string: "http://127.0.0.1/image")!
        _ = try transfer.begin(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Length": "4"])!)
        try transfer.append(Data([1, 2]))
        #expect(transfer.prepare(URLRequest(url: url)).value(forHTTPHeaderField: "Range") == "bytes=2-")
        #expect(throws: URLError.self) {
            try transfer.begin(HTTPURLResponse(url: url, statusCode: 206, httpVersion: nil,
                headerFields: ["Content-Length": "2", "Content-Range": "bytes 1-2/4", "ETag": "\"\(hash)\""])!)
        }
        #expect(try transfer.begin(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Length": "4"])!) == 0)
        try transfer.append(Data([3, 4, 5, 6]))
        #expect(transfer.complete() == Data([3, 4, 5, 6]))
    }

    @Test func truncatedBodyDoesNotReportSuccess() async throws {
        let endpoint = try BackendEndpoint(URL(string: "http://127.0.0.1")!)
        let transport = BackendTransport(endpoint: endpoint, data: { _ in throw URLError(.unsupportedURL) }, bytes: { request in
            let stream = AsyncThrowingStream<Data, Error> { c in c.yield(Data([1, 2])); c.finish() }
            return (BackendByteStream(chunks: stream), HTTPURLResponse(url: request.url!, statusCode: 200,
                httpVersion: nil, headerFields: ["Content-Length": "3"])!)
        })
        await #expect(throws: URLError.self) { try await transport.imageData(for: endpoint.request(path: ["image"])) }
    }

    @Test func hashMismatchIsRejected() async throws {
        let endpoint = try BackendEndpoint(URL(string: "http://127.0.0.1")!)
        let transport = BackendTransport(endpoint: endpoint, data: { _ in throw URLError(.unsupportedURL) }, bytes: { request in
            let stream = AsyncThrowingStream<Data, Error> { c in c.yield(Data([1])); c.finish() }
            return (BackendByteStream(chunks: stream), HTTPURLResponse(url: request.url!, statusCode: 200,
                httpVersion: nil, headerFields: ["Content-Length": "1"])!)
        })
        let resource = ClientMessageImageResource(sessionID: "s", sourceItemID: "m",
            source: .messageReference(destination: "artifact:a?version=1&hash=\(String(repeating: "0", count: 64))"))
        await #expect(throws: URLError.self) { try await ClientSessionAPI(transport: transport).messageImage(resource) }
    }
}

private actor DownloadProbe {
    let data: Data
    let hash: String
    var ranges: [String?] = []
    init(data: Data, hash: String) { self.data = data; self.hash = hash }
    func read(_ request: URLRequest) throws -> (BackendByteStream, HTTPURLResponse) {
        let range = request.value(forHTTPHeaderField: "Range")
        ranges.append(range)
        let first = ranges.count == 1
        let chunk = first ? data.prefix(16_384) : data.suffix(16_384)
        let stream = AsyncThrowingStream<Data, Error> { c in
            c.yield(Data(chunk))
            if first { c.finish(throwing: URLError(.networkConnectionLost)) } else { c.finish() }
        }
        var headers = ["Content-Length": first ? "32768" : "16384", "ETag": "\"\(hash)\""]
        if !first { headers["Content-Range"] = "bytes 16384-32767/32768" }
        return (BackendByteStream(chunks: stream), HTTPURLResponse(url: request.url!, statusCode: first ? 200 : 206,
            httpVersion: nil, headerFields: headers)!)
    }
}
