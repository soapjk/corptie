import Foundation
import Testing
import CorptieClientCore
@testable import CorptiePadState

@MainActor
struct PadTimelineProjectionTests {
    @Test func receivedHistoryAndOptimisticMessagesUseSharedGroupingWithoutLosingReplies() throws {
        let name = "pad-projection-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "session:a"
        let messages = try JSONDecoder().decode([ClientMessage].self, from: Data(#"[{"id":"u","turnId":"t","type":"userMessage","text":"question"},{"id":"p","turnId":"t","type":"agentMessage","text":"checking","presentationRole":"commentary","turnStatus":"running"},{"id":"tool","turnId":"t","type":"mcpToolCall","text":"result","turnStatus":"running"},{"id":"a","turnId":"t","type":"agentMessage","text":"answer","presentationRole":"final_answer"}]"#.utf8))
        workspace.messages = messages
        #expect(workspace.displayEntries.map(\.id) == ["message:u", "process:t", "message:a"])
        #expect(workspace.processPresentations["process:t"]?.state == .running)
        #expect(workspace.processPresentations["process:t"]?.duration == nil)
        #expect(workspace.processSteps["process:t"]?.map(\.kind) == [.context, .action])
        #expect(workspace.processPresentations["process:t"]?.currentStepTitle == "Used tool")
        workspace.outgoingMessages["session:a"] = [ClientMessage(id: "pending", text: "next")]
        #expect(workspace.displayEntries.map(\.id) == ["message:u", "process:t", "message:a", "message:pending"])
        workspace.messages.append(ClientMessage(id: "pending", text: "next"))
        #expect(workspace.displayEntries.filter { $0.id == "message:pending" }.count == 1)
        workspace.selection = "session:b"
        #expect(workspace.displayEntries.isEmpty)
        #expect(workspace.processPresentations.isEmpty)
        #expect(workspace.processSteps.isEmpty)
        workspace.selection = "session:a"
        #expect(workspace.displayEntries.map(\.id) == ["message:u", "process:t", "message:a", "message:pending"])
    }
}
