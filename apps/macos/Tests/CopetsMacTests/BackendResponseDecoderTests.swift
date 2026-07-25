import XCTest
@testable import CorptieMac

final class BackendResponseDecoderTests: XCTestCase {
    func testSavedSessionWorkspaceWinsOverProviderProcessDirectory() {
        XCTAssertEqual(
            BackendResponseDecoder.preferredWorkspacePath(
                authoritativePath: "/Volumes/T9/projects/corptie",
                providerPath: "/Applications/Corptie.app/Contents/Resources/backend"
            ),
            "/Volumes/T9/projects/corptie"
        )
    }

    func testProviderWorkspaceIsUsedWhenNoSavedSessionWorkspaceExists() {
        XCTAssertEqual(
            BackendResponseDecoder.preferredWorkspacePath(
                authoritativePath: nil,
                providerPath: "/Volumes/T9/projects/new-project"
            ),
            "/Volumes/T9/projects/new-project"
        )
    }
}
