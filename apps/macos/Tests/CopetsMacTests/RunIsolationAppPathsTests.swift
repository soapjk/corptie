import XCTest
@testable import CorptieMac

final class RunIsolationAppPathsTests: XCTestCase {
    func testRunUsesExplicitPrivateUserDefaultsSuite() {
        let suite = RunIsolationAppPaths.userDefaultsSuite(
            environment: [
                "CORPTIE_RUN_ID": "run:one",
                "CORPTIE_USER_DEFAULTS_SUITE": "com.corptie.run.abc123"
            ],
            isDevelopment: true
        )
        XCTAssertEqual(suite, "com.corptie.run.abc123")
        XCTAssertNotEqual(suite, "com.corptie.mac.development")
    }

    func testRunPresentationDatabaseUsesExplicitDataDirectory() {
        let directory = RunIsolationAppPaths.dataDirectory(environment: [
            "CORPTIE_RUN_ID": "run:one",
            "CORPTIE_DATA_DIR": "/Volumes/T9/runs/one/data"
        ])
        XCTAssertEqual(directory?.appendingPathComponent("presentation.sqlite3").path,
                       "/Volumes/T9/runs/one/data/presentation.sqlite3")
    }

    func testOrdinaryProductionAndDevelopmentSuitesRemainSeparate() {
        XCTAssertEqual(RunIsolationAppPaths.userDefaultsSuite(environment: [:], isDevelopment: true),
                       "com.corptie.mac.development")
        XCTAssertEqual(RunIsolationAppPaths.userDefaultsSuite(environment: [:], isDevelopment: false),
                       "com.corptie.mac.production")
    }

    func testWorktreeDevelopmentLauncherMayUseAnExplicitBoundedSuiteAndPresentationDirectory() {
        let environment = [
            "CORPTIE_USER_DEFAULTS_SUITE": "com.corptie.development.abc123",
            "CORPTIE_PRESENTATION_DATA_DIR": "/Volumes/T9/dev/worktree/data"
        ]
        XCTAssertEqual(RunIsolationAppPaths.userDefaultsSuite(environment: environment, isDevelopment: true),
                       "com.corptie.development.abc123")
        XCTAssertEqual(RunIsolationAppPaths.dataDirectory(environment: environment)?.path,
                       "/Volumes/T9/dev/worktree/data")
    }
}
