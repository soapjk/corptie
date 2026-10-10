import Foundation

/// SwiftPM's generated `Bundle.module` traps when the resource bundle cannot
/// be resolved. A damaged or translocated installation must not crash at launch.
enum AppResourceBundle {
    static let bundle: Bundle = {
        let bundleName = "CorptieMac_CorptieMac.bundle"
        let candidates = [
            Bundle.main.resourceURL,
            Bundle.main.bundleURL,
            Bundle.main.executableURL?.deletingLastPathComponent()
        ].compactMap { $0 }

        return resolve(named: bundleName, below: candidates)
    }()

    static func resolve(named bundleName: String, below candidates: [URL]) -> Bundle {
        for baseURL in candidates {
            if let bundle = Bundle(url: baseURL.appendingPathComponent(bundleName, isDirectory: true)) {
                return bundle
            }
        }
        return Bundle.main
    }
}
