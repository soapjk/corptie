import XCTest
@testable import CorptieMac

final class DevelopmentLaunchPolicyTests: XCTestCase {
    func testBackgroundGuardDoesNotSkipBackendAndExplicitReopenRestoresWindow() throws {
        let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: package.appendingPathComponent(
            "Sources/CopetsMac/Application/AppDelegate.swift"), encoding: .utf8)
        let backend = try XCTUnwrap(source.range(of: "CorptieBackendSupervisor.ensureBackendStarted()"))
        let startup = try XCTUnwrap(source.range(of: "if !suppressAutomaticWindowPresentation { openWarRoom() }"))
        XCTAssertLessThan(backend.lowerBound, startup.lowerBound)
        XCTAssertTrue(source.contains("!self.suppressAutomaticWindowPresentation,"))
        let reopen = source.components(separatedBy: "func applicationShouldHandleReopen")[1]
            .components(separatedBy: "private func presentMainWindowAfterActivation")[0]
        XCTAssertTrue(reopen.contains("openWarRoom()"))
        let explicitOpen = source.components(separatedBy: "@objc private func openWarRoom()")[1]
        XCTAssertTrue(explicitOpen.contains("suppressAutomaticWindowPresentation = false"))
        XCTAssertFalse(explicitOpen.components(separatedBy: "NSApp.activate")[0].contains("guard"))
    }
    func testOnlyExplicitDevelopmentBackgroundModeSuppressesWindows() {
        for environmentName in ["dev", "development", "DEVELOPMENT"] {
            XCTAssertTrue(DevelopmentLaunchPolicy.startsInBackground(environment: [
                "CORPTIE_ENV": environmentName, "CORPTIE_DEVELOPMENT_LAUNCH_MODE": "background"
            ], isProductionBundle: false))
        }
        for mode in ["", "foreground", "1", "true", "invalid"] {
            XCTAssertFalse(DevelopmentLaunchPolicy.startsInBackground(environment: [
                "CORPTIE_ENV": "development", "CORPTIE_DEVELOPMENT_LAUNCH_MODE": mode
            ], isProductionBundle: false))
        }
    }

    func testProductionIgnoresBackgroundFlagEvenWithIncorrectEnvironment() {
        for environmentName in ["", "production", "development"] {
            XCTAssertFalse(DevelopmentLaunchPolicy.startsInBackground(environment: [
                "CORPTIE_ENV": environmentName, "CORPTIE_DEVELOPMENT_LAUNCH_MODE": "background"
            ], isProductionBundle: true))
        }
        XCTAssertFalse(DevelopmentLaunchPolicy.startsInBackground(environment: [
            "CORPTIE_DEVELOPMENT_LAUNCH_MODE": "background"
        ], isProductionBundle: false))
    }
}
