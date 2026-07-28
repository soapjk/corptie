import Foundation
import XCTest
@testable import CorptieMac

@MainActor
final class DetachedOrbSmartAvoidancePreferencesTests: XCTestCase {
    func testInitializationDoesNotRequestPermission() {
        var requestCount = 0
        let fixture = makeFixture(
            preflight: { false },
            request: {
                requestCount += 1
                return false
            }
        )
        defer { fixture.cleanup() }

        XCTAssertFalse(fixture.preferences.isEnabled)
        XCTAssertEqual(fixture.preferences.permissionStatus, .notGranted)
        XCTAssertFalse(fixture.preferences.canCapture)
        XCTAssertEqual(requestCount, 0)
    }

    func testUserEnableRequestsPermissionAndPersistsIntent() {
        var requestCount = 0
        let fixture = makeFixture(
            preflight: { false },
            request: {
                requestCount += 1
                return false
            }
        )
        defer { fixture.cleanup() }

        fixture.preferences.setEnabledByUser(true)

        XCTAssertTrue(fixture.preferences.isEnabled)
        XCTAssertEqual(fixture.preferences.permissionStatus, .notGranted)
        XCTAssertFalse(fixture.preferences.canCapture)
        XCTAssertEqual(requestCount, 1)
        XCTAssertTrue(fixture.defaults.bool(forKey: DetachedOrbSmartAvoidancePreferences.enabledKey))
        XCTAssertTrue(fixture.defaults.bool(forKey: DetachedOrbSmartAvoidancePreferences.permissionExplainedKey))
    }

    func testAlreadyAuthorizedEnableDoesNotRequestAgain() {
        var requestCount = 0
        let fixture = makeFixture(
            preflight: { true },
            request: {
                requestCount += 1
                return true
            }
        )
        defer { fixture.cleanup() }

        fixture.preferences.setEnabledByUser(true)

        XCTAssertTrue(fixture.preferences.canCapture)
        XCTAssertEqual(requestCount, 0)
    }

    func testRefreshMakesPersistedIntentOperationalAfterExternalGrant() {
        var authorized = false
        let fixture = makeFixture(
            preflight: { authorized },
            request: { false },
            initiallyEnabled: true
        )
        defer { fixture.cleanup() }
        XCTAssertFalse(fixture.preferences.canCapture)

        authorized = true
        fixture.preferences.refreshPermission()

        XCTAssertEqual(fixture.preferences.permissionStatus, .authorized)
        XCTAssertTrue(fixture.preferences.canCapture)
    }

    func testDisableAndSuspensionImmediatelyPreventCapture() {
        let fixture = makeFixture(
            preflight: { true },
            request: { true }
        )
        defer { fixture.cleanup() }
        fixture.preferences.setEnabledByUser(true)
        XCTAssertTrue(fixture.preferences.canCapture)

        fixture.preferences.suspendCapture()
        XCTAssertFalse(fixture.preferences.canCapture)

        fixture.preferences.resumeCapture()
        XCTAssertTrue(fixture.preferences.canCapture)

        fixture.preferences.setEnabledByUser(false)
        XCTAssertFalse(fixture.preferences.canCapture)
        XCTAssertFalse(fixture.defaults.bool(forKey: DetachedOrbSmartAvoidancePreferences.enabledKey))
    }

    private func makeFixture(
        preflight: @escaping () -> Bool,
        request: @escaping () -> Bool,
        initiallyEnabled: Bool = false
    ) -> (
        preferences: DetachedOrbSmartAvoidancePreferences,
        defaults: UserDefaults,
        cleanup: () -> Void
    ) {
        let suiteName = "DetachedOrbSmartAvoidancePreferencesTests.\(UUID())"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.set(initiallyEnabled, forKey: DetachedOrbSmartAvoidancePreferences.enabledKey)
        let preferences = DetachedOrbSmartAvoidancePreferences(
            defaults: defaults,
            preflightPermission: preflight,
            requestPermission: request
        )
        return (
            preferences,
            defaults,
            { defaults.removePersistentDomain(forName: suiteName) }
        )
    }
}
