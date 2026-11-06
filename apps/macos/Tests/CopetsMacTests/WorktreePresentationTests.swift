import AppKit
import SwiftUI
import CorptieClientCore
import Foundation
import XCTest
@testable import CorptieMac

@MainActor
final class WorktreePresentationTests: XCTestCase {
    func testStaleRegistrationUsesServerCapabilityAndSeparateCleanupScope() throws {
        let json = #"{"worktreeId":"stale","path":"/isolated/missing","isMain":false,"availability":"missing","isDetached":true,"isLocked":false,"isPrunable":true,"state":"unavailable","changedFiles":[],"conflictFiles":[],"pendingIntegration":true,"associations":[],"cleanupAction":{"kind":"remove_stale_registration","available":true}}"#
        let tree = try JSONDecoder().decode(ManagedWorktree.self, from: Data(json.utf8))
        XCTAssertTrue(tree.isStaleRegistration)
        XCTAssertNil(ManagedWorktreeDeletionPolicy.blocker(for: tree))
        XCTAssertTrue(ManagedWorktreeDeletionPolicy.eligibleWorktrees(from: [tree]).isEmpty)
        let blockedJSON = json.replacingOccurrences(of: "\"available\":true", with:
            "\"available\":false,\"blocker\":{\"code\":\"WORKTREE_IN_USE\",\"reason\":\"Bound Session\"}")
            .replacingOccurrences(of: "\"associations\":[]", with:
                "\"associations\":[],\"deletionBlocker\":{\"code\":\"WORKTREE_IN_USE\",\"reason\":\"Bound Session\"}")
        let blocked = try JSONDecoder().decode(ManagedWorktree.self, from: Data(blockedJSON.utf8))
        XCTAssertEqual(ManagedWorktreeDeletionPolicy.blocker(for: blocked)?.code, "WORKTREE_IN_USE")
    }

    func testColumnBackgroundCoversCornersAndEmptyHeight() async throws {
        _ = NSApplication.shared
        let host = NSHostingView(rootView: Text("Fixture")
            .modifier(WorktreePanel(sidebar: true))
            .background(Color(red: 1, green: 0, blue: 1)))
        host.frame = NSRect(x: 0, y: 0, width: 240, height: 600)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(60))
        host.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        for point in [(0, 0), (bitmap.pixelsWide - 1, 0), (0, bitmap.pixelsHigh - 1), (bitmap.pixelsWide - 1, bitmap.pixelsHigh - 1)] {
            let color = try XCTUnwrap(bitmap.colorAt(x: point.0, y: point.1)?.usingColorSpace(.deviceRGB))
            // The former rounded clip exposed the magenta parent in these corners.
            XCTAssertGreaterThan(color.greenComponent, 0.03)
            XCTAssertGreaterThan(color.alphaComponent, 0.99)
        }
    }

    func testLayoutHysteresisDoesNotFlapOrPersistBusinessSelection() {
        XCTAssertEqual(WorktreeLayoutMode.threeColumns.resized(to: 969), .twoColumns)
        XCTAssertEqual(WorktreeLayoutMode.twoColumns.resized(to: 980), .twoColumns)
        XCTAssertEqual(WorktreeLayoutMode.twoColumns.resized(to: 994), .threeColumns)
        XCTAssertEqual(WorktreeLayoutMode.twoColumns.resized(to: 739), .compact)
        XCTAssertEqual(WorktreeLayoutMode.compact.resized(to: 750), .compact)
        XCTAssertEqual(WorktreeLayoutMode.compact.resized(to: 764), .twoColumns)
        XCTAssertEqual(WorktreeLayoutMode.compact.resized(to: 1200), .threeColumns)
        XCTAssertEqual(WorktreeLayoutMode.threeColumns.resized(to: .nan), .threeColumns)
    }

    func testUnknownDirtyIsNeitherCleanNorZeroChanges() throws {
        let unknown = try tree("unknown", dirty: nil)
        let dirty = try tree("dirty", dirty: true)
        let clean = try tree("clean", dirty: false)
        XCTAssertNotEqual(WorktreePresentationPolicy.changeSummary(unknown), WorktreePresentationPolicy.changeSummary(clean))
        XCTAssertNotEqual(WorktreePresentationPolicy.changeSummary(dirty), WorktreePresentationPolicy.changeSummary(clean))
        XCTAssertEqual(WorktreePresentationPolicy.localState(unknown).symbol, "questionmark.circle")
        XCTAssertTrue(WorktreeStatusFilter.attention.includes(unknown))
        XCTAssertFalse(WorktreeStatusFilter.changed.includes(unknown))
    }

    func testFilteringAndBatchSelectionUseMatchingItemsNotWholeInventory() throws {
        let trees = [try tree("Feature One"), try tree("Feature Two"), try tree("Other"), try tree("Feature Blocked", operation: "rebase")]
        let projection = WorktreeListProjection(trees: trees, query: " feature    one ")
        XCTAssertEqual(projection.matches, ["Feature One"])
        XCTAssertEqual(projection.eligibleMatches, ["Feature One"])
        let features = WorktreeListProjection(trees: trees, query: "FEATURE")
        XCTAssertEqual(features.matches.count, 3)
        XCTAssertEqual(features.eligibleMatches.count, 2)
        XCTAssertNil(WorktreePresentationPolicy.batchBlocker(trees[0]))
        XCTAssertNotNil(WorktreePresentationPolicy.batchBlocker(trees[3]))
    }

    func testConflictOutranksDirtyAndHasSpecificBatchBlocker() throws {
        let conflict = try tree("conflicted", dirty: true, conflicts: ["file.swift"])
        XCTAssertEqual(WorktreePresentationPolicy.localState(conflict).symbol, "exclamationmark.triangle")
        XCTAssertNotNil(WorktreePresentationPolicy.batchBlocker(conflict))
        XCTAssertTrue(WorktreeStatusFilter.attention.includes(conflict))
    }

    func testUnavailableInventoryStaysIdentifiableAndDoesNotClaimClean() throws {
        let missing = try tree("missing", dirty: false, availability: "missing")
        XCTAssertEqual(WorktreePresentationPolicy.localState(missing).symbol, "exclamationmark.triangle")
        XCTAssertTrue(WorktreeStatusFilter.unavailable.includes(missing))
        XCTAssertNotNil(WorktreePresentationPolicy.batchBlocker(missing))
        XCTAssertEqual(WorktreeListProjection(trees: [missing], filter: .unavailable).visible(expanded: [], repositoryID: "r").map(\.worktreeId), ["missing"])
    }

    func testFilteringChildRetainsAncestorsWithoutSelectingContextRows() throws {
        let parent = try tree("parent")
        var child = try tree("needle")
        let actions = ["createChild", "mergeChildren", "syncChildren", "mergeToParent", "syncFromParent", "syncFromMain", "promoteToMain"]
        let hierarchy: [String: Any] = [
            "version": 1, "role": "child", "taskId": "task:child", "rootTaskId": "task:parent",
            "parentTaskId": "task:parent", "parentWorktreeId": "parent", "hierarchyRevision": 1,
            "bindingRevision": 1, "comparison": ["kind": "parent", "worktreeId": "parent"],
            "childCount": 0, "actions": Dictionary(uniqueKeysWithValues: actions.map { ($0, ["available": false]) })
        ]
        child.hierarchy = try JSONDecoder().decode(WorktreeHierarchy.self, from: JSONSerialization.data(withJSONObject: hierarchy))
        let projection = WorktreeListProjection(trees: [parent, child], query: "needle")
        XCTAssertEqual(projection.visible(expanded: [], repositoryID: "r").map(\.worktreeId), ["parent", "needle"])
        XCTAssertEqual(projection.matches, ["needle"])
        XCTAssertFalse(projection.eligibleMatches.contains("parent"))
        XCTAssertTrue(projection.eligibleMatches.isEmpty) // hierarchy uses its dedicated actions
    }

    func testProjectionPerformanceForTwoHundredTrees() throws {
        let trees = try (0..<200).map { try tree("feature-\($0)", dirty: $0.isMultiple(of: 2)) }
        measure {
            for _ in 0..<20 {
                let projection = WorktreeListProjection(trees: trees, query: "feature", filter: .changed)
                XCTAssertEqual(projection.visible(expanded: [], repositoryID: "r").count, 100)
            }
        }
    }

    func testBatchRefreshDropsOnlyUnavailableAndKeepsHiddenSelections() throws {
        let selected = ["visible", "hidden", "removed", "blocked"]
        let trees = [try tree("visible"), try tree("hidden"), try tree("blocked", operation: "rebase")]
        let reconciled = WorktreeBatchSelectionPolicy.reconcile(selected, trees: trees)
        XCTAssertEqual(reconciled, ["visible", "hidden"])
        XCTAssertEqual(WorktreeBatchSelectionPolicy.adding(["visible", "new"], to: reconciled), ["visible", "hidden", "new"])
    }

    func testDestructiveConfirmationDoesNotBindReturnToDelete() async throws {
        _ = NSApplication.shared
        var executed = 0
        let review = WorktreeDeletionReview(repositoryID: "fixture:repo", repositoryName: "Synthetic repository", tree: try tree("fixture"))
        let host = NSHostingView(rootView: WorktreeDeletionConfirmation(review: review, onConfirm: { executed += 1 }))
        let window = NSWindow(contentRect: NSRect(x: -3000, y: -3000, width: 640, height: 340), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.close(); window.contentView = nil }
        try await Task.sleep(for: .milliseconds(60))
        window.layoutIfNeeded()
        XCTAssertNil(window.defaultButtonCell)
        let enter = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        _ = window.performKeyEquivalent(with: enter)
        XCTAssertEqual(executed, 0)
    }

    private func tree(_ id: String, dirty: Bool? = false, availability: String = "available", operation: String? = nil, conflicts: [String] = []) throws -> ManagedWorktree {
        let object: [String: Any] = [
            "worktreeId": id, "path": "/synthetic/\(id)", "isMain": false,
            "availability": availability, "headOid": "synthetic-head", "branchName": id,
            "isDetached": false, "isLocked": false, "state": "ready",
            "dirty": dirty.map { $0 as Any } ?? NSNull(), "changedFiles": [],
            "operationState": operation.map { $0 as Any } ?? NSNull(), "conflictFiles": conflicts,
            "pendingIntegration": false, "associations": []
        ]
        return try JSONDecoder().decode(ManagedWorktree.self, from: JSONSerialization.data(withJSONObject: object))
    }
}
