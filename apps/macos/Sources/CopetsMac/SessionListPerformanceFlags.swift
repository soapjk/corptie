import Foundation

struct SessionListPerformanceFlags: Equatable, Sendable {
    let sessionLimit: Int?
    let haloAnimationsEnabled: Bool
    let glassEffectsEnabled: Bool
    let pollingEnabled: Bool
    let forcesCardDisplayMode: Bool
    let layoutLoggingEnabled: Bool

    @MainActor
    static var current: SessionListPerformanceFlags {
        resolve(environment: ProcessInfo.processInfo.environment)
    }

    static func resolve(environment: [String: String]) -> SessionListPerformanceFlags {
        let isDevelopment = ["dev", "development"].contains(
            environment["CORPTIE_ENV"]?.lowercased() ?? ""
        )
        guard isDevelopment else {
            return SessionListPerformanceFlags(
                sessionLimit: nil,
                haloAnimationsEnabled: true,
                glassEffectsEnabled: true,
                pollingEnabled: true,
                forcesCardDisplayMode: false,
                layoutLoggingEnabled: false
            )
        }

        return SessionListPerformanceFlags(
            sessionLimit: positiveInteger(environment["CORPTIE_SESSION_PERF_LIMIT"]),
            haloAnimationsEnabled: boolValue(
                environment["CORPTIE_SESSION_PERF_HALO_ANIMATIONS"],
                defaultValue: true
            ),
            glassEffectsEnabled: boolValue(
                environment["CORPTIE_SESSION_PERF_GLASS_EFFECTS"],
                defaultValue: true
            ),
            pollingEnabled: boolValue(
                environment["CORPTIE_SESSION_PERF_POLLING"],
                defaultValue: true
            ),
            forcesCardDisplayMode: environment["CORPTIE_SESSION_PERF_FORCE_CARDS"] == "1",
            layoutLoggingEnabled: environment["CORPTIE_LAYOUT_DEBUG"] == "1"
        )
    }

    private static func positiveInteger(_ value: String?) -> Int? {
        guard let value, let parsed = Int(value), parsed > 0 else {
            return nil
        }
        return parsed
    }

    private static func boolValue(_ value: String?, defaultValue: Bool) -> Bool {
        guard let value else {
            return defaultValue
        }
        return ["1", "true", "yes", "on"].contains(value.lowercased())
    }
}
