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

    func testWorkspaceInventoryEventDecodesNewlyDiscoveredWorktrees() throws {
        let data = Data(
            """
            {
              "payload": {
                "newlyDiscoveredWorkspaces": [{
                  "worktreeId": "worktree:new",
                  "path": "/repo/feature worktree"
                }]
              }
            }
            """.utf8
        )

        let event = try JSONDecoder().decode(WorkspaceInventoryEventEnvelope.self, from: data)
        XCTAssertEqual(event.payload.newlyDiscoveredWorkspaces.first?.worktreeId, "worktree:new")
        XCTAssertEqual(event.payload.newlyDiscoveredWorkspaces.first?.path, "/repo/feature worktree")
    }

    func testSessionActionsDriveBehaviorRegardlessOfProviderBrand() async throws {
        let data = Data(
            """
            {
              "sessions": [
                {
                  "id": "logical:codex",
                  "title": "Codex",
                  "agent": "Codex",
                  "status": "running",
                  "progress": 0.5,
                  "summary": "Working",
                  "updatedAt": "2026-08-08T00:00:00.000Z",
                  "accent": "cyan",
                  "capabilities": { "canSend": false, "canInterrupt": false },
                  "actions": {
                    "send": { "available": true },
                    "interrupt": { "available": true },
                    "approve": { "available": false, "reason": "NO_PENDING_APPROVAL" },
                    "switchModel": { "available": true },
                    "switchReasoning": { "available": false, "reason": "CAPABILITY_UNSUPPORTED" },
                    "switchWorkspace": { "available": false, "reason": "TURN_RUNNING", "retryable": true }
                  },
                  "external": { "provider": "codex-app-server" }
                },
                {
                  "id": "logical:claude",
                  "title": "Claude",
                  "agent": "Claude",
                  "status": "running",
                  "progress": 0.5,
                  "summary": "Working",
                  "updatedAt": "2026-08-08T00:00:00.000Z",
                  "accent": "mint",
                  "capabilities": { "canSend": false, "canInterrupt": false },
                  "actions": {
                    "send": { "available": true },
                    "interrupt": { "available": true },
                    "approve": { "available": false, "reason": "NO_PENDING_APPROVAL" },
                    "switchModel": { "available": true },
                    "switchReasoning": { "available": false, "reason": "CAPABILITY_UNSUPPORTED" },
                    "switchWorkspace": { "available": false, "reason": "TURN_RUNNING", "retryable": true }
                  },
                  "external": { "provider": "claude-sdk" }
                }
              ]
            }
            """.utf8
        )

        let sessions = try await BackendResponseDecoder.sessions(from: data)
        XCTAssertEqual(sessions.map(\.canSendNow), [true, true])
        XCTAssertEqual(sessions.map(\.canInterruptNow), [true, true])
        XCTAssertEqual(sessions.map(\.canSwitchModelNow), [true, true])
    }
}
