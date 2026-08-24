import Foundation
import XCTest
@testable import CorptieMac

final class WorktreeManagementNavigationTests: XCTestCase {
    func testWorktreeTabIsAnIndependentMainNavigationDestination() {
        XCTAssertEqual(AppTab.allCases, [.console, .sessions, .automations, .worktrees, .sessionDSH, .agents])
        XCTAssertEqual(AppTab.worktrees.systemImage, "arrow.triangle.branch")
        XCTAssertEqual(AppTab.worktrees.index, 3)
    }

    func testWorktreeAutomaticLoadWaitsForBackendAndSelectedTab() {
        XCTAssertFalse(WorktreeAutomaticLoadPolicy.shouldLoad(isBackendOnline: false, selectedTab: .worktrees))
        XCTAssertFalse(WorktreeAutomaticLoadPolicy.shouldLoad(isBackendOnline: true, selectedTab: .console))
        XCTAssertTrue(WorktreeAutomaticLoadPolicy.shouldLoad(isBackendOnline: true, selectedTab: .worktrees))
    }

    @MainActor
    func testChatWorktreeNavigationTargetsTheUnifiedTab() {
        let router = AppTabRouter()
        router.openWorktrees(
            repositoryId: "repository:one",
            worktreeId: "wt:feature",
            worktreePath: "/repo-feature"
        )

        XCTAssertEqual(router.selectedTab, .worktrees)
        XCTAssertEqual(
            router.pendingWorktreeTarget,
            WorktreeNavigationTarget(
                repositoryId: "repository:one",
                worktreeId: "wt:feature",
                worktreePath: "/repo-feature"
            )
        )
    }

    func testNavigationSelectsTheAuthoritativeWorktreeIdBeforeAStalePath() {
        let target = WorktreeNavigationTarget(
            repositoryId: "repository:one",
            worktreeId: "wt:feature",
            worktreePath: "/stale/path"
        )
        XCTAssertEqual(
            target.matchingWorktree(in: [
                worktree("wt:main", isMain: true),
                worktree("wt:feature", isMain: false)
            ])?.worktreeId,
            "wt:feature"
        )
    }

    func testNavigationFallsBackToAStandardizedWorktreePath() {
        let target = WorktreeNavigationTarget(
            repositoryId: "repository:one",
            worktreeId: nil,
            worktreePath: "/feature/../feature"
        )
        XCTAssertEqual(
            target.matchingWorktree(in: [worktree("wt:feature", isMain: false)])?.worktreeId,
            "wt:feature"
        )
    }

    func testSessionNavigationSelectsExactWorktreeByIdBeforePathFallback() {
        var selection = WorktreeManagementSelection(repositoryId: "repository:one", worktreeId: "wt:main")
        let worktrees = [worktree("wt:main", isMain: true), worktree("wt:feature", isMain: false)]

        let selected = selection.select(
            target: WorktreeNavigationTarget(
                repositoryId: "repository:one",
                worktreeId: "wt:feature",
                worktreePath: "/stale-session-path"
            ),
            worktrees: worktrees
        )

        XCTAssertTrue(selected)
        XCTAssertEqual(selection.worktreeId, "wt:feature")
    }

    func testSessionNavigationKeepsTargetPendingWhenWorktreeIsNotLoaded() {
        var selection = WorktreeManagementSelection(repositoryId: "repository:one", worktreeId: "wt:main")
        let selected = selection.select(
            target: WorktreeNavigationTarget(
                repositoryId: "repository:one",
                worktreeId: "wt:missing",
                worktreePath: "/missing"
            ),
            worktrees: [worktree("wt:main", isMain: true)]
        )

        XCTAssertFalse(selected)
        XCTAssertEqual(selection.worktreeId, "wt:main")
    }

    func testChatBranchButtonsNoLongerOpenTheLegacyWorktreeWindow() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/FloatingRootView.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        XCTAssertFalse(contents.contains("ProjectWorktreeWindowManager.shared.show"))
        XCTAssertTrue(contents.contains("openWorktreeManagement()"))
    }

    func testWorktreeViewDeclaresThreeColumnAccessibilityContract() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/WorktreeManagementView.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        XCTAssertTrue(contents.contains("NavigationSplitView(columnVisibility:"))
        XCTAssertTrue(contents.contains("worktree.repository.column"))
        XCTAssertTrue(contents.contains("worktree.list.column"))
        XCTAssertTrue(contents.contains("worktree.detail.column"))
        XCTAssertTrue(contents.contains("@ObservedObject private var backendClient = BackendClient.shared"))
        XCTAssertTrue(contents.contains(".task(id: worktreeReloadTrigger)"))
        XCTAssertTrue(contents.contains("guard backendClient.isOnline else"))
        XCTAssertTrue(contents.contains("WorktreeAutomaticLoadPolicy.shouldLoad("))
        XCTAssertTrue(contents.contains("guard backendClient.isOnline, router.selectedTab == .worktrees else"))
        XCTAssertTrue(contents.contains("ScrollViewReader { proxy in"))
        XCTAssertTrue(contents.contains(".task(id: worktreeScrollRequest)"))
        XCTAssertTrue(contents.contains("proxy.scrollTo(request.worktreeId, anchor: .center)"))
        XCTAssertFalse(contents.contains(".task { await client.loadRepositories() }"))
    }

    func testWorktreeTabPushActionCoversLoadingFeedbackAndDisabledReasons() throws {
        let macRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let view = try String(
            contentsOf: macRoot.appendingPathComponent("Sources/CopetsMac/WorktreeManagementView.swift"),
            encoding: .utf8
        )
        let client = try String(
            contentsOf: macRoot.appendingPathComponent("Sources/CopetsMac/WorktreeManagementClient.swift"),
            encoding: .utf8
        )
        let models = try String(
            contentsOf: macRoot.appendingPathComponent("Sources/CopetsMac/WorktreeManagementModels.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(view.contains("L10n(\"Push to GitHub\")"))
        XCTAssertTrue(view.contains("L10n(\"Pushing to GitHub…\")"))
        XCTAssertTrue(view.contains("worktree.push-github.\\(worktree.worktreeId)"))
        XCTAssertTrue(view.contains("ManagedWorktreeGitHubPushPolicy.canPush(worktree)"))
        XCTAssertTrue(view.contains("client.pushingWorktreeIds.contains(worktree.worktreeId)"))
        XCTAssertTrue(client.contains("!pushingWorktreeIds.contains(worktree.worktreeId)"))
        XCTAssertTrue(client.contains("actions/push"))
        XCTAssertTrue(client.contains("guard envelope.result.pushed else"))
        XCTAssertTrue(client.contains("operationNoticeTitle = \"Pushed to GitHub\""))
        XCTAssertTrue(client.contains("errorMessage = error.localizedDescription"))
        XCTAssertTrue(models.contains("push.error ?? L10n(\"This Worktree cannot be pushed to GitHub.\")"))
        XCTAssertTrue(models.contains("This branch is already up to date with GitHub"))
    }

    func testWorktreeStatusOpensProviderNeutralIndividualOperationReview() throws {
        let macRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let view = try String(
            contentsOf: macRoot.appendingPathComponent("Sources/CopetsMac/WorktreeManagementView.swift"),
            encoding: .utf8
        )
        let client = try String(
            contentsOf: macRoot.appendingPathComponent("Sources/CopetsMac/WorktreeManagementClient.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(view.contains("Button { pendingOperation = worktree }"))
        XCTAssertTrue(view.contains("IndividualWorktreeOperationView("))
        XCTAssertTrue(view.contains("worktree.operation.\\(worktree.worktreeId)"))
        XCTAssertTrue(view.contains("L10n(\"Merge into main\")"))
        XCTAssertTrue(view.contains("L10n(\"Synchronize with main\")"))
        XCTAssertTrue(view.contains("private func executeAndDismiss()"))
        XCTAssertTrue(view.contains("worktree.commit-main.\\(worktree.worktreeId)"))
        XCTAssertTrue(view.contains("worktree.isMain, worktree.dirty == true"))
        XCTAssertTrue(view.contains("client.commitMainWorktreeChanges("))
        XCTAssertTrue(view.contains("private func confirmAndDismiss()"))
        XCTAssertTrue(view.contains("onClose()\n        Task"))
        XCTAssertTrue(view.contains("Task { await client.confirmPlan(commitProtectionDecisions: decisions) }"))
        XCTAssertTrue(view.contains("protectionDecisionBinding(for: item.worktreeId)"))
        XCTAssertTrue(view.contains("item.associations.filter(\\.active)"))
        XCTAssertTrue(view.contains("Retry after Manual Resolution"))
        XCTAssertTrue(view.contains("worktree.integrate.retry-manual-conflict"))
        XCTAssertTrue(view.contains("worktree.integrate.blocked-repreflight"))
        XCTAssertTrue(view.contains("worktree.integrate.blocking-risks"))
        XCTAssertTrue(view.contains("if !job.plan.blockingRisks.isEmpty"))
        XCTAssertTrue(view.contains("ForEach(job.plan.blockingRisks.indices"))
        XCTAssertTrue(view.contains("Affected Worktree: %@"))
        XCTAssertTrue(view.contains("Affected Worktree ID: %@"))
        XCTAssertTrue(view.contains("Conflict files: %@"))
        XCTAssertTrue(view.contains("risk.message != localizedMessage"))
        XCTAssertTrue(view.contains("private func repreflightAndReview()"))
        XCTAssertTrue(view.contains("$0.commitStatus != \"not_needed\" || $0.mergeStatus != \"not_needed\""))
        XCTAssertFalse(view.contains("Toggle(L10n(\"Delete this Worktree\")"))
        XCTAssertTrue(client.contains("projects/\\(repositoryId)/workspaces/\\(worktree.worktreeId)/actions/merge"))
        XCTAssertTrue(client.contains("projects/\\(repositoryId)/workspaces/\\(worktree.worktreeId)/actions/commit"))
        XCTAssertTrue(client.contains("func commitMainWorktreeChanges("))
        XCTAssertTrue(client.contains("commitProtectionDecisions.map"))
        XCTAssertTrue(client.contains("await loadRepository(repositoryId)\n            errorMessage = operationError"))
        XCTAssertTrue(client.contains("body: body"))
    }

    func testWorktreeTabExposesConfirmedSafeDeletionAndCleanupResults() throws {
        let macRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let view = try String(
            contentsOf: macRoot.appendingPathComponent("Sources/CopetsMac/WorktreeManagementView.swift"),
            encoding: .utf8
        )
        let client = try String(
            contentsOf: macRoot.appendingPathComponent("Sources/CopetsMac/WorktreeManagementClient.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(view.contains(".contextMenu"))
        XCTAssertTrue(view.contains("worktree.delete.\\(worktree.worktreeId)"))
        XCTAssertTrue(view.contains("worktree.cleanup"))
        XCTAssertTrue(view.contains("Delete this Worktree?"))
        XCTAssertTrue(view.contains("Only these Worktrees"))
        XCTAssertTrue(view.contains("Blocked from cleanup (%d)"))
        XCTAssertTrue(view.contains("worktree.cleanup.blocker.\\(worktree.worktreeId)"))
        XCTAssertTrue(view.contains("localizedDeletionBlocker(blocker)"))
        XCTAssertTrue(view.contains("WorktreeCleanupResultView"))
        XCTAssertTrue(view.contains("Removed: %d   Skipped: %d   Failed: %d"))
        XCTAssertTrue(view.contains("worktree.cleanup.progress"))
        XCTAssertTrue(view.contains("worktree.cleanup.command"))
        XCTAssertTrue(view.contains("Deleting %d of %d: %@"))
        XCTAssertTrue(client.contains("worktree-management/repositories/\\(repositoryId)/worktrees/\\(worktree.worktreeId)/delete"))
        XCTAssertTrue(client.contains("for (offset, worktree) in worktrees.enumerated()"))
        XCTAssertTrue(client.contains("cleanupProgress = .deleting("))
        XCTAssertTrue(client.contains("await loadRepository(repositoryId)"))
    }

    func testStaleIntegrationPlanCanBeRegeneratedAndMustBeReviewedAgain() throws {
        let macRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let view = try String(
            contentsOf: macRoot.appendingPathComponent("Sources/CopetsMac/WorktreeManagementView.swift"),
            encoding: .utf8
        )
        let client = try String(
            contentsOf: macRoot.appendingPathComponent("Sources/CopetsMac/WorktreeManagementClient.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(view.contains("job.requiresPlanRegeneration"))
        XCTAssertTrue(view.contains("worktree.integrate.regenerate"))
        XCTAssertTrue(view.contains("if await client.regeneratePlan()"))
        XCTAssertTrue(view.contains("showingPlan = true"))
        XCTAssertTrue(client.contains("worktree-management/jobs/\\(staleJob.id)/cancel"))
        XCTAssertTrue(client.contains("body: [\"replan\": true]"))
    }

    func testStateDriftFailuresRequireRepreflightInsteadOfBlindRetry() {
        for code in [
            "PLAN_STALE", "MAIN_HEAD_CHANGED", "MAIN_DIRTY",
            "WORKTREE_HEAD_CHANGED", "WORKTREE_CHANGES_CHANGED", "UNRELATED_MERGE_IN_PROGRESS"
        ] {
            XCTAssertTrue(WorktreeIntegrationRecoveryPolicy.requiresRepreflight(
                status: "paused", phase: "failed", auditCode: code
            ))
        }
        XCTAssertFalse(WorktreeIntegrationRecoveryPolicy.requiresRepreflight(
            status: "paused", phase: "conflict", auditCode: "MERGE_CONFLICT"
        ))
    }

    func testRunningIntegrationCanStopSafelyAndAutomaticallyRepreflight() throws {
        let macRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let view = try String(
            contentsOf: macRoot.appendingPathComponent("Sources/CopetsMac/WorktreeManagementView.swift"),
            encoding: .utf8
        )
        let client = try String(
            contentsOf: macRoot.appendingPathComponent("Sources/CopetsMac/WorktreeManagementClient.swift"),
            encoding: .utf8
        )
        let models = try String(
            contentsOf: macRoot.appendingPathComponent("Sources/CopetsMac/WorktreeManagementModels.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(view.contains("Stop this task and generate a new integration plan?"))
        XCTAssertTrue(view.contains("worktree.integrate.stop-and-repreflight"))
        XCTAssertTrue(view.contains("Task { await client.stopAndRepreflight() }"))
        XCTAssertTrue(view.contains("Corptie aborts only that merge and verifies main is clean"))
        XCTAssertTrue(view.contains("replanning_cleanup_failed"))
        XCTAssertFalse(view.contains("Conflicts are preserved for review"))
        XCTAssertTrue(client.contains("func stopAndRepreflight() async"))
        XCTAssertTrue(client.contains("body: [\"replan\": true]"))
        XCTAssertTrue(models.contains("cancellation_requested"))
        XCTAssertTrue(models.contains("replanning"))
        XCTAssertTrue(models.contains("phase == \"plan_stale\""))
    }

    func testMergeConflictCanLaunchAndOpenAProviderNeutralAgentSession() throws {
        let macRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let view = try String(
            contentsOf: macRoot.appendingPathComponent("Sources/CopetsMac/WorktreeManagementView.swift"),
            encoding: .utf8
        )
        let client = try String(
            contentsOf: macRoot.appendingPathComponent("Sources/CopetsMac/WorktreeManagementClient.swift"),
            encoding: .utf8
        )
        let models = try String(
            contentsOf: macRoot.appendingPathComponent("Sources/CopetsMac/WorktreeManagementModels.swift"),
            encoding: .utf8
        )

        XCTAssertTrue(view.contains("worktree.integrate.resolve-with-agent"))
        XCTAssertTrue(view.contains("worktree.integrate.open-conflict-agent"))
        XCTAssertTrue(view.contains("router.openSession(sessionId)"))
        XCTAssertTrue(view.contains("Task { await client.resolveConflictWithAgent() }"))
        XCTAssertTrue(view.contains("job.currentConflictResolution"))
        XCTAssertTrue(view.contains("Let Agent Resolve Conflicts"))
        XCTAssertFalse(view.contains("currentConflictItem(job)?.associations.contains"))
        XCTAssertTrue(view.contains("View Agent Session"))
        XCTAssertTrue(view.contains("conflictAgentProgress(job: job, resolution: resolution)"))
        XCTAssertTrue(view.contains("validating and continuing automatically"))
        XCTAssertTrue(view.contains("main remains untouched until validation passes"))
        XCTAssertTrue(view.contains("The Agent result was not promoted"))
        XCTAssertTrue(view.contains("Revalidate and Continue"))
        XCTAssertTrue(view.contains("worktree.integrate.retry-agent-conflicts"))
        XCTAssertTrue(view.contains("Automatic conflict resolution is blocked at %@."))
        XCTAssertTrue(view.contains("Conflicting files: %@"))
        XCTAssertTrue(view.contains("Integration plan completed. All planned Worktrees reached a final state."))
        XCTAssertTrue(view.contains("finalWorktreeStatuses(job)"))
        XCTAssertFalse(view.contains("resolution.status != \"ready\""))
        XCTAssertFalse(view.contains("if let sessionId = await client.resolveConflictWithAgent()"))
        XCTAssertTrue(view.contains("client.job?.shouldPoll == true"))
        XCTAssertTrue(client.contains("worktree-management/jobs/\\(job.id)/resolve-conflict"))
        XCTAssertTrue(client.contains("func resolveConflictWithAgent() async"))
        XCTAssertTrue(client.contains("await AppStateSyncController.shared.refreshSnapshot()"))
        XCTAssertTrue(client.contains("if changed { job = envelope.job }"))
        XCTAssertTrue(models.contains("let conflictAutomation: WorktreeConflictAutomation?"))
        XCTAssertFalse(client.contains("return envelope.job.currentConflictResolution?.sessionId"))
        XCTAssertFalse(client.contains("codex"))
        XCTAssertFalse(client.contains("claude"))
    }

    func testWorktreeTabHasChineseTranslationsForUIAndBackendStatuses() throws {
        let macRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let localization = try String(
            contentsOf: macRoot.appendingPathComponent(
                "Sources/CopetsMac/Resources/zh-Hans.lproj/Localizable.strings"
            ),
            encoding: .utf8
        )

        for expected in [
            "\"Worktrees\" = \"Worktree\";",
            "\"Repository Workspaces\" = \"仓库工作区\";",
            "\"Review Plan\" = \"查看计划\";",
            "\"Preflight complete\" = \"预检完成\";",
            "\"Not needed\" = \"无需处理\";",
            "\"Pending merge\" = \"待合并\";",
            "\"Development Service\" = \"开发服务\";",
            "\"Inspecting Worktree changes…\" = \"正在检查 Worktree 修改…\";",
            "\"Protected local files were detected.\" = \"检测到受保护的本地文件。\";",
            "\"Operations run in the displayed order. No remote push or deletion is performed.\" = \"操作将按显示顺序执行；不会远程推送或删除任何内容。\";",
            "\"No Worktree changes require integration.\" = \"没有需要集成的 Worktree 修改。\";",
            "\"Regenerate Plan\" = \"重新生成计划\";",
            "\"Generate Integration Plan\" = \"生成集成计划\";",
            "\"Stop and Re-preflight\" = \"停止并重新生成计划\";",
            "\"Stopping at a safe boundary\" = \"正在安全步骤边界停止\";",
            "\"The integration plan is stale. Regenerate and review it before continuing.\" = \"代码状态已变化，当前集成计划已失效。请重新生成并审阅后再继续。\";",
            "\"Let Agent Resolve Conflicts\" = \"让 Agent 一键解决冲突\";",
            "\"View Agent Session\" = \"查看 Agent 会话\";",
            "\"Conflict resolved; continuing automatically\" = \"冲突已解决，正在自动继续\";",
            "\"Agent resolved the conflicts; validating and continuing automatically…\" = \"Agent 已解决冲突，正在验证并自动继续…\";",
            "\"Blocking risk details\" = \"阻断风险详情\";",
            "\"Affected Worktree: %@\" = \"受影响的 Worktree：%@\";",
            "\"Affected Worktree ID: %@\" = \"受影响的 Worktree ID：%@\";",
            "\"Conflict files: %@\" = \"冲突文件：%@\";"
        ] {
            XCTAssertTrue(localization.contains(expected), "Missing localization: \(expected)")
        }
    }

    func testRemovedRepositoryAndWorktreeFallBackWithoutStaleSelection() {
        let first = repository("repository:first")
        let second = repository("repository:second")
        var selection = WorktreeManagementSelection(
            repositoryId: second.id,
            worktreeId: "wt:removed"
        )

        selection.reconcile(
            repositories: [first],
            worktrees: [worktree("wt:main", isMain: true), worktree("wt:feature", isMain: false)]
        )

        XCTAssertEqual(selection.repositoryId, first.id)
        XCTAssertEqual(selection.worktreeId, "wt:main")
    }

    func testEmptyInventoryClearsBothSelections() {
        var selection = WorktreeManagementSelection(repositoryId: "repository:gone", worktreeId: "wt:gone")
        selection.reconcile(repositories: [], worktrees: [])
        XCTAssertNil(selection.repositoryId)
        XCTAssertNil(selection.worktreeId)
    }

    func testBackendJobContractDecodesProgressConflictAndAuditForUIRecovery() throws {
        let json = #"""
        {
          "id":"job:1","repositoryId":"repository:1","status":"paused","phase":"conflict",
          "planFingerprint":"abc","error":"Resolve conflicts","createdAt":"2026-08-19T00:00:00Z",
          "updatedAt":"2026-08-19T00:01:00Z","confirmedAt":"2026-08-19T00:00:30Z","completedAt":null,
          "currentWorktreeId":"wt:feature","progress":{"completed":2,"total":3,"fraction":0.666},
          "conflictResolution":{"status":"running","worktreeId":"wt:feature","conflictKey":"conflict:1","workspace":{"worktreeId":"wt:integration","path":"/integration","branchName":"integration/job-1","headOid":"main:1"},"workItemId":"work_item:conflict","sessionId":"session:conflict","agentId":"agent:one","agentName":"Conflict Agent"},
          "conflictAutomation":{"status":"blocked","scopeWorktreeIds":["wt:feature","wt:next"],"completedWorktreeIds":[],"currentWorktreeId":"wt:feature","blockedWorktreeId":"wt:feature","conflictFiles":["shared.swift"],"failureCode":"CONFLICT_AGENT_STOPPED","failureReason":"Agent stopped","startedAt":"2026-08-19T00:00:45Z","completedAt":null},
          "audit":[{"at":"2026-08-19T00:01:00Z","event":"merge_paused","worktreeId":"wt:feature","code":"MERGE_CONFLICT"}],
          "plan":{"repositoryId":"repository:1","mainWorktreeId":"wt:main","mainPath":"/repo",
            "mainHeadBefore":"main:1","inventoryVersion":"inventory:1","mergeOrder":["wt:feature"],
            "blockingRisks":[],"items":[{"ordinal":1,"worktreeId":"wt:feature","path":"/feature",
              "branchName":"feature/one","isMain":false,"availability":"available","sourceHeadBefore":"head:1",
              "statusSummary":"","changedFiles":[],"dirty":false,"aheadOfMain":1,"behindMain":0,
              "mergedIntoMain":false,"associations":[],"risks":[],"commitMessage":null,
              "commitStatus":"not_needed","commitHead":null,"mergeStatus":"conflict","mergeMainHead":null,
              "conflictFiles":["shared.swift"],"error":"Resolve conflicts"}]}
        }
        """#
        let job = try JSONDecoder().decode(WorktreeIntegrationJob.self, from: Data(json.utf8))
        XCTAssertEqual(job.status, "paused")
        XCTAssertEqual(job.currentWorktreeId, "wt:feature")
        XCTAssertEqual(job.plan.items[0].conflictFiles, ["shared.swift"])
        XCTAssertEqual(job.audit[0].event, "merge_paused")
        XCTAssertFalse(job.isActive)
        XCTAssertFalse(job.requiresPlanRegeneration)
        XCTAssertTrue(job.hasMergeConflict)
        XCTAssertEqual(job.conflictResolution?.sessionId, "session:conflict")
        XCTAssertEqual(job.conflictResolution?.workspace.path, "/integration")
        XCTAssertEqual(job.currentConflictResolution?.sessionId, "session:conflict")
        XCTAssertEqual(job.conflictAutomation?.scopeWorktreeIds, ["wt:feature", "wt:next"])
        XCTAssertEqual(job.conflictAutomation?.blockedWorktreeId, "wt:feature")
        XCTAssertEqual(job.conflictAutomation?.conflictFiles, ["shared.swift"])
        XCTAssertEqual(job.conflictAutomation?.failureReason, "Agent stopped")
        XCTAssertTrue(job.shouldPoll)

        let staleJSON = json.replacingOccurrences(
            of: "\"worktreeId\":\"wt:feature\",\"conflictKey\"",
            with: "\"worktreeId\":\"wt:previous\",\"conflictKey\""
        )
        let staleJob = try JSONDecoder().decode(WorktreeIntegrationJob.self, from: Data(staleJSON.utf8))
        XCTAssertNil(staleJob.currentConflictResolution)
        XCTAssertFalse(staleJob.shouldPoll)
    }

    func testWorktreeJobPollingIsBoundedAndBacksOffWithoutExceedingFiveSeconds() {
        XCTAssertEqual(WorktreeJobPollingPolicy.maximumUnchangedPolls, 720)
        XCTAssertEqual(WorktreeJobPollingPolicy.delaySeconds(afterUnchangedPolls: 0), 1)
        XCTAssertEqual(WorktreeJobPollingPolicy.delaySeconds(afterUnchangedPolls: 4), 2)
        XCTAssertEqual(WorktreeJobPollingPolicy.delaySeconds(afterUnchangedPolls: 100), 5)
    }

    private func repository(_ id: String) -> ManagedRepository {
        ManagedRepository(
            id: id, path: "/repo/.git", name: id, discoveredAt: "now", lastValidatedAt: "now",
            mainPath: "/repo", availability: "available", worktreeCount: 2
        )
    }

    private func worktree(_ id: String, isMain: Bool) -> ManagedWorktree {
        ManagedWorktree(
            worktreeId: id, path: isMain ? "/repo" : "/feature", isMain: isMain,
            availability: "available", headOid: "head", branchName: isMain ? "main" : "feature/one",
            isDetached: false, isLocked: false, lockReason: nil, isPrunable: false, pruneReason: nil,
            state: "clean", dirty: false,
            statusSummary: "", diffStat: "", changedFiles: [], operationState: nil, conflictFiles: [],
            mergedIntoMain: isMain, synchronizedWithMain: true, aheadOfMain: 0, behindMain: 0,
            pendingIntegration: false, associations: [], deletionBlocker: nil
        )
    }
}
