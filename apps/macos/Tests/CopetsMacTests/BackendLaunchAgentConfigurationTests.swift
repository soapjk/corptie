import XCTest
@testable import CorptieMac

final class BackendLaunchAgentConfigurationTests: XCTestCase {
    func testInstallationUsesCurrentUserAndRelocatedBundleAndPreservesPolicy() throws {
        let template: [String: Any] = [
            "Label": "com.corptie.backend", "RunAtLoad": false, "KeepAlive": false,
            "ProgramArguments": ["/Applications/Corptie.app/old"],
            "StandardOutPath": "/Users/builder/log",
            "EnvironmentVariables": ["CORPTIE_BACKEND_BUILD_ID": "build-123", "CORPTIE_BACKEND_PORT": "47321",
                                     "CORPTIE_DEFAULT_WORKSPACE": "/Users/builder/corptie"]
        ]
        let input = try PropertyListSerialization.data(fromPropertyList: template, format: .xml, options: 0)
        let output = try BackendLaunchAgentConfiguration.data(
            template: input, home: URL(fileURLWithPath: "/Users/New User"),
            bundle: URL(fileURLWithPath: "/Users/New User/Applications/Corptie.app")
        )
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: output, format: nil) as? [String: Any])
        XCTAssertEqual(plist["ProgramArguments"] as? [String], ["/Users/New User/Applications/Corptie.app/Contents/Resources/corptie-backend-launch.sh"])
        XCTAssertEqual(plist["StandardOutPath"] as? String, "/Users/New User/Library/Logs/Corptie/backend.out.log")
        XCTAssertEqual(plist["StandardErrorPath"] as? String, "/Users/New User/Library/Logs/Corptie/backend.err.log")
        let environment = try XCTUnwrap(plist["EnvironmentVariables"] as? [String: String])
        XCTAssertEqual(environment["CORPTIE_DEFAULT_WORKSPACE"], "/Users/New User/corptie")
        XCTAssertEqual(environment["CORPTIE_BACKEND_BUILD_ID"], "build-123")
        XCTAssertEqual(environment["CORPTIE_BACKEND_PORT"], "47321")
        XCTAssertEqual(plist["RunAtLoad"] as? Bool, false)
        XCTAssertEqual(plist["KeepAlive"] as? Bool, false)
        XCTAssertFalse(String(decoding: output, as: UTF8.self).contains("/Users/builder"))
        // Repeated starts must not rewrite the job and revoke its running state.
        XCTAssertEqual(output, try BackendLaunchAgentConfiguration.data(
            template: output, home: URL(fileURLWithPath: "/Users/New User"),
            bundle: URL(fileURLWithPath: "/Users/New User/Applications/Corptie.app")
        ))
    }
}
