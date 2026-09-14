import Foundation

/// Explicit endpoint ownership: no global URLSession overrides or automatic mutation retries.
public final class BackendTransport: Sendable {
    public let endpoint: BackendEndpoint
    private let session: URLSession
    private let bearerToken: String?
    private let pairingOnly: Bool

    public init(endpoint: BackendEndpoint, bearerToken: String? = nil, pairingOnly: Bool = false,
                configuration: URLSessionConfiguration = .ephemeral) throws {
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
        self.session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

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
        let (data, response) = try await session.data(for: prepare(request))
        return (data, try Self.requireSuccess(response))
    }

    public func bytes(for request: URLRequest) async throws -> (URLSession.AsyncBytes, HTTPURLResponse) {
        let (bytes, response) = try await session.bytes(for: prepare(request))
        return (bytes, try Self.requireSuccess(response))
    }

    private static func requireSuccess(_ response: URLResponse) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else { throw ClientConnectionError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw ClientConnectionError.httpStatus(http.statusCode) }
        return http
    }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? {
        // API redirects must be resolved explicitly, never replay bodies or tokens.
        nil
    }
}
