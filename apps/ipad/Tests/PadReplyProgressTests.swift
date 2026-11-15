import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMobileState

@MainActor struct PadReplyProgressTests {
    @Test func subagentActivityUpdatesOneMobileCardWithoutLosingMetadata() throws {
        let workspace = PadWorkspace(defaults: UserDefaults(suiteName: "child:\(UUID())")!)
        workspace.selection = "session:a"
        func activity(_ id: String, child: String, event: String, status: String) throws -> ClientMessage {
            let value: [String: Any] = ["id": id, "turnId": "turn", "type": "subAgentActivity",
                "text": "", "turnStatus": "inProgress", "subagentActivity": ["schemaVersion": 1,
                    "activityId": id, "childId": child, "name": "布局检查",
                    "event": event, "status": status]]
            return try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: value))
        }
        let started = try activity("a:1", child: "a", event: "started", status: "running")
        let done = try activity("a:2", child: "a", event: "completed", status: "completed")
        let followup = try activity("a:3", child: "a", event: "interacted", status: "unknown")
        let other = try activity("b:1", child: "b", event: "started", status: "running")
        workspace.messages = [started]
        let processID = try #require(workspace.displayEntries.first?.id)
        #expect(workspace.processSteps[processID]?.first?.state == .running)
        workspace.messages = [started, other, done, done]
        let steps = try #require(workspace.processSteps[processID])
        #expect(steps.map(\.id) == ["subagent:a", "subagent:b"])
        #expect(steps.first?.subagent?.activities.count == 2)
        #expect(steps.first?.state == .completed)
        #expect(workspace.processPresentations[processID]?.subagentCount == 2)
        workspace.messages = [started, other, done, followup]
        #expect(workspace.displayEntries.first?.id == processID)
        #expect(workspace.processSteps[processID]?.first?.id == "subagent:a")
        #expect(workspace.processSteps[processID]?.first?.state == .unknown)
        #expect(workspace.processSteps[processID]?.first?.subagent?.latest.event == "interacted")
        workspace.selection = "session:b"
        #expect(workspace.processSteps.isEmpty)
    }

    private func message(_ id: String, type: String = "agentMessage", role: String? = "commentary",
                         status: String = "running", date: String = "2026-10-31T00:00:01Z") throws -> ClientMessage {
        var value: [String: Any] = ["id": id, "turnId": "turn", "type": type,
            "text": String(repeating: id + "\n", count: 100), "turnStatus": status, "createdAt": date]
        value["presentationRole"] = role
        return try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: value))
    }

    @Test func lifecycleMetadataRefreshesUnchangedProcessPayload() throws {
        let workspace = PadWorkspace(defaults: UserDefaults(suiteName: "reply:\(UUID())")!)
        workspace.selection = "session:a"
        let tool = try message("tool", type: "mcpToolCall", role: nil)
        let streaming = try message("answer", role: "final_answer", date: "2026-10-31T00:00:10Z")
        workspace.messages = [tool, streaming]
        #expect(workspace.processPresentations["process:turn"]?.state == .running)
        let revision = workspace.tailDisplayRevision
        for (status, expected) in [("completed", ConversationProcessState.completed), ("failed", .failed), ("interrupted", .cancelled)] {
            workspace.messages = [tool, try message("answer", role: "final_answer", status: status,
                date: "2026-10-31T00:00:10.234Z")]
            #expect(workspace.processPresentations["process:turn"]?.state == expected)
            #expect(workspace.processSteps["process:turn"]?.map(\.id) == ["tool"])
            #expect(workspace.activeProcessEntryID == nil)
            #expect(workspace.processPresentations["process:turn"]?.duration == "9s")
        }
        #expect(workspace.tailDisplayRevision > revision)
    }

    @Test func commentaryHasCompleteDetailAndBookmarkFollowsItsArchive() throws {
        let defaults = UserDefaults(suiteName: "reply:\(UUID())")!
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "session:a"
        let old = try message("old"), latest = try message("latest")
        workspace.messages = [old, latest]
        #expect(workspace.displayEntries.map(\.id) == ["process:commentary:old", "message:latest"])
        workspace.saveReadingPosition(.init(followsLatest: false, entryID: "message:latest", minY: -12),
            serverID: "server", deviceID: "device", sessionID: "session:a")
        workspace.messages.append(try message("final", role: "final_answer", status: "completed"))
        let bookmark = try #require(workspace.readingPosition(serverID: "server", deviceID: "device", sessionID: "session:a"))
        #expect(bookmark.entryID == "process:commentary:old")
        #expect(bookmark.sourceMessageID == "latest")
        #expect(bookmark.minY == -12)
        #expect(workspace.processCommentaryIDs["process:commentary:old"] == ["old", "latest"])
        #expect(workspace.processSteps["process:commentary:old"]?.map(\.detail) == [old.text, latest.text])
        workspace.selection = "session:b"
        #expect(workspace.timelineRowAliases.isEmpty)
        #expect(workspace.processReplyBounds.isEmpty)
        #expect(workspace.processCommentaryIDs.isEmpty)
    }

    @Test func commentaryOnlyIdentityTransfersToExistingToolCard() throws {
        let workspace = PadWorkspace(defaults: UserDefaults(suiteName: "reply:\(UUID())")!)
        workspace.selection = "session:a"
        let old = try message("old"), latest = try message("latest")
        workspace.messages = [old, latest]
        workspace.messages.append(try message("tool", type: "mcpToolCall", role: nil))
        #expect(workspace.resolveTimelineRowID("process:commentary:old") == "process:turn")
        let bookmark = PadTimelineReadingPosition(followsLatest: false, entryID: "process:commentary:old", minY: -20)
        #expect(bookmark.resolvingRowID(workspace.resolveTimelineRowID).entryID == "process:turn")
        workspace.messages.append(try message("newest"))
        #expect(workspace.resolveTimelineRowID("process:commentary:old") == "process:turn")
        #expect(bookmark.resolvingRowID { workspace.timelineRowAliases[$0] }.entryID == "process:turn")
    }

    @Test func oldBookmarkDecodesAndMissingIdentityDoesNotInventTarget() throws {
        let original = PadTimelineReadingPosition(followsLatest: false, entryID: "message:old", minY: 8)
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(PadTimelineReadingPosition.self, from: data)
        #expect(decoded == original)
        #expect(decoded.sourceMessageID == nil)
        #expect(decoded.resolvingRowID { _ in nil } == original)
    }

    @Test func archivedCommentaryDoesNotEvictFormalHistoryFromWindow() throws {
        let workspace = PadWorkspace(defaults: UserDefaults(suiteName: "reply:\(UUID())")!)
        workspace.selection = "session:a"
        let user = try message("user", type: "userMessage", role: nil)
        let comments = try (0..<100).map { try message("comment:\($0)") }
        let final = try message("final", role: "final_answer", status: "completed")
        workspace.messages = [user] + comments + [final]
        #expect(workspace.displayEntries.count == 3)
        #expect(workspace.displayEntries.first?.id == "message:user")
        #expect(!workspace.hasHiddenDisplayHistory)
        #expect(workspace.processSteps.values.first?.count == 100)
    }
}
