import Foundation
@preconcurrency import UserNotifications

enum SystemNotificationCenter {
    /// UserNotifications raises an Objective-C exception when SwiftPM launches
    /// the executable outside an application bundle. Production packaging has
    /// both an app bundle and a bundle identifier; direct Development runs do not.
    static var isAvailable: Bool {
        Bundle.main.bundleURL.pathExtension.lowercased() == "app"
            && Bundle.main.bundleIdentifier?.isEmpty == false
    }

    static func currentIfAvailable() -> UNUserNotificationCenter? {
        guard isAvailable else { return nil }
        return UNUserNotificationCenter.current()
    }
}
