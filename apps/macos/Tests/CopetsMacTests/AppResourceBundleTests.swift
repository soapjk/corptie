import Foundation
import XCTest
@testable import CorptieMac

final class AppResourceBundleTests: XCTestCase {
    func testMissingResourceBundleFallsBackWithoutTrapping() {
        let bundle = AppResourceBundle.resolve(
            named: "missing.bundle",
            below: [URL(fileURLWithPath: NSTemporaryDirectory())]
        )
        XCTAssertEqual(bundle.bundleURL, Bundle.main.bundleURL)
    }

    func testPackagedResourceBundleCanBeResolved() {
        let bundle = AppResourceBundle.resolve(
            named: "CorptieMac_CorptieMac.bundle",
            below: [Bundle(for: AppResourceBundleTests.self).resourceURL!]
        )
        XCTAssertNotNil(bundle.url(forResource: "AppIcon", withExtension: "png"))
    }
}
