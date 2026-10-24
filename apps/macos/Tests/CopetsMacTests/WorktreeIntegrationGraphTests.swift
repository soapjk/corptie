import Foundation
import Testing
@testable import CorptieMac

struct WorktreeIntegrationGraphTests {
    @MainActor @Test func decodesReviewedDependencyGraphAndWaitingAcceptanceWithoutExecutionInternals() throws {
        let bytes = Data(#"""
        {"version":1,"requestedWorktreeIds":["child"],"includedWorktreeIds":["parent","child"],
         "addedWorktreeIds":["parent"],"steps":[
          {"id":"step:1","kind":"merge_children","rootTaskId":"task:parent","sourceWorktreeIds":["child"],
           "targetWorktreeId":"parent","sourceBranchNames":["task/child"],"targetBranchName":"task/parent"},
          {"id":"step:2","kind":"acceptance","rootTaskId":"task:parent","sourceWorktreeIds":[],
           "targetWorktreeId":"parent","sourceBranchNames":[],"targetBranchName":"task/parent"}]}
        """#.utf8)
        let graph = try JSONDecoder().decode(WorktreeIntegrationGraph.self, from: bytes)
        #expect(graph.addedWorktreeIds == ["parent"])
        #expect(graph.steps[0].label == "task/child → task/parent")
        #expect(graph.steps[1].label.contains("task/parent"))
        #expect(graph.steps[0].status == nil)
        let execution = Data(#"""
        {"phase":"steps","index":0,"acceptanceSessionId":"session:parent","steps":[
          {"id":"step:2","kind":"acceptance","rootTaskId":"task:parent","sourceWorktreeIds":[],
           "targetWorktreeId":"parent","sourceBranchNames":[],"targetBranchName":"task/parent",
           "status":"waiting","reason":"INTEGRATION_ACCEPTANCE_REQUIRED"}]}
        """#.utf8)
        let state = try JSONDecoder().decode(WorktreeIntegrationGraphExecution.self, from: execution)
        #expect(state.acceptanceSessionId == "session:parent")
        #expect(state.steps[state.index].status == "waiting")
    }

    @Test func mainMergeEntryDoesNotDisableTheWholeRepositoryForHierarchicalMembers() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("Sources/CopetsMac/WorktreeManagementView.swift"), encoding: .utf8)
        #expect(!source.contains(".disabled(project.worktrees.contains{$0.hierarchy != nil}"))
        #expect(source.contains("showingIntegrationSelection = true"))
        #expect(source.contains("graph.addedWorktreeIds"))
        #expect(source.contains("Open Parent Acceptance Session"))
    }
}
