import CryptoKit
import Foundation
import Security

public enum CloudOAuthError: Error, Equatable, Sendable {
    case invalidConfiguration
    case invalidCallback
    case stateMismatch
    case authorizationDenied(String)
    case invalidTokenResponse
}

/// Only an explicit OAuth invalid_grant response invalidates a saved refresh token.
/// A gateway/configuration error must not silently sign the user out.
public enum CloudOAuthRefreshError: Error, Equatable, Sendable {
    case invalidGrant
}

public struct CloudOAuthConfiguration: Equatable, Sendable {
    public let endpoint: BackendEndpoint
    public let clientID: String
    public let redirectURI: URL
    public let scopes: [String]
    public let resource: URL

    public init(endpoint: BackendEndpoint, clientID: String, redirectURI: URL, scopes: [String], resource: URL) throws {
        guard endpoint.baseURL.scheme == "https" || endpoint.isLoopback,
              !clientID.isEmpty, clientID.count <= 256,
              redirectURI.user == nil, redirectURI.password == nil, redirectURI.fragment == nil,
              let redirectScheme = redirectURI.scheme,
              redirectScheme == "corptie" || (redirectScheme == "http" && ["127.0.0.1", "::1", "localhost"].contains(redirectURI.host?.lowercased() ?? "")),
              !scopes.isEmpty, scopes.allSatisfy({ Self.isToken($0) }),
              resource.scheme == "https" || (resource.scheme == "http" && ["127.0.0.1", "::1", "localhost"].contains(resource.host?.lowercased() ?? "")),
              endpoint.contains(resource) else { throw CloudOAuthError.invalidConfiguration }
        self.endpoint = endpoint
        self.clientID = clientID
        self.redirectURI = redirectURI
        self.scopes = Array(Set(scopes)).sorted()
        self.resource = resource
    }

    private static func isToken(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.allSatisfy { byte in
            byte == 0x21 || (0x23...0x5B).contains(byte) || (0x5D...0x7E).contains(byte)
        }
    }
}

public enum CorptieCloudService {
    public static let productionBaseURL = URL(string: "https://corptie.llmay.cn")!
    public static let nativeScopes = [
        "openid", "profile", "email", "offline_access", "devices:read", "devices:write",
        "devices:manage", "connections:read", "connections:write"
    ]

    public static func nativeOAuth(clientID: String, developmentBaseURL: String? = nil) throws -> CloudOAuthConfiguration {
        let baseURL: URL
        if let developmentBaseURL, !developmentBaseURL.isEmpty {
            guard let candidate = URL(string: developmentBaseURL) else { throw CloudOAuthError.invalidConfiguration }
            baseURL = candidate
        } else {
            baseURL = productionBaseURL
        }
        let endpoint = try BackendEndpoint(baseURL)
        return try CloudOAuthConfiguration(
            endpoint: endpoint,
            clientID: clientID,
            redirectURI: URL(string: "corptie://oauth/callback")!,
            scopes: nativeScopes,
            resource: endpoint.baseURL.appending(path: "v1")
        )
    }
}

public struct CloudOAuthAuthorization: Equatable, Sendable {
    public let url: URL
    public let verifier: String
    public let state: String

    public init(configuration: CloudOAuthConfiguration) throws {
        try self.init(
            configuration: configuration,
            verifier: Self.randomBase64URL(byteCount: 32),
            state: Self.randomBase64URL(byteCount: 32)
        )
    }

    public init(configuration: CloudOAuthConfiguration, verifier: String, state: String) throws {
        guard (43...128).contains(verifier.utf8.count), Self.isBase64URL(verifier),
              state.utf8.count >= 32, Self.isBase64URL(state) else { throw CloudOAuthError.invalidConfiguration }
        let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        var components = URLComponents(
            url: configuration.endpoint.baseURL.appending(path: "api/auth/oauth2/authorize"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: configuration.clientID),
            URLQueryItem(name: "redirect_uri", value: configuration.redirectURI.absoluteString),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: configuration.scopes.joined(separator: " ")),
            URLQueryItem(name: "resource", value: configuration.resource.absoluteString),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state)
        ]
        guard let url = components.url else { throw CloudOAuthError.invalidConfiguration }
        self.url = url
        self.verifier = verifier
        self.state = state
    }

    public func code(from callback: URL, configuration: CloudOAuthConfiguration) throws -> String {
        guard Self.sameRedirect(callback, configuration.redirectURI),
              let components = URLComponents(url: callback, resolvingAgainstBaseURL: false) else {
            throw CloudOAuthError.invalidCallback
        }
        let values = Dictionary(grouping: components.queryItems ?? [], by: \.name)
        guard values.values.allSatisfy({ $0.count == 1 }) else { throw CloudOAuthError.invalidCallback }
        guard values["state"]?.first?.value == state else { throw CloudOAuthError.stateMismatch }
        if let error = values["error"]?.first?.value {
            throw CloudOAuthError.authorizationDenied(error)
        }
        guard let code = values["code"]?.first?.value, !code.isEmpty else { throw CloudOAuthError.invalidCallback }
        return code
    }

    private static func randomBase64URL(byteCount: Int) throws -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw CloudOAuthError.invalidConfiguration
        }
        return base64URL(Data(bytes))
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private static func isBase64URL(_ value: String) -> Bool {
        value.utf8.allSatisfy { (0x41...0x5A).contains($0) || (0x61...0x7A).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2D || $0 == 0x5F }
    }

    private static func sameRedirect(_ callback: URL, _ expected: URL) -> Bool {
        guard let callback = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              let expected = URLComponents(url: expected, resolvingAgainstBaseURL: false) else { return false }
        return callback.scheme?.lowercased() == expected.scheme?.lowercased()
            && callback.host?.lowercased() == expected.host?.lowercased()
            && callback.port == expected.port && callback.path == expected.path
            && callback.user == nil && callback.password == nil && callback.fragment == nil
    }
}

public struct CloudOAuthTokens: Codable, Equatable, Sendable {
    public let accessToken: String
    public let refreshToken: String?
    public let tokenType: String
    public let expiresAt: Date
    public let scope: String

    public var isNearExpiry: Bool { expiresAt <= Date().addingTimeInterval(60) }
}

public struct CloudOAuthTokenClient: Sendable {
    private let configuration: CloudOAuthConfiguration
    private let session: URLSession
    private let now: @Sendable () -> Date

    public init(
        configuration: CloudOAuthConfiguration,
        session: URLSession? = nil,
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.configuration = configuration
        self.session = session ?? URLSession(configuration: .ephemeral, delegate: CloudOAuthNoRedirects(), delegateQueue: nil)
        self.now = now
    }

    public func exchange(code: String, verifier: String) async throws -> CloudOAuthTokens {
        try await request([
            "grant_type": "authorization_code", "client_id": configuration.clientID,
            "code": code, "redirect_uri": configuration.redirectURI.absoluteString,
            "code_verifier": verifier, "resource": configuration.resource.absoluteString
        ], priorRefreshToken: nil)
    }

    public func refresh(_ tokens: CloudOAuthTokens) async throws -> CloudOAuthTokens {
        guard let refreshToken = tokens.refreshToken, !refreshToken.isEmpty else { throw CloudOAuthRefreshError.invalidGrant }
        return try await request([
            "grant_type": "refresh_token", "client_id": configuration.clientID,
            "refresh_token": refreshToken, "resource": configuration.resource.absoluteString
        ], priorRefreshToken: refreshToken)
    }

    private func request(_ fields: [String: String], priorRefreshToken: String?) async throws -> CloudOAuthTokens {
        var request = try configuration.endpoint.request(path: ["api", "auth", "oauth2", "token"])
        request.timeoutInterval = 15
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = fields.sorted(by: { $0.key < $1.key }).map(URLQueryItem.init)
        request.httpBody = form.percentEncodedQuery?.data(using: .utf8)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            if priorRefreshToken != nil, (response as? HTTPURLResponse)?.statusCode == 400,
               data.count <= 16_384,
               let failure = try? JSONDecoder().decode(OAuthFailure.self, from: data),
               failure.error == "invalid_grant" {
                throw CloudOAuthRefreshError.invalidGrant
            }
            throw ClientConnectionError.httpStatus((response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        let payload = try JSONDecoder().decode(TokenResponse.self, from: data)
        guard !payload.accessToken.isEmpty, payload.expiresIn > 0,
              payload.tokenType.caseInsensitiveCompare("Bearer") == .orderedSame else {
            throw CloudOAuthError.invalidTokenResponse
        }
        return CloudOAuthTokens(
            accessToken: payload.accessToken,
            refreshToken: payload.refreshToken ?? priorRefreshToken,
            tokenType: "Bearer",
            expiresAt: now().addingTimeInterval(TimeInterval(payload.expiresIn)),
            scope: payload.scope ?? configuration.scopes.joined(separator: " ")
        )
    }
}

private struct OAuthFailure: Decodable { let error: String }

private struct TokenResponse: Decodable {
    let accessToken: String
    let refreshToken: String?
    let tokenType: String
    let expiresIn: Int
    let scope: String?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case tokenType = "token_type"
        case expiresIn = "expires_in"
        case scope
    }
}

private final class CloudOAuthNoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? { nil }
}
