import Foundation
import CryptoKit
import CorptieClientCore

enum ConversationDetailWebRegistry {
    static let rendererID = "detail.sections.v1"
    static let assetHash = "sha256:c858c8f7d8993429a2090d11662bf41ea5259888105da8d1ce254614edf8563f"
    struct Package: Sendable { let entry: URL; let script: String; let hash: String }
    static let package: Package? = {
        var bytes = Data()
        var entry: URL?
        var script: String?
        for name in ["card.html", "runtime.js", "tokens.css"] {
            let parts = name.split(separator: ".").map(String.init)
            guard let url = Bundle.module.url(forResource: parts[0], withExtension: parts[1], subdirectory: "DetailWeb"),
                  let data = try? Data(contentsOf: url) else { return nil }
            bytes.append(Data((name + "\0").utf8)); bytes.append(data)
            if name == "card.html" { entry = url }
            if name == "runtime.js" { script = String(data: data, encoding: .utf8) }
        }
        let digest = "sha256:" + SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        guard digest == assetHash, let entry, let script else { return nil }
        return Package(entry: entry, script: script, hash: digest)
    }()
    static var capabilities: [String] { package == nil ? [] : ["detail.web"] }
    static func supports(_ descriptor: ClientDetailRenderDescriptor) -> Bool {
        descriptor.kind == .web && descriptor.rendererId == rendererID && descriptor.rendererVersion == 1
            && descriptor.bridgeVersion == 1 && descriptor.assetHash == package?.hash
    }
}
