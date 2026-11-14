import Foundation
import Security

public struct DevicePairingFailure: Error, Sendable {
    public let code: String
}

public struct ClientServiceFailure: Error, Equatable, Sendable {
    public let statusCode: Int
    public let code: String
    public let message: String?
    public let busyContext: ClientWorktreeBusyContext?

    public init(statusCode: Int, code: String, message: String? = nil, busyContext: ClientWorktreeBusyContext? = nil) {
        self.statusCode = statusCode
        self.code = code
        self.message = message == code ? nil : message
        self.busyContext = busyContext
    }
}

public struct BackendByteStream: AsyncSequence, Sendable {
    public typealias Element = UInt8
    fileprivate final class NativeOwner: Sendable {
        let bytes: URLSession.AsyncBytes
        init(_ bytes: URLSession.AsyncBytes) { self.bytes = bytes }
        deinit { bytes.task.cancel() }
    }
    public struct AsyncIterator: AsyncIteratorProtocol {
        private let owner: NativeOwner?
        private var native: URLSession.AsyncBytes.AsyncIterator?
        private var bytes: AsyncThrowingStream<UInt8, Error>.Iterator?
        private var chunks: AsyncThrowingStream<Data, Error>.Iterator?
        private var chunk = Data()
        private var offset = 0

        fileprivate init(native: NativeOwner) { owner = native; self.native = native.bytes.makeAsyncIterator() }
        fileprivate init(bytes: AsyncThrowingStream<UInt8, Error>.Iterator) { owner = nil; self.bytes = bytes }
        fileprivate init(chunks: AsyncThrowingStream<Data, Error>.Iterator) { owner = nil; self.chunks = chunks }

        public mutating func next() async throws -> UInt8? {
            if var native {
                let value = try await native.next()
                self.native = native
                return value
            }
            if var bytes {
                let value = try await bytes.next()
                self.bytes = bytes
                return value
            }
            if Task.isCancelled, var chunks {
                _ = try await chunks.next() // Deliver cancellation to the relay continuation.
                throw CancellationError()
            }
            if offset < chunk.count {
                defer { offset += 1 }
                return chunk[offset]
            }
            guard var chunks else { return nil }
            while let next = try await chunks.next() {
                if next.isEmpty { continue }
                chunk = next
                offset = 1
                self.chunks = chunks
                return chunk[0]
            }
            self.chunks = nil
            return nil
        }
    }

    private let native: NativeOwner?
    private let bytes: AsyncThrowingStream<UInt8, Error>?
    private let chunks: AsyncThrowingStream<Data, Error>?

    public init(_ stream: AsyncThrowingStream<UInt8, Error>) { native = nil; bytes = stream; chunks = nil }
    public init(chunks stream: AsyncThrowingStream<Data, Error>) { native = nil; bytes = nil; chunks = stream }
    fileprivate init(native: URLSession.AsyncBytes) { self.native = NativeOwner(native); bytes = nil; chunks = nil }
    public func makeAsyncIterator() -> AsyncIterator {
        if let native { return AsyncIterator(native: native) }
        if let bytes { return AsyncIterator(bytes: bytes.makeAsyncIterator()) }
        return AsyncIterator(chunks: chunks!.makeAsyncIterator())
    }

    fileprivate func collectImage(total: Int64?, maximum: Int = ClientImageDataCollector.maximum, progress: @escaping @Sendable (ClientImageProgress) -> Void, chunkReceived: @Sendable (Data) throws -> Void = { _ in }) async throws -> Data {
        guard let chunks else { return try await ClientImageDataCollector.collect(self, total: total, progress: progress, maximum: maximum, chunk: chunkReceived) }
        guard total == nil || total! <= maximum else { throw URLError(.dataLengthExceedsMaximum) }
        var data = Data(), last = ContinuousClock.now
        if let total { data.reserveCapacity(Int(total)) }
        progress(.init(received: 0, total: total))
        for try await chunk in chunks {
            try Task.checkCancellation()
            guard chunk.count <= maximum - data.count else { throw URLError(.dataLengthExceedsMaximum) }
            data.append(chunk)
            try chunkReceived(chunk)
            if last.duration(to: .now) >= .milliseconds(100) {
                last = .now
                progress(.init(received: Int64(data.count), total: total))
            }
        }
        try Task.checkCancellation()
        guard !data.isEmpty else { throw URLError(.zeroByteResource) }
        guard total == nil || Int64(data.count) == total else { throw URLError(.networkConnectionLost) }
        progress(.init(received: Int64(data.count), total: total))
        return data
    }
}

/// Explicit endpoint ownership: no global URLSession overrides or automatic mutation retries.
public final class BackendTransport: Sendable {
    private struct ServiceFailureBody: Decodable {
        let code: String
        let error: String?
        let message: String?
        let busyContext: ClientWorktreeBusyContext?
    }
    public typealias DataHandler = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
    public typealias ByteHandler = @Sendable (URLRequest) async throws -> (BackendByteStream, HTTPURLResponse)

    public let endpoint: BackendEndpoint
    private let session: URLSession?
    private let bearerToken: String?
    private let pairingOnly: Bool
    private let dataHandler: DataHandler?
    private let byteHandler: ByteHandler?

    public init(endpoint: BackendEndpoint, bearerToken: String? = nil, pairingOnly: Bool = false,
                configuration: URLSessionConfiguration = .ephemeral, certificate: String? = nil) throws {
        if let bearerToken {
            guard !bearerToken.isEmpty,
                  bearerToken.unicodeScalars.allSatisfy({ $0.value >= 33 && $0.value <= 126 }) else {
                throw ClientConnectionError.invalidCredential
            }
        } else if !endpoint.isLoopback && !pairingOnly {
            throw ClientConnectionError.invalidCredential
        }
        self.endpoint = endpoint
        self.bearerToken = bearerToken
        self.pairingOnly = pairingOnly
        let config = configuration.copy() as! URLSessionConfiguration
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.urlCache = nil
        let pin = try certificate.map { value -> Data in
            guard endpoint.baseURL.scheme == "https", let data = Data(base64Encoded: value),
                  SecCertificateCreateWithData(nil, data as CFData) != nil else { throw ClientConnectionError.invalidCredential }
            return data
        }
        self.session = URLSession(configuration: config,
            delegate: NoRedirects(host: endpoint.baseURL.host!, certificate: pin), delegateQueue: nil)
        dataHandler = nil
        byteHandler = nil
    }

    /// Provider-neutral request seam used by a secure relay. The caller still
    /// receives a normal BackendTransport and every URL remains origin-bound.
    public init(endpoint: BackendEndpoint, data: @escaping DataHandler, bytes: @escaping ByteHandler) {
        self.endpoint = endpoint
        self.session = nil
        self.bearerToken = nil
        self.pairingOnly = false
        self.dataHandler = data
        self.byteHandler = bytes
    }

    deinit { session?.invalidateAndCancel() }

    public func prepare(_ request: URLRequest) throws -> URLRequest {
        guard let url = request.url, endpoint.contains(url) else { throw ClientConnectionError.outsideEndpoint }
        if pairingOnly {
            guard request.httpMethod == "POST", url.query == nil,
                  ["/client/v1/pairing/claim", "/client/v1/pairing/exchange", "/client/v1/auth/refresh"].contains(url.path) else {
                throw ClientConnectionError.outsideEndpoint
            }
        }
        var request = request
        // Never forward caller-supplied credentials or cookies to a different context.
        request.setValue(nil, forHTTPHeaderField: "Cookie")
        request.setValue(bearerToken.map { "Bearer \($0)" }, forHTTPHeaderField: "Authorization")
        return request
    }

    public func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let prepared = try prepare(request)
        if let dataHandler {
            let (data, response) = try await dataHandler(prepared)
            if !(200..<300).contains(response.statusCode),
               let body = try? ClientDecodingDiagnostics.decode(ServiceFailureBody.self, from: data, context: "BackendTransport.errorBody") {
                throw ClientServiceFailure(statusCode: response.statusCode, code: body.code, message: body.message ?? body.error, busyContext: body.busyContext)
            }
            guard (200..<300).contains(response.statusCode) else {
                if response.statusCode >= 500 { ClientFailureDiagnostics.log(NSError(domain: "HTTP", code: response.statusCode, userInfo: ["responseBytes": data.count]), operation: "BackendTransport.dataResponse") }
                throw ClientConnectionError.httpStatus(response.statusCode)
            }
            return (data, response)
        }
        guard let session else { throw ClientConnectionError.invalidResponse }
        let (data, response) = try await session.data(for: prepared)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            ClientFailureDiagnostics.log(NSError(domain: "HTTP", code: http.statusCode, userInfo: ["responseBytes": data.count]), operation: "BackendTransport.httpFailure")
        }
        if pairingOnly, let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode),
           let body = try? ClientDecodingDiagnostics.decode(ServiceFailureBody.self, from: data, context: "BackendTransport.pairingErrorBody") {
            throw DevicePairingFailure(code: body.code)
        }
        if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode),
           let body = try? ClientDecodingDiagnostics.decode(ServiceFailureBody.self, from: data, context: "BackendTransport.errorBody") {
            throw ClientServiceFailure(statusCode: response.statusCode, code: body.code, message: body.message ?? body.error, busyContext: body.busyContext)
        }
        return (data, try Self.requireSuccess(response))
    }

    public func bytes(for request: URLRequest) async throws -> (BackendByteStream, HTTPURLResponse) {
        let prepared = try prepare(request)
        if let byteHandler {
            let (bytes, response) = try await byteHandler(prepared)
            try await Self.requireByteSuccess(bytes, response: response)
            return (bytes, response)
        }
        guard let session else { throw ClientConnectionError.invalidResponse }
        let (bytes, response) = try await session.bytes(for: prepared)
        guard let http = response as? HTTPURLResponse else { throw ClientConnectionError.invalidResponse }
        try await Self.requireByteSuccess(bytes, response: http)
        return (BackendByteStream(native: bytes), http)
    }

    /// Images retain relay chunks and native URLSession AsyncBytes directly.
    /// Do not pass a multi-megabyte body through the SSE per-byte stream adapter.
    public func imageData(for request: URLRequest, transfer: ClientImageTransfer? = nil, preview: Bool = false,
        progress: @escaping @Sendable (ClientImageProgress) -> Void = { _ in }) async throws -> Data {
        let prepared = try prepare(transfer?.prepare(request) ?? request)
        func length(_ response: HTTPURLResponse) -> Int64? {
            let encoding = response.value(forHTTPHeaderField: "Content-Encoding")?.lowercased()
            return response.expectedContentLength > 0 && (encoding == nil || encoding == "identity")
                ? response.expectedContentLength : nil
        }
        let stream: BackendByteStream
        let response: HTTPURLResponse
        if let byteHandler {
            (stream, response) = try await byteHandler(prepared)
        } else {
            guard let session else { throw ClientConnectionError.invalidResponse }
            let (native, rawResponse) = try await session.bytes(for: prepared)
            guard let http = rawResponse as? HTTPURLResponse else { throw ClientConnectionError.invalidResponse }
            stream = BackendByteStream(native: native); response = http
        }
        try await Self.requireByteSuccess(stream, response: response)
        if preview {
            guard response.value(forHTTPHeaderField: "X-Corptie-Image-Variant") == "preview",
                  response.expectedContentLength > 0, response.expectedContentLength <= 300 * 1024 else {
                throw URLError(.cannotDecodeContentData)
            }
        }
        let offset = try transfer?.begin(response) ?? 0
        let data = try await stream.collectImage(total: length(response), maximum: preview ? 300 * 1024 : ClientImageDataCollector.maximum, progress: { value in
            progress(.init(received: offset + value.received, total: value.total.map { offset + $0 }))
        }, chunkReceived: { try transfer?.append($0) })
        return transfer?.complete() ?? data
    }

    // Relay GETs use the streaming path too. Preserve their structured error
    // codes (notably COMMAND_NOT_FOUND) instead of turning a normal 404 into
    // LOCAL_BACKEND_UNAVAILABLE. Successful streams remain unbuffered.
    private static func requireByteSuccess<Bytes: AsyncSequence>(_ bytes: Bytes,
        response: HTTPURLResponse) async throws where Bytes.Element == UInt8 {
        guard !(200..<300).contains(response.statusCode) else { return }
        if response.statusCode >= 500 {
            ClientFailureDiagnostics.log(NSError(domain: "HTTP", code: response.statusCode), operation: "BackendTransport.byteResponse")
        }
        var body = Data()
        for try await byte in bytes {
            guard body.count < 64 * 1024 else { throw ClientConnectionError.httpStatus(response.statusCode) }
            body.append(byte)
        }
        if let failure = try? ClientDecodingDiagnostics.decode(ServiceFailureBody.self, from: body, context: "BackendTransport.streamErrorBody") {
            throw ClientServiceFailure(statusCode: response.statusCode, code: failure.code, message: failure.message ?? failure.error, busyContext: failure.busyContext)
        }
        throw ClientConnectionError.httpStatus(response.statusCode)
    }

    private static func requireSuccess(_ response: URLResponse) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else { throw ClientConnectionError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode >= 500 { ClientFailureDiagnostics.log(NSError(domain: "HTTP", code: http.statusCode), operation: "BackendTransport.response") }
            throw ClientConnectionError.httpStatus(http.statusCode)
        }
        return http
    }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    let host: String
    let certificate: Data?
    init(host: String, certificate: Data?) { self.host = host; self.certificate = certificate }

    /// Server-trust challenges belong to the task delegate. In particular,
    /// `URLSession.bytes(for:)` does not route them through the session-level
    /// challenge callback on iOS, which previously made pinned SSE requests
    /// fail while ordinary `data(for:)` requests appeared healthy.
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let certificate else { completionHandler(.performDefaultHandling, nil); return }
        guard challenge.protectionSpace.host.lowercased() == host.lowercased(),
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first,
              (SecCertificateCopyData(leaf) as Data) == certificate,
              let anchor = SecCertificateCreateWithData(nil, certificate as CFData),
              SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
              SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil) else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? {
        // API redirects must be resolved explicitly, never replay bodies or tokens.
        nil
    }
}
