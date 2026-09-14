import Foundation

public struct ClientCapabilities: Decodable, Sendable {
    public struct Connection: Decodable, Sendable {
        public let mode: String
        public let deviceAuthentication: Bool
        public let remoteAccess: Bool
    }
    public let schemaVersion: Int
    public let service: String
    public let connection: Connection

    public var supportsRemoteConnection: Bool {
        schemaVersion == 1 && service == "corptie"
            && connection.mode == "authenticated-remote"
            && connection.deviceAuthentication && connection.remoteAccess
    }
}
