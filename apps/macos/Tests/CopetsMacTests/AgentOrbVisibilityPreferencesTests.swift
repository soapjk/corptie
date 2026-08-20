import XCTest
@testable import CorptieMac

@MainActor
final class AgentOrbVisibilityPreferencesTests: XCTestCase {
    func testRunningStateCannotEnableAnOrbWithoutExplicitPreference() {
        XCTAssertFalse(AgentOrbVisibilityPolicy.shouldShow(
            agentID: "agent-one",
            explicitlyEnabledAgentIDs: []
        ))
    }

    func testExplicitOpenPersistsAcrossPreferenceInstances() {
        let defaults = makeDefaults()
        let preferences = AgentOrbVisibilityPreferences(defaults: defaults)
        preferences.setEnabled(true, for: "agent-one")

        let reloaded = AgentOrbVisibilityPreferences(defaults: defaults)
        XCTAssertTrue(AgentOrbVisibilityPolicy.shouldShow(
            agentID: "agent-one",
            explicitlyEnabledAgentIDs: reloaded.enabledAgentIDs
        ))
    }

    func testClosePersistsAndPreventsLaterSynchronizationFromShowingOrb() {
        let defaults = makeDefaults()
        let preferences = AgentOrbVisibilityPreferences(defaults: defaults)
        preferences.setEnabled(true, for: "agent-one")
        preferences.setEnabled(false, for: "agent-one")

        let reloaded = AgentOrbVisibilityPreferences(defaults: defaults)
        XCTAssertFalse(AgentOrbVisibilityPolicy.shouldShow(
            agentID: "agent-one",
            explicitlyEnabledAgentIDs: reloaded.enabledAgentIDs
        ))
    }

    private func makeDefaults() -> UserDefaults {
        let suite = "AgentOrbVisibilityPreferencesTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }
}
