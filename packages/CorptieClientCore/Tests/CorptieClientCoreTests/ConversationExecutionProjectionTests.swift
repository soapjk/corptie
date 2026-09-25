import Foundation
import Testing
@testable import CorptieClientCore

struct ConversationExecutionProjectionTests {
    @Test func unknownOrMalformedPlanDoesNotBreakTheConversation() throws {
        let source: [String: Any] = [
            "id": "plan:future", "type": "executionPlan", "text": "Plan update unavailable",
            "executionPlan": ["schemaVersion": 2, "futureField": "unknown"]
        ]
        let item = try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: source))
        let step = try #require(ConversationExecutionProjection.steps(for: [item]).first)
        #expect(step.plan == nil)
        #expect(step.detail == "Plan update unavailable")
    }

    @Test func structuredPlanKeepsEveryStepInSharedDesktopMobileProjection() throws {
        let source: [String: Any] = [
            "id": "plan:one", "turnId": "turn:one", "turnStatus": "inProgress",
            "type": "executionPlan", "text": "Plan 1/2", "title": "Execution plan",
            "executionPlan": [
                "schemaVersion": 1, "planId": "plan:one", "revision": 2,
                "lifecycle": "active", "updatedAt": "2026-09-24T00:00:00Z",
                "explanation": "Check the current build before editing",
                "steps": [
                    ["stepId": "step:1", "ordinal": 0, "text": "Inspect", "status": "completed"],
                    ["stepId": "step:2", "ordinal": 1, "text": "Implement", "status": "inProgress"]
                ]
            ]
        ]
        let item = try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: source))
        let entries = ConversationTimeline.makeEntries(from: [item])
        #expect(entries.count == 1)
        #expect(entries[0].isProcessGroup)
        let step = try #require(ConversationExecutionProjection.steps(for: [item]).first)
        #expect(step.title == "Plan 1/2")
        #expect(step.plan?.steps.map(\.stepId) == ["step:1", "step:2"])
        #expect(ConversationExecutionProjection.plainText(for: [step]).contains("● Implement"))
        #expect(ConversationExecutionProjection.plainText(for: [step])
            .contains("Check the current build before editing"))
    }

    @Test func failedClaudePlanFromPersistedTimelineNeverAppearsActiveOnEitherClient() throws {
        let source: [String: Any] = [
            "id": "execution-plan:binding:test:turn:test:claude-tasks",
            "turnId": "turn:test", "turnStatus": "failed", "status": "failed",
            "type": "executionPlan", "title": "Execution plan", "text": "Plan 0/1",
            "executionPlan": [
                "schemaVersion": 1, "planId": "execution-plan:binding:test:turn:test:claude-tasks",
                "revision": 3, "lifecycle": "failed", "updatedAt": "2026-09-25T05:05:33Z",
                "steps": [["stepId": "task:7", "ordinal": 0,
                           "text": "Inspect", "status": "unknown"]]
            ]
        ]
        let item = try JSONDecoder().decode(ClientMessage.self,
            from: JSONSerialization.data(withJSONObject: source))
        #expect(ConversationTimeline.makeEntries(from: [item]).map(\.id) == ["process:turn:test"])
        let step = try #require(ConversationExecutionProjection.steps(for: [item]).first)
        #expect(step.state == .failed)
        #expect(step.plan?.lifecycle == "failed")
        #expect(step.plan?.revision == 3)
        #expect(step.plan?.steps.first?.status == "unknown")
        #expect(!ConversationExecutionProjection.plainText(for: [step]).contains("● Inspect"))
    }

    @Test func planRevisionKeepsTheSameProcessAnchorAndDoesNotAddAMessage() throws {
        func item(revision: Int, status: String) throws -> ClientMessage {
            let source: [String: Any] = [
                "id": "plan:one", "turnId": "turn:one", "turnStatus": "inProgress",
                "type": "executionPlan", "text": "Plan 0/1", "title": "Execution plan",
                "executionPlan": ["schemaVersion": 1, "planId": "plan:one", "revision": revision,
                    "lifecycle": "active", "updatedAt": "2026-09-24T00:00:00Z",
                    "steps": [["stepId": "step:1", "ordinal": 0, "text": "Inspect", "status": status]]]
            ]
            return try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: source))
        }
        let first = ConversationTimeline.makeEntries(from: [try item(revision: 1, status: "pending")])
        let updated = ConversationTimeline.makeEntries(from: [try item(revision: 2, status: "completed")])
        #expect(first.map(\.id) == updated.map(\.id))
        #expect(first.count == 1)
        #expect(first[0].displayWeight == 0)
        #expect(updated[0].displayWeight == 0)
    }

    @Test func toolSummariesStayBoundedAndPreserveIdentityAndState() throws {
        let source: [[String: String]] = [
            ["id": "context", "type": "contextCompaction", "text": "compacted", "title": "internal", "turnStatus": "running"],
            ["id": "tool", "type": "commandExecution", "text": "Build:\n" + String(repeating: "x", count: 500), "title": "Build", "status": "failed", "turnStatus": "running"],
            ["id": "progress", "type": "agentMessage", "text": "checking", "turnStatus": "running"]]
        let items = try JSONDecoder().decode([ClientMessage].self, from: JSONSerialization.data(withJSONObject: source))
        let steps = ConversationExecutionProjection.steps(for: items)
        #expect(steps.map(\.id) == ["context", "tool", "progress"])
        #expect(steps.map(\.kind) == [.context, .action, .context])
        #expect(steps.map(\.state) == [.completed, .failed, .running])
        #expect(steps[0].title == "Context compacted")
        #expect(steps[1].detail?.count == 180)
        #expect(steps[1].detail?.hasSuffix("…") == true)
        #expect(steps[1].detail?.contains("Build:") == false)
        #expect(ConversationExecutionProjection.plainText(for: steps).contains("[Execution Action] Build"))
    }

    @Test func structuredToolSeparatesInputAndResultWithoutChangingItsTimelineIdentity() throws {
        func item(status: String, result: String?) throws -> ClientMessage {
            let source: [String: Any] = [
                "id": "tool:one", "turnId": "turn:one", "turnStatus": "inProgress",
                "type": "commandExecution", "title": "Bash", "text": "pwd\n\n/tmp",
                "status": status,
                "toolExecution": ["schemaVersion": 1, "toolId": "tool:one", "name": "Bash",
                    "status": status, "input": "pwd", "result": result ?? NSNull()] as [String: Any]
            ]
            return try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: source))
        }
        let running = try item(status: "running", result: nil)
        let completed = try item(status: "completed", result: "/tmp")
        #expect(ConversationTimeline.makeEntries(from: [running]).map(\.id)
            == ConversationTimeline.makeEntries(from: [completed]).map(\.id))
        let step = try #require(ConversationExecutionProjection.steps(for: [completed]).first)
        #expect(step.state == .completed)
        #expect(step.detail == nil)
        #expect(step.tool?.input == "pwd")
        #expect(step.tool?.result == "/tmp")
        #expect(ConversationExecutionProjection.plainText(for: [step]).contains("Result: /tmp"))
    }

    @Test func unknownToolSchemaFallsBackToLegacyReadableText() throws {
        let source: [String: Any] = ["id": "tool:future", "type": "commandExecution",
            "title": "Bash", "text": "pwd\n/tmp",
            "toolExecution": ["schemaVersion": 2, "toolId": "tool:future", "name": "Bash",
                "status": "completed", "input": "pwd", "result": "/tmp"]]
        let item = try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: source))
        let step = try #require(ConversationExecutionProjection.steps(for: [item]).first)
        #expect(step.tool == nil)
        #expect(step.detail?.contains("/tmp") == true)
    }

    @Test func emptyChecklistIsAReadableUpdateRatherThanZeroOverZero() throws {
        let item = try JSONDecoder().decode(ClientMessage.self, from: Data(
            #"{"id":"plan:empty","turnId":"turn:one","turnStatus":"inProgress","type":"executionPlan","title":"Execution plan","text":"Plan 0/0","status":"running","executionPlan":{"schemaVersion":1,"planId":"plan:empty","revision":2,"lifecycle":"active","updatedAt":"2026-09-25T00:00:00Z","steps":[]}}"#.utf8))
        let step = try #require(ConversationExecutionProjection.steps(for: [item]).first)
        #expect(step.plan?.steps.isEmpty == true)
        #expect(step.plan?.completionFraction == nil)
        #expect(step.title == "No plan steps")
        #expect(!step.title.contains("0/0"))
    }

    @Test func uncertainChecklistDoesNotTurnStaleStepsIntoCurrentProgress() throws {
        let item = try JSONDecoder().decode(ClientMessage.self, from: Data(
            #"{"id":"plan:uncertain","type":"executionPlan","text":"Plan update unavailable","status":"unknown","executionPlan":{"schemaVersion":1,"planId":"plan:uncertain","revision":3,"lifecycle":"unknown","updatedAt":"2026-09-25T00:00:00Z","steps":[{"stepId":"step:1","ordinal":0,"text":"Inspect","status":"completed"},{"stepId":"step:2","ordinal":1,"text":"Build","status":"pending"}]}}"#.utf8))
        let step = try #require(ConversationExecutionProjection.steps(for: [item]).first)
        #expect(step.plan?.steps.count == 2)
        #expect(step.plan?.completionFraction == nil)
        #expect(step.title == "Plan update unavailable")
    }

    @Test func unresolvedToolResultDoesNotAppearCompletedOnEitherClient() throws {
        let item = try JSONDecoder().decode(ClientMessage.self,
            from: Data(#"{"id":"tool:missing","type":"mcpToolCall","title":"TodoWrite","text":"Plan tool result unavailable","status":"unknown","turnStatus":"completed"}"#.utf8))
        let step = try #require(ConversationExecutionProjection.steps(for: [item]).first)
        #expect(step.state == .unknown)
        #expect(step.state.marker == "?")
        #expect(ConversationExecutionProjection.plainText(for: [step]).contains("? [Execution Action] TodoWrite"))
    }

    @Test func settledTurnCannotLeaveAnUnfinishedToolVisuallyRunning() throws {
        func state(for turnStatus: String) throws -> ConversationExecutionStep.State {
            let source = [
                ["id": "tool:stale", "type": "commandExecution", "title": "Build",
                 "text": "Build", "status": "running", "turnStatus": turnStatus],
                ["id": "answer", "type": "agentMessage", "text": "Turn response",
                 "status": "completed", "turnStatus": turnStatus]
            ]
            let items = try JSONDecoder().decode([ClientMessage].self,
                from: JSONSerialization.data(withJSONObject: source))
            return try #require(ConversationExecutionProjection.steps(for: items).first).state
        }
        #expect(try state(for: "running") == .running)
        #expect(try state(for: "completed") == .unknown)
        #expect(try state(for: "failed") == .failed)
        #expect(try state(for: "cancelled") == .cancelled)
    }

    @Test func fileChangeSummaryIsSharedWithoutCreatingAnExtraMessage() throws {
        let source: [String: Any] = ["id": "edit:one", "turnId": "turn:one",
            "turnStatus": "inProgress", "type": "fileChange", "title": "Edit",
            "text": "App.swift", "status": "completed",
            "changeSet": ["schemaVersion": 1, "truncated": false,
                "changes": [["path": "App.swift", "kind": "modify",
                    "diffPreview": "+hello", "diffTruncated": false]]]]
        let item = try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: source))
        let entries = ConversationTimeline.makeEntries(from: [item])
        #expect(entries.count == 1)
        let step = try #require(ConversationExecutionProjection.steps(for: [item]).first)
        #expect(step.changeSet?.changes.first?.path == "App.swift")
        #expect(ConversationExecutionProjection.plainText(for: [step]).contains("• App.swift"))
    }
}
