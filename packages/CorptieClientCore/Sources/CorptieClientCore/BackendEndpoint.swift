import Foundation

public enum ClientConnectionError: Error, Equatable, Sendable {
    case invalidEndpoint
    case insecureRemoteEndpoint
    case invalidCredential
    case outsideEndpoint
    case httpStatus(Int)
    case invalidResponse
}

/// An origin, not a filesystem path. No credentials, query, or proxy prefix in URLs.
public struct BackendEndpoint: Equatable, Sendable {
    public let baseURL: URL
    public let isLoopback: Bool

    public init(_ url: URL) throws {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let host = c.host?.lowercased(), !host.isEmpty,
              ["http", "https"].contains(c.scheme),
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
              c.path.isEmpty || c.path == "/",
              c.port.map({ (1...65535).contains($0) }) ?? true else {
            throw ClientConnectionError.invalidEndpoint
        }
        isLoopback = ["127.0.0.1", "::1", "[::1]", "localhost"].contains(host)
        guard c.scheme == "https" || isLoopback else { throw ClientConnectionError.insecureRemoteEndpoint }
        baseURL = url
    }

    public func contains(_ url: URL) -> Bool {
        guard let a = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              let b = URLComponents(url: url, resolvingAgainstBaseURL: false),
              b.user == nil, b.password == nil, b.fragment == nil else { return false }
        return a.scheme == b.scheme && a.host?.lowercased() == b.host?.lowercased()
            && (a.port ?? (a.scheme == "https" ? 443 : 80)) == (b.port ?? (b.scheme == "https" ? 443 : 80))
    }

    public func request(path: [String], query: [URLQueryItem] = []) throws -> URLRequest {
        guard path.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("/") && !$0.contains("\\") }) else {
            throw ClientConnectionError.invalidEndpoint
        }
        var url = baseURL
        for component in path { url.appendPathComponent(component) }
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        return URLRequest(url: components.url!)
    }
}
