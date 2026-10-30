import Foundation
import XCTest
@testable import CorptieMac

@MainActor
final class SessionSwitchingPreferencesTests: XCTestCase {
    private func defaults(suite: String = "SessionSwitchingPreferencesTests." + UUID().uuidString) -> UserDefaults {
        let defaults = UserDefaults(suiteName: suite)!
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        return defaults
    }

    func testReleaseBuildCanEnableAndRetainPreferenceAcrossLaunches() throws {
        let suite = "SessionSwitchingPreferencesTests." + UUID().uuidString
        let store = defaults(suite: suite)
        store.set(true, forKey: SessionSwitchingPreferences.preferenceKey)
        let reloaded = try XCTUnwrap(UserDefaults(suiteName: suite))
        // Use a fresh resolver, as a subsequent App launch does; no development gate.
        XCTAssertTrue(SessionSwitchingPreferences.resolve(defaults: reloaded, isDevelopment: false, environment: [:]))
        store.set(false, forKey: SessionSwitchingPreferences.preferenceKey)
        XCTAssertFalse(SessionSwitchingPreferences.resolve(defaults: store, isDevelopment: false, environment: [:]))
    }

    func testExplicitOffOverridesDevelopmentLaunchFlag() {
        let store = defaults()
        store.set(false, forKey: SessionSwitchingPreferences.preferenceKey)
        XCTAssertFalse(SessionSwitchingPreferences.resolve(defaults: store, isDevelopment: true,
            environment: ["CORPTIE_SESSION_RESIDENT_PAGES": "1"]))
    }

    func testUnconfiguredReleaseDoesNotUseDeveloperEnvironment() {
        XCTAssertFalse(SessionSwitchingPreferences.resolve(defaults: defaults(), isDevelopment: false,
            environment: ["CORPTIE_SESSION_RESIDENT_PAGES": "1"]))
    }

    func testUnconfiguredDevelopmentRetainsExistingLaunchOverride() {
        let store = defaults()
        XCTAssertTrue(SessionSwitchingPreferences.resolve(defaults: store, isDevelopment: true,
            environment: ["CORPTIE_SESSION_RESIDENT_PAGES": "1"]))
        XCTAssertFalse(SessionSwitchingPreferences.resolve(defaults: store, isDevelopment: true, environment: [:]))
    }
}
