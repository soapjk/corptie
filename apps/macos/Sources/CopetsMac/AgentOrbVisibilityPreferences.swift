import Foundation

@MainActor
struct AgentOrbVisibilityPreferences {
    static let storageKey = "corptie.enabledAgentOrbIds"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = CorptieAppEnvironment.userDefaults) {
        self.defaults = defaults
    }

    var enabledAgentIDs: Set<String> {
        Set(defaults.stringArray(forKey: Self.storageKey) ?? [])
    }

    func setEnabled(_ enabled: Bool, for agentID: String) {
        var ids = enabledAgentIDs
        if enabled {
            ids.insert(agentID)
        } else {
            ids.remove(agentID)
        }
        defaults.set(ids.sorted(), forKey: Self.storageKey)
    }
}

enum AgentOrbVisibilityPolicy {
    static func shouldShow(agentID: String, explicitlyEnabledAgentIDs: Set<String>) -> Bool {
        explicitlyEnabledAgentIDs.contains(agentID)
    }
}
