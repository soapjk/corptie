import Foundation
import Testing

@testable import CorptieMac

struct UnbornRepositoryDecodingTests {
    @Test
    func projectStatusAcceptsAMissingInitialCommit() throws {
        let data = Data(#"""
        {
          "repositoryId": "repository:unborn",
          "mainWorktreeId": "worktree:main",
          "mainPath": "/tmp/unborn",
          "mainBranch": "main",
          "mainHeadOid": null,
          "pendingWorktreeCount": 0,
          "worktrees": []
        }
        """#.utf8)

        let status = try JSONDecoder().decode(ProjectGitStatus.self, from: data)

        #expect(status.mainHeadOid == nil)
    }

    @Test
    func integrationStatusAcceptsAMissingInitialCommit() throws {
        let data = Data(#"""
        {
          "projectId": "repository:unborn",
          "work": { "id": "work:one", "name": "Bootstrap" },
          "mainHeadOid": null,
          "eligibleWorktrees": [],
          "excludedWorktrees": [],
          "eligibleAgents": [],
          "latestRun": null
        }
        """#.utf8)

        let status = try JSONDecoder().decode(ProjectIntegrationStatusResponse.self, from: data)

        #expect(status.mainHeadOid == nil)
    }
}
