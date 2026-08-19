import Foundation
import XCTest
@testable import CorptieMac

final class WorktreeManagementNavigationTests: XCTestCase {
    func testWorktreeTabIsAnIndependentMainNavigationDestination() {
        XCTAssertEqual(AppTab.allCases, [.console, .sessions, .worktrees, .sessionDSH, .agents])
        XCTAssertEqual(AppTab.worktrees.systemImage, "arrow.triangle.branch")
        XCTAssertEqual(AppTab.worktrees.index, 2)
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
            worktreePath: "/repo-feature"
        )

        XCTAssertEqual(router.selectedTab, .worktrees)
        XCTAssertEqual(
            router.pendingWorktreeTarget,
            WorktreeNavigationTarget(repositoryId: "repository:one", worktreePath: "/repo-feature")
        )
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
        XCTAssertFalse(contents.contains(".task { await client.loadRepositories() }"))
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
        XCTAssertTrue(view.contains("private func confirmAndDismiss()"))
        XCTAssertTrue(view.contains("onClose()\n        Task"))
        XCTAssertTrue(view.contains("isPresented = false\n        Task { await client.confirmPlan() }"))
        XCTAssertTrue(view.contains("$0.commitStatus != \"not_needed\" || $0.mergeStatus != \"not_needed\""))
        XCTAssertFalse(view.contains("Toggle(L10n(\"Delete this Worktree\")"))
        XCTAssertTrue(client.contains("projects/\\(repositoryId)/workspaces/\\(worktree.worktreeId)/actions/merge"))
        XCTAssertTrue(client.contains("body: body"))
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
            "\"No Worktree changes require integration.\" = \"没有需要集成的 Worktree 修改。\";"
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
          "audit":[{"at":"2026-08-19T00:01:00Z","event":"merge_paused","worktreeId":"wt:feature"}],
          "plan":{"repositoryId":"repository:1","mainWorktreeId":"wt:main","mainPath":"/repo",
            "mainHeadBefore":"main:1","inventoryVersion":"inventory:1","mergeOrder":["wt:feature"],
            "blockingRisks":[],"items":[{"ordinal":1,"worktreeId":"wt:feature","path":"/feature",
              "branchName":"feature/one","isMain":false,"availability":"available","sourceHeadBefore":"head:1",
              "statusSummary":"","changedFiles":[],"dirty":false,"aheadOfMain":1,"behindMain":0,
              "mergedIntoMain":false,"associations":[],"risks":[],"commitMessage":null,
              "commitStatus":"not_needed","commitHead":null,"mergeStatus":"conflict","mergeMainHead":null,
              "conflictFiles":["shared.swift"],"error":"Resolve conflicts"}]}
        }
        """#.data(using: .utf8)!
        let job = try JSONDecoder().decode(WorktreeIntegrationJob.self, from: json)
        XCTAssertEqual(job.status, "paused")
        XCTAssertEqual(job.currentWorktreeId, "wt:feature")
        XCTAssertEqual(job.plan.items[0].conflictFiles, ["shared.swift"])
        XCTAssertEqual(job.audit[0].event, "merge_paused")
        XCTAssertFalse(job.isActive)
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
            isDetached: false, isLocked: false, lockReason: nil, state: "clean", dirty: false,
            statusSummary: "", diffStat: "", changedFiles: [], operationState: nil, conflictFiles: [],
            mergedIntoMain: isMain, synchronizedWithMain: true, aheadOfMain: 0, behindMain: 0,
            pendingIntegration: false, associations: []
        )
    }
}
