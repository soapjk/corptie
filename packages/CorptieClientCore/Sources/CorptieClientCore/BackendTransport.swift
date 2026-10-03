import Foundation
import Security

public struct DevicePairingFailure: Error, Sendable {
    public let code: String
}

public struct ClientServiceFailure: Error, Equatable, Sendable {
    public let statusCode: Int
    public let code: String

    public init(statusCode: Int, code: String) {
        self.statusCode = statusCode
        self.code = code
    }
}

public struct BackendByteStream: AsyncSequence, Sendable {
    public typealias Element = UInt8
    private let stream: AsyncThrowingStream<UInt8, Error>

    public init(_ stream: AsyncThrowingStream<UInt8, Error>) { self.stream = stream }
    public func makeAsyncIterator() -> AsyncThrowingStream<UInt8, Error>.Iterator { stream.makeAsyncIterator() }
}

/// Explicit endpoint ownership: no global URLSession overrides or automatic mutation retries.
public final class BackendTransport: Sendable {
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
               let body = try? JSONDecoder().decode([String: String].self, from: data), let code = body["code"] {
                throw ClientServiceFailure(statusCode: response.statusCode, code: code)
            }
            guard (200..<300).contains(response.statusCode) else { throw ClientConnectionError.httpStatus(response.statusCode) }
            return (data, response)
        }
        guard let session else { throw ClientConnectionError.invalidResponse }
        let (data, response) = try await session.data(for: prepared)
        if pairingOnly, let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode),
           let body = try? JSONDecoder().decode([String: String].self, from: data), let code = body["code"] {
            throw DevicePairingFailure(code: code)
        }
        if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode),
           let body = try? JSONDecoder().decode([String: String].self, from: data), let code = body["code"] {
            throw ClientServiceFailure(statusCode: response.statusCode, code: code)
        }
        return (data, try Self.requireSuccess(response))
    }

    public func bytes(for request: URLRequest) async throws -> (BackendByteStream, HTTPURLResponse) {
        let prepared = try prepare(request)
        if let byteHandler {
            let (bytes, response) = try await byteHandler(prepared)
            guard (200..<300).contains(response.statusCode) else { throw ClientConnectionError.httpStatus(response.statusCode) }
            return (bytes, response)
        }
        guard let session else { throw ClientConnectionError.invalidResponse }
        let (bytes, response) = try await session.bytes(for: prepared)
        let http = try Self.requireSuccess(response)
        let stream = AsyncThrowingStream<UInt8, Error> { continuation in
            let task = Task {
                do {
                    for try await byte in bytes { continuation.yield(byte) }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        return (BackendByteStream(stream), http)
    }

    private static func requireSuccess(_ response: URLResponse) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else { throw ClientConnectionError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ClientConnectionError.httpStatus(http.statusCode) }
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
