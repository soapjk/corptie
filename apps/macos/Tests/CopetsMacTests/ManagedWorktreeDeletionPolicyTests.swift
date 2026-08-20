import Testing
@testable import CorptieMac

struct ManagedWorktreeDeletionPolicyTests {
    @Test func eligibilityRequiresMergedCleanAvailableUnassociatedSafeWorktree() {
        let eligible = worktree(id: "eligible")
        let worktrees = [
            worktree(id: "main", isMain: true),
            eligible,
            worktree(id: "unmerged", merged: false),
            worktree(id: "dirty", dirty: true),
            worktree(id: "occupied", associations: [association(workItemId: nil)]),
            worktree(id: "owned", associations: [association(workItemId: "work_item:one")]),
            worktree(id: "locked", isLocked: true),
            worktree(id: "operating", operationState: "rebase")
        ]

        #expect(ManagedWorktreeDeletionPolicy.eligibleWorktrees(from: worktrees) == [eligible])
        #expect(ManagedWorktreeDeletionPolicy.blocker(for: worktrees[2])?.code == "NOT_MERGED_INTO_MAIN")
        #expect(ManagedWorktreeDeletionPolicy.blocker(for: worktrees[3])?.code == "UNCOMMITTED_CHANGES")
        #expect(ManagedWorktreeDeletionPolicy.blocker(for: worktrees[4])?.code == "WORKTREE_IN_USE")
        #expect(ManagedWorktreeDeletionPolicy.blocker(for: worktrees[5])?.code == "WORK_ITEM_ASSOCIATED")
    }

    @Test func cleanupProgressShowsExactOrdinalAndQuotedGitCommands() {
        let progress = WorktreeCleanupProgress.deleting(
            worktree(id: "feature's worktree"),
            mainPath: "/repo path",
            currentIndex: 2,
            total: 3
        )

        #expect(progress.currentIndex == 2)
        #expect(progress.completed == 1)
        #expect(progress.fraction == 1.0 / 3.0)
        #expect(progress.command == "git -C '/repo path' worktree remove '/repo/feature'\\''s worktree' && git -C '/repo path' branch -d 'feature'\\''s worktree'")
    }

    private func association(workItemId: String?) -> ManagedWorktreeAssociation {
        .init(
            logicalSessionId: "logical:one", sessionId: "session:one", title: "Session",
            active: true, workItemId: workItemId, workItemTitle: workItemId == nil ? nil : "WorkItem"
        )
    }

    private func worktree(
        id: String,
        isMain: Bool = false,
        merged: Bool = true,
        dirty: Bool? = false,
        associations: [ManagedWorktreeAssociation] = [],
        isLocked: Bool = false,
        operationState: String? = nil
    ) -> ManagedWorktree {
        .init(
            worktreeId: id, path: "/repo/\(id)", isMain: isMain, availability: "available",
            headOid: "head", branchName: id, isDetached: false, isLocked: isLocked, lockReason: nil,
            isPrunable: false, pruneReason: nil, state: "ready", dirty: dirty, statusSummary: "",
            diffStat: "", changedFiles: [], operationState: operationState, conflictFiles: [],
            mergedIntoMain: merged, synchronizedWithMain: true, aheadOfMain: 0, behindMain: 0,
            pendingIntegration: false, associations: associations
        )
    }
}
