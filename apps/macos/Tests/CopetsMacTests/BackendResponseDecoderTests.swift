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

    func testRoutedWorkspaceWinsOverLegacyAndProviderPaths() {
        XCTAssertEqual(
            BackendResponseDecoder.preferredWorkspacePath(
                authoritativePath: "/repo/source",
                providerPath: "/Applications/Corptie/backend",
                workspacePath: "/repo/feature worktree"
            ),
            "/repo/feature worktree"
        )
    }

    func testSessionWorkspaceProjectionDecodesStableLogicalRoute() async throws {
        let data = Data(
            """
            {
              "sessions": [{
                "id": "codex:stable-ui",
                "title": "Stable UI",
                "agent": "Codex",
                "status": "complete",
                "progress": 1,
                "summary": "Done",
                "updatedAt": "2026-07-28T00:00:00.000Z",
                "accent": "cyan",
                "external": {
                  "provider": "codex-app-server",
                  "threadId": "thread-after-fork",
                  "cwd": "/repo/feature worktree",
                  "logicalSessionId": "logical:one",
                  "workspace": {
                    "id": "worktree:feature",
                    "repositoryId": "repository:one",
                    "path": "/repo/feature worktree",
                    "availability": "available",
                    "branchName": "feature/workspace",
                    "headOid": "abc123"
                  },
                  "routingVersion": 4
                }
              }]
            }
            """.utf8
        )

        let session = try await BackendResponseDecoder.sessions(from: data).first
        XCTAssertEqual(session?.id, "codex:stable-ui")
        XCTAssertEqual(session?.external?.threadId, "thread-after-fork")
        XCTAssertEqual(session?.external?.logicalSessionId, "logical:one")
        XCTAssertEqual(session?.external?.workspace?.path, "/repo/feature worktree")
        XCTAssertEqual(session?.external?.workspace?.branchName, "feature/workspace")
        XCTAssertEqual(session?.external?.routingVersion, 4)
    }
}
