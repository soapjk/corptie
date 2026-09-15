import Foundation

public struct DevicePairingClaim: Codable, Sendable {
    public let pairingId: String
    public let exchangeSecret: String
    public let status: String
    public let expiresAt: Double
}

/// Secrets must be stored by the platform Keychain owner, never UserDefaults or logs.
public struct DeviceCredentials: Codable, Sendable {
    public var certificate: String?
    public let serverId: String
    public let deviceId: String
    public let accessToken: String
    public let refreshToken: String
    public let accessExpiresAt: Double
    public let refreshExpiresAt: Double
}

public struct DevicePairingClient: Sendable {
    private let transport: BackendTransport
    public init(endpoint: BackendEndpoint, certificate: String? = nil) throws {
        guard endpoint.baseURL.scheme == "https" else { throw ClientConnectionError.insecureRemoteEndpoint }
        transport = try BackendTransport(endpoint: endpoint, pairingOnly: true, certificate: certificate)
    }

    public func claim(pairingId: String, pairingSecret: String, name: String) async throws -> DevicePairingClaim {
        try await post("pairing/claim", body: ["pairingId": pairingId, "pairingSecret": pairingSecret, "name": name])
    }

    public func exchange(_ claim: DevicePairingClaim) async throws -> DeviceCredentials {
        try await post("pairing/exchange", body: ["pairingId": claim.pairingId, "exchangeSecret": claim.exchangeSecret])
    }

    public func refresh(_ credentials: DeviceCredentials) async throws -> DeviceCredentials {
        try await post("auth/refresh", body: ["refreshToken": credentials.refreshToken])
    }

    private func post<T: Decodable>(_ path: String, body: [String: String]) async throws -> T {
        var request = try transport.endpoint.request(path: ["client", "v1"] + path.split(separator: "/").map(String.init))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, _) = try await transport.data(for: request)
        return try JSONDecoder().decode(T.self, from: data)
    }
}
