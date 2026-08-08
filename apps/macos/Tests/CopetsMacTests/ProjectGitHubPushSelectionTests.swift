import Testing
@testable import CorptieMac

struct ProjectGitHubPushSelectionTests {
    @Test func currentWorktreeStatusOverridesLegacyTopLevelStatus() {
        let current = push(branch: "main", commits: 22)
        let fallback = push(branch: "feature", commits: 1)
        let selected = ProjectGitHubPushSelection.status(
            for: worktree(push: current),
            fallback: fallback
        )

        #expect(selected == current)
    }

    @Test func legacySessionResponseRemainsSupported() {
        let fallback = push(branch: "main", commits: 3)
        let selected = ProjectGitHubPushSelection.status(
            for: worktree(push: nil),
            fallback: fallback
        )

        #expect(selected == fallback)
    }

    private func push(branch: String, commits: Int) -> GitHubPushStatus {
        GitHubPushStatus(
            available: true,
            pending: commits > 0,
            dirty: false,
            unpushedCommitCount: commits,
            branch: branch,
            destinationUrl: "https://github.com/example/project",
            error: nil
        )
    }

    private func worktree(push: GitHubPushStatus?) -> ProjectWorktreeStatus {
        ProjectWorktreeStatus(
            worktreeId: "worktree:main",
            path: "/project",
            isMain: true,
            availability: "available",
            headOid: "0123456789",
            branchName: "main",
            state: "main",
            dirty: false,
            mergedIntoMain: true,
            synchronizedWithMain: true,
            serviceContainsChanges: false,
            aheadOfMain: 0,
            behindMain: 0,
            pendingIntegration: false,
            sessions: [],
            gitHubPush: push
        )
    }
}
