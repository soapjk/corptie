import Foundation

struct SessionListPerformanceFlags: Equatable, Sendable {
    let haloAnimationsEnabled: Bool

    /// Resolved once per process. Reading this in a SwiftUI `body` used to
    /// re-read and re-parse the whole environment dictionary on every
    /// evaluation, including during high-frequency state updates.
    static let current: SessionListPerformanceFlags = resolve(
        environment: ProcessInfo.processInfo.environment
    )

    static func resolve(environment: [String: String]) -> SessionListPerformanceFlags {
        let isDevelopment = ["dev", "development"].contains(
            environment["CORPTIE_ENV"]?.lowercased() ?? ""
        )
        guard isDevelopment else {
            return SessionListPerformanceFlags(
                haloAnimationsEnabled: true
            )
        }

        return SessionListPerformanceFlags(
            haloAnimationsEnabled: boolValue(
                environment["CORPTIE_SESSION_PERF_HALO_ANIMATIONS"],
                defaultValue: true
            )
        )
    }

    private static func boolValue(_ value: String?, defaultValue: Bool) -> Bool {
        guard let value else {
            return defaultValue
        }
        return ["1", "true", "yes", "on"].contains(value.lowercased())
    }
}
