/// Session page residency is always enabled with a bounded page pool.
@MainActor
enum SessionSwitchingPreferences {
    static let maximumResidentPages = 8
}
