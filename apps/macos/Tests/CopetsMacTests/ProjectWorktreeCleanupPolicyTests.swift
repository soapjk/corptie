import Testing
@testable import CorptieMac

struct ProjectWorktreeCleanupPolicyTests {
    @Test func keepsOnlyMergedCleanAvailableWorktreesWithoutSessions() {
        let eligible = ProjectWorktreeCleanupPolicy.eligibleWorktrees(from: [
            worktree(id: "main", isMain: true),
            worktree(id: "eligible"),
            worktree(id: "unmerged", merged: false),
            worktree(id: "dirty", dirty: true),
            worktree(id: "unknown-dirty-state", dirty: nil),
            worktree(id: "missing", availability: "missing"),
            worktree(id: "owned", sessions: [
                ProjectWorktreeSession(
                    logicalSessionId: "logical:one",
                    sessionId: "session:one",
                    title: "Session",
                    active: false
                )
            ])
        ])

        #expect(eligible.map(\.worktreeId) == ["eligible"])
    }

    private func worktree(
        id: String,
        isMain: Bool = false,
        availability: String = "available",
        merged: Bool = true,
        dirty: Bool? = false,
        sessions: [ProjectWorktreeSession] = []
    ) -> ProjectWorktreeStatus {
        ProjectWorktreeStatus(
            worktreeId: id,
            path: "/repo/\(id)",
            isMain: isMain,
            availability: availability,
            headOid: "0123456789",
            branchName: id,
            state: "ready",
            dirty: dirty,
            mergedIntoMain: merged,
            synchronizedWithMain: true,
            serviceContainsChanges: false,
            aheadOfMain: 0,
            behindMain: 0,
            pendingIntegration: false,
            sessions: sessions
        )
    }
}
