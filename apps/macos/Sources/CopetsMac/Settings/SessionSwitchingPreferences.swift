import Foundation

/// One local preference selects the complete bounded page pool. Capture it
/// once per launch so a settings edit cannot dismantle a live editor tree.
@MainActor
enum SessionSwitchingPreferences {
    static let maximumResidentPages = 8
    static let preferenceKey = "performance.sessionPageResidency"
    static let launchEnabled = resolve(defaults: CorptieAppEnvironment.userDefaults,
        isDevelopment: CorptieAppEnvironment.isDevelopment, environment: ProcessInfo.processInfo.environment)

    static func resolve(defaults: UserDefaults, isDevelopment: Bool, environment: [String: String]) -> Bool {
        if defaults.object(forKey: preferenceKey) != nil {
            return defaults.bool(forKey: preferenceKey)
        }
        // Retain the developer-only launch override until a user chooses a value.
        return isDevelopment && environment["CORPTIE_SESSION_RESIDENT_PAGES"] == "1"
    }
}
