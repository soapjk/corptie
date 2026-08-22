import Testing
@testable import CorptieMac

@MainActor
struct ManagedWorktreeGitHubPushPolicyTests {
    @Test func onlyAvailablePendingGitHubBranchesCanPush() {
        #expect(ManagedWorktreeGitHubPushPolicy.canPush(worktree(push: push())) == true)
        #expect(ManagedWorktreeGitHubPushPolicy.canPush(worktree(push: push(pending: false))) == false)
        #expect(ManagedWorktreeGitHubPushPolicy.canPush(worktree(push: push(available: false, error: "No GitHub remote"))) == false)
        #expect(ManagedWorktreeGitHubPushPolicy.canPush(worktree(availability: "missing", push: push())) == false)
        #expect(ManagedWorktreeGitHubPushPolicy.canPush(worktree(push: nil)) == false)
    }

    @Test func disabledPushesHaveActionableExplanations() {
        let noRemote = worktree(push: push(available: false, error: "No supported GitHub remote is configured."))
        #expect(ManagedWorktreeGitHubPushPolicy.explanation(for: noRemote).contains("No supported GitHub remote"))
        #expect(!ManagedWorktreeGitHubPushPolicy.explanation(for: worktree(push: push(pending: false))).isEmpty)
        #expect(!ManagedWorktreeGitHubPushPolicy.explanation(for: worktree(availability: "missing", push: push())).isEmpty)
    }

    private func push(
        available: Bool = true,
        pending: Bool = true,
        error: String? = nil
    ) -> GitHubPushStatus {
        GitHubPushStatus(
            available: available,
            pending: pending,
            dirty: false,
            unpushedCommitCount: pending ? 1 : 0,
            branch: "feature/push",
            destinationUrl: available ? "https://github.com/example/repository" : nil,
            error: error
        )
    }

    private func worktree(
        availability: String = "available",
        push: GitHubPushStatus?
    ) -> ManagedWorktree {
        ManagedWorktree(
            worktreeId: "worktree:push",
            path: "/repo/push",
            isMain: false,
            availability: availability,
            headOid: "abc123",
            branchName: "feature/push",
            isDetached: false,
            isLocked: false,
            lockReason: nil,
            isPrunable: false,
            pruneReason: nil,
            state: "clean",
            dirty: false,
            statusSummary: "",
            diffStat: "",
            changedFiles: [],
            operationState: nil,
            conflictFiles: [],
            mergedIntoMain: false,
            synchronizedWithMain: false,
            aheadOfMain: 1,
            behindMain: 0,
            pendingIntegration: true,
            associations: [],
            deletionBlocker: nil,
            gitHubPush: push
        )
    }
}
