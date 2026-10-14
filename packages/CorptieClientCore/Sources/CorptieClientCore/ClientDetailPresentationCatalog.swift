import Foundation

/// Protocol vocabulary, not a promise that a platform installed a renderer.
public enum ClientDetailPresentationCatalog {
    public static let profile1 = "native-v2-components-1"
    public static let profile2 = "native-v2-components-2"
    public static let nativeCapabilities: Set<String> = [
        "detail.button", "detail.chart", "detail.dateTime", "detail.form", "detail.image",
        "detail.keyValue", "detail.markdown", "detail.progress", "detail.resourceList", "detail.status"
    ]
    public static func capabilities(for profile: String) -> Set<String>? {
        switch profile {
        case profile1: nativeCapabilities
        case profile2: nativeCapabilities.union(["detail.web"])
        default: nil
        }
    }
}

public struct ClientDetailRenderDescriptor: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case native, web }
    public let kind: Kind
    public var rendererId: String? = nil
    public var rendererVersion: Int? = nil
    public var assetHash: String? = nil
    public var dataBinding: String? = nil
    public var bridgeVersion: Int? = nil
}

public struct ClientDetailDisclosurePresentation: Codable, Equatable, Sendable {
    public let previewBinding: String?
    public let initiallyExpanded: Bool?
    private enum CodingKeys: String, CodingKey { case previewBinding, initiallyExpanded }
}
