import Foundation

public struct CloudDevice: Codable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Codable, Sendable { case mac, mobile }

    public let id: UUID
    public let kind: Kind
    public let displayName: String
    public let publicKeyAlgorithm: String
    public let publicKey: String
    public let authEpoch: Int
    public let createdAt: Date
    public let updatedAt: Date
    public let lastSeenAt: Date
    public let revokedAt: Date?
}

public struct CloudDeviceRegistration: Encodable, Equatable, Sendable {
    public let id: UUID
    public let kind: CloudDevice.Kind
    public let displayName: String
    public let publicKeyAlgorithm: String
    public let publicKey: String

    public init(id: UUID, kind: CloudDevice.Kind, displayName: String, publicKey: String) {
        self.id = id
        self.kind = kind
        self.displayName = displayName
        self.publicKeyAlgorithm = "X25519"
        self.publicKey = publicKey
    }
}

public struct CloudDeviceClient: Sendable {
    private let transport: BackendTransport

    public init(endpoint: BackendEndpoint, accessToken: String, configuration: URLSessionConfiguration = .ephemeral) throws {
        transport = try BackendTransport(endpoint: endpoint, bearerToken: accessToken, configuration: configuration)
    }

    public func list() async throws -> [CloudDevice] {
        let request = try transport.endpoint.request(path: ["v1", "devices"])
        let (data, _) = try await transport.data(for: request)
        return try Self.makeDecoder().decode(DeviceList.self, from: data).devices
    }

    public func register(_ input: CloudDeviceRegistration) async throws -> CloudDevice {
        var request = try transport.endpoint.request(path: ["v1", "devices"])
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(input)
        let (data, _) = try await transport.data(for: request)
        return try Self.makeDecoder().decode(DeviceEnvelope.self, from: data).device
    }

    public func revoke(_ id: UUID) async throws -> CloudDevice {
        var request = try transport.endpoint.request(path: ["v1", "devices", id.uuidString.lowercased()])
        request.httpMethod = "DELETE"
        let (data, _) = try await transport.data(for: request)
        return try Self.makeDecoder().decode(DeviceEnvelope.self, from: data).device
    }

    public func revokeCurrent() async throws -> CloudDevice {
        var request = try transport.endpoint.request(path: ["v1", "devices", "current"])
        request.httpMethod = "DELETE"
        let (data, _) = try await transport.data(for: request)
        return try Self.makeDecoder().decode(DeviceEnvelope.self, from: data).device
    }

    private static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { input in
            let value = try input.singleValueContainer().decode(String.self)
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value) { return date }
            throw DecodingError.dataCorruptedError(in: try input.singleValueContainer(), debugDescription: "Invalid ISO-8601 timestamp")
        }
        return decoder
    }
}

private struct DeviceList: Decodable { let devices: [CloudDevice] }
private struct DeviceEnvelope: Decodable { let device: CloudDevice }
