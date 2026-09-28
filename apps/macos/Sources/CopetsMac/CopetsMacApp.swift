import AppKit
import Combine
import os
import QuartzCore
import SwiftUI
import UserNotifications

@main
enum CorptieMacLauncher {
    static func main() {
        if #available(macOS 15.0, *) {
            ExplicitWindowLaunchApp.main()
        } else {
            CorptieMacApp.main()
        }
    }
}

// SceneBuilder cannot branch on API availability on our macOS 14 baseline.
// Select the App at launch so newer systems use native scene launch policies.
@available(macOS 15.0, *)
struct ExplicitWindowLaunchApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings { SettingsView() }
            .defaultLaunchBehavior(.suppressed)
            .restorationBehavior(.disabled)
    }
}

struct CorptieMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings {
            SettingsView()
        }
    }
}
