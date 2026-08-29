import AppKit
import CoreServices
import Foundation
import UniformTypeIdentifiers

@MainActor
enum ArtifactSystemApplicationOpener {
    static func open(_ receipt: ArtifactLocalFileReceipt) async -> String? {
        let validationError: String? = await Task.detached(priority: .userInitiated) { () -> String? in
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: receipt.path, isDirectory: &isDirectory),
                  !isDirectory.boolValue else {
                return "missing"
            }
            guard FileManager.default.isReadableFile(atPath: receipt.path) else {
                return "permission"
            }
            return nil
        }.value

        switch validationError {
        case "missing":
            return L10n("The Artifact file no longer exists.")
        case "permission":
            return L10n("Corptie does not have permission to open this Artifact file.")
        default:
            break
        }

        let workspace = NSWorkspace.shared
        guard let applicationURL = defaultApplicationURL(for: receipt)
            ?? workspace.urlForApplication(toOpen: receipt.fileURL) else {
            return L10n("No application is associated with this Artifact file type.")
        }
        let openFailureTemplate = L10n("The system could not open this Artifact: %@")

        return await withCheckedContinuation { continuation in
            workspace.open(
                [receipt.fileURL],
                withApplicationAt: applicationURL,
                configuration: NSWorkspace.OpenConfiguration()
            ) { _, error in
                continuation.resume(returning: error.map {
                    openFailureTemplate.replacingOccurrences(of: "%@", with: $0.localizedDescription)
                })
            }
        }
    }

    static func defaultApplicationURL(for receipt: ArtifactLocalFileReceipt) -> URL? {
        let fileExtension = receipt.applicationLookupURL.pathExtension
        guard !fileExtension.isEmpty,
              let contentType = UTType(filenameExtension: fileExtension),
              let application = LSCopyDefaultApplicationURLForContentType(
                contentType.identifier as CFString,
                .all,
                nil
              ) else { return nil }
        return application.takeRetainedValue() as URL
    }
}
