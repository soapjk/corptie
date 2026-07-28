import Combine
import CoreGraphics
import Foundation

@MainActor
final class DetachedOrbSmartAvoidancePreferences: ObservableObject {
    static let shared = DetachedOrbSmartAvoidancePreferences()

    static let enabledKey = "detachedOrb.smartAvoidance.enabled"
    static let permissionExplainedKey = "detachedOrb.smartAvoidance.permissionExplained"

    @Published private(set) var isEnabled: Bool
    @Published private(set) var permissionStatus: ScreenCapturePermissionStatus
    @Published private(set) var isCaptureSuspended = false

    private let defaults: UserDefaults
    private let preflightPermission: () -> Bool
    private let requestPermission: () -> Bool

    var canCapture: Bool {
        isEnabled && permissionStatus == .authorized && !isCaptureSuspended
    }

    convenience init() {
        self.init(
            defaults: CorptieAppEnvironment.userDefaults,
            preflightPermission: CGPreflightScreenCaptureAccess,
            requestPermission: CGRequestScreenCaptureAccess
        )
    }

    init(
        defaults: UserDefaults,
        preflightPermission: @escaping () -> Bool,
        requestPermission: @escaping () -> Bool
    ) {
        self.defaults = defaults
        self.preflightPermission = preflightPermission
        self.requestPermission = requestPermission
        isEnabled = defaults.bool(forKey: Self.enabledKey)
        permissionStatus = preflightPermission() ? .authorized : .notGranted
    }

    func setEnabledByUser(_ enabled: Bool) {
        isEnabled = enabled
        defaults.set(enabled, forKey: Self.enabledKey)

        guard enabled else {
            Task {
                await ScreenContentSampler.shared.invalidateCache()
            }
            return
        }

        guard !preflightPermission() else {
            permissionStatus = .authorized
            return
        }

        defaults.set(true, forKey: Self.permissionExplainedKey)
        permissionStatus = requestPermission() ? .authorized : .notGranted
    }

    func refreshPermission() {
        permissionStatus = preflightPermission() ? .authorized : .notGranted
        if permissionStatus != .authorized {
            Task {
                await ScreenContentSampler.shared.invalidateCache()
            }
        }
    }

    func suspendCapture() {
        guard !isCaptureSuspended else {
            return
        }
        isCaptureSuspended = true
        Task {
            await ScreenContentSampler.shared.invalidateCache()
        }
    }

    func resumeCapture() {
        permissionStatus = preflightPermission() ? .authorized : .notGranted
        isCaptureSuspended = false
    }
}
