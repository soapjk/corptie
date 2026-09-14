import Foundation

/// An ephemeral invitation, never an access token. Camera payloads are untrusted
/// until decoded and validated. Do not persist/log this value or open it as a URL.
public struct DevicePairingCode: Codable, Sendable, Equatable {
    public let type: String
    public let version: Int
    public let address: String
    public let serverId: String
    public let pairingId: String
    public let pairingSecret: String
    public let expiresAt: Double

    public init(address: String, serverId: String, pairingId: String, pairingSecret: String, expiresAt: Double) {
        type = "corptie-device-pairing"; version = 1
        self.address = address; self.serverId = serverId; self.pairingId = pairingId
        self.pairingSecret = pairingSecret; self.expiresAt = expiresAt
    }

    public func validate(now: Date = .now) throws {
        guard type == "corptie-device-pairing", version == 1,
              let url = URL(string: address), url.scheme == "https",
              let endpoint = try? BackendEndpoint(url), !endpoint.isLoopback,
              !["0.0.0.0", "::", "[::]"].contains(url.host?.lowercased() ?? ""),
              !serverId.isEmpty, serverId.utf8.count <= 256,
              !serverId.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              UUID(uuidString: pairingId) != nil,
              pairingSecret.utf8.count == 43,
              pairingSecret.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0)
                  || (48...57).contains($0) || $0 == 45 || $0 == 95 }),
              address.utf8.count <= 512, expiresAt.isFinite else { throw CodeError.invalid }
        guard expiresAt > now.timeIntervalSince1970 * 1000 else { throw CodeError.expired }
        // A QR invitation may live only briefly, not become a reusable credential.
        guard expiresAt <= now.timeIntervalSince1970 * 1000 + 360_000 else { throw CodeError.invalid }
    }
    public func encoded(now: Date = .now) throws -> String {
        try validate(now: now)
        let data = try JSONEncoder().encode(self)
        guard data.count <= 2048, let value = String(data: data, encoding: .utf8) else { throw CodeError.invalid }
        return value
    }
    public static func decode(_ payload: String, now: Date = .now) throws -> Self {
        guard payload.utf8.count <= 2048 else { throw CodeError.invalid }
        guard let value = try? JSONDecoder().decode(Self.self, from: Data(payload.utf8)) else { throw CodeError.invalid }
        try value.validate(now: now)
        return value
    }
    public enum CodeError: Error { case invalid, expired }
}
