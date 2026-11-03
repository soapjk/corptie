import Foundation
import Testing
@testable import CorptieMac

struct WorktreeIntegrationGraphTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CORPTIE_INTERACTION_TEST"] == "1"))
    func longDiagnosticExpansionReceivesMouseInputAndReachesTheScreen() async throws {
        let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let executable = package.appendingPathComponent(".build/debug/WorktreeDiagnosticInteractionHarness")
        let result = try await Task.detached {
            let process = Process(), output = Pipe()
            process.executableURL = executable
            process.standardOutput = output; process.standardError = output
            try process.run()
            let bytes = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return (process.terminationStatus, String(decoding: bytes, as: UTF8.self))
        }.value
        print(result.1)
        #expect(result.0 == 0)
        #expect(result.1.contains("DIAGNOSTIC_INTERACTION_PASSED"),
                "Native host must report actual mouse-to-screen verification, not merely exit successfully.")
    }

    @MainActor @Test func driftRecoveryUsesServerActionsAndKeepsCompleteDiagnostics() throws {
        let bytes = Data(#"{"id":"job","repositoryId":"repo","status":"paused","phase":"failed","planFingerprint":"fingerprint","createdAt":"now","updatedAt":"now","availableActions":["repreflight","cancel"],"recovery":{"kind":"repreflight","message":"Generate a fresh plan"},"plan":{"repositoryId":"repo","mainWorktreeId":"main","mainPath":"/repo","inventoryVersion":"one","mergeOrder":[],"blockingRisks":[],"items":[]},"progress":{"completed":2,"total":5,"fraction":0.4},"audit":[{"at":"now","event":"execution_paused","code":"MAIN_HEAD_CHANGED"}]}"#.utf8)
        var value = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
        let diagnostic = String(repeating: "Git diagnostic\n", count: 2_000) + "LAST_DETAIL"
        value["diagnosticText"] = diagnostic
        let job = try JSONDecoder().decode(WorktreeIntegrationJob.self, from: JSONSerialization.data(withJSONObject: value))
        #expect(job.requiresPlanRegeneration)
        #expect(!job.supports("retry"))
        #expect(job.canCancel)
        #expect(job.diagnosticText == diagnostic)
        #expect(!job.shouldPoll)
    }

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
