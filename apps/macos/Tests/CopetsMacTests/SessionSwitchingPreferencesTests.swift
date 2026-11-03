import Foundation
import XCTest
@testable import CorptieMac

@MainActor
final class SessionSwitchingPreferencesTests: XCTestCase {
    func testResidencyIsAlwaysEnabledWithEightPages() {
        XCTAssertTrue(UnifiedConsoleView.usesResidentPages)
        XCTAssertEqual(SessionSwitchingPreferences.maximumResidentPages, 8)
    }

    func testSettingsNoLongerExposeOrReadTheRetiredPreference() throws {
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/Settings")
        let settings = try String(contentsOf: source.appendingPathComponent("SettingsView.swift"), encoding: .utf8)
        let policy = try String(contentsOf: source.appendingPathComponent("SessionSwitchingPreferences.swift"), encoding: .utf8)
        XCTAssertFalse(settings.contains("settings.sessionSwitchingAcceleration"))
        XCTAssertFalse(settings.contains("acceleratedSessionSwitching"))
        XCTAssertFalse(policy.contains("UserDefaults"))
        XCTAssertFalse(policy.contains("CORPTIE_SESSION_RESIDENT_PAGES"))
    }
}
