import Foundation
import Testing

@testable import CorptieMac

struct WorkspaceRecoveryStatusTests {
    @Test
    func missingWorkspaceBlocksSessionInputAndDecodesRecoveryKind() throws {
        let data = Data(#"""
        {
            "orphaned": true,
            "recoveryKind": "agentWorkspace",
            "originalPath": "/tmp/assistant-workspace",
            "originalBranchName": null,
            "canRebuild": true,
            "worktrees": []
        }
        """#.utf8)

        let status = try JSONDecoder().decode(WorkspaceRecoveryStatus.self, from: data)

        #expect(status.blocksSessionInput)
        #expect(status.recoveryKind == "agentWorkspace")
        #expect(status.canRebuild == true)
    }

    @Test
    func availableWorkspaceDoesNotBlockSessionInput() throws {
        let data = Data(#"""
        {
            "orphaned": false,
            "worktrees": []
        }
        """#.utf8)

        let status = try JSONDecoder().decode(WorkspaceRecoveryStatus.self, from: data)

        #expect(!status.blocksSessionInput)
        #expect(status.recoveryKind == nil)
    }
}
