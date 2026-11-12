import AppKit
import Sparkle

/// Sparkle owns scheduling, download verification, replacement and relaunch.
/// Development bundles never subscribe to the production update channel.
@MainActor
final class SoftwareUpdater: NSObject {
    private var controller: SPUStandardUpdaterController?

    func start() {
        guard controller == nil,
              Bundle.main.bundleIdentifier == "com.corptie.mac",
              let feed = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String,
              URL(string: feed)?.scheme == "https",
              let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String,
              Data(base64Encoded: key)?.count == 32 else { return }
        controller = SPUStandardUpdaterController(
            startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil
        )
    }

    func checkForUpdates() {
        guard let controller else {
            let alert = NSAlert()
            alert.messageText = L10n("Check for Updates…")
            alert.informativeText = L10n("Automatic updates are not configured for this build.")
            alert.runModal()
            return
        }
        controller.checkForUpdates(nil)
    }
}
