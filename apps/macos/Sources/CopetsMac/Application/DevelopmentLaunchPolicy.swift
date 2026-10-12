import Foundation

/// Launch-only presentation policy. Never changes backend ownership or lifetime.
enum DevelopmentLaunchPolicy {
    static func startsInBackground(environment: [String: String], isProductionBundle: Bool) -> Bool {
        guard !isProductionBundle,
              ["dev", "development"].contains(environment["CORPTIE_ENV"]?.lowercased() ?? "") else {
            return false
        }
        return environment["CORPTIE_DEVELOPMENT_LAUNCH_MODE"] == "background"
    }
}
