import Foundation

/// Explicit opt-in; installed pages keep the frozen native-v2 catalog.
public struct ClientDetailV2Negotiation: Equatable, Sendable {
    public let catalog: String
    public let clientCapabilities: [String]
    public let capabilityDigest: String
    public static let registeredCapabilities = ClientDetailPresentationCatalog.nativeCapabilities
    public static let legacy = Self(catalog: "native-v2", clientCapabilities: [],
        capabilityDigest: "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945")
    public static let nativeBusiness = Self(catalog: "native-business-v1", clientCapabilities: [], capabilityDigest: legacy.capabilityDigest)
    public static func components(clientCapabilities: [String], catalog: String = ClientDetailPresentationCatalog.profile1) throws -> Self {
        guard let registered = ClientDetailPresentationCatalog.capabilities(for: catalog),
              clientCapabilities.count <= 32, Set(clientCapabilities).count == clientCapabilities.count,
              clientCapabilities.allSatisfy({ registered.contains($0) && $0.utf8.count <= 64 && $0.utf8.allSatisfy({ $0 < 128 }) })
        else { throw ClientDetailV2Canonical.Failure.shape }
        let sorted = clientCapabilities.sorted()
        return Self(catalog: catalog, clientCapabilities: sorted,
                    capabilityDigest: try ClientDetailV2Canonical.hash(.array(sorted.map { .string($0) })))
    }
    public var isLegacy: Bool { catalog == "native-v2" }
    /// Caller scope already includes server, account, device and Session.
    func scoped(_ scope: String) -> String {
        "\(scope.utf8.count):\(scope):\(catalog):\(capabilityDigest)"
    }
}
