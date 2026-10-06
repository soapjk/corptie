import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMobileState

@MainActor
struct PadTimelineProjectionTests {
    @Test func longProcessCollapseTracksOnlyExpandedCardBoundaries() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CorptieMobileApp.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)
        #expect(contents.contains("ProcessCollapseCandidate(id: entryID"))
        #expect(contents.contains("ProcessCollapsePlacementPolicy.placement("))
        #expect(contents.contains("reader.scrollTo(entryID, anchor: .top)"))
        let stepStart = try #require(contents.range(of: "private struct PadExecutionStepCard: View"))
        #expect(!contents[stepStart.lowerBound...].contains("ProcessCollapseCandidate("))
    }

    @Test func processSummaryUsesTheUsersPreferredLanguage() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CorptieMobileApp.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)
        let start = try #require(contents.range(of: "private struct PadProcessCard: View"))
        let end = try #require(contents.range(of: "private struct TimelineHistoryViewportState"))
        let card = contents[start.lowerBound..<end.lowerBound]
        #expect(card.contains("Locale.preferredLanguages.first ?? \"en\""))
        #expect(!card.contains("locale.language.languageCode"))
        #expect(card.components(separatedBy: ".summary(languageCode: languageCode)").count - 1 == 3)
    }

    @Test func workExpansionStartsCollapsedAndRestoresOnlySavedWorkIDs() {
        let name = "pad-work-expansion-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let store = PadWorkExpansionStore(defaults: defaults)

        #expect(store.load().isEmpty)
        #expect(!store.loadChat())
        store.saveChat(true)
        #expect(PadWorkExpansionStore(defaults: defaults).loadChat())
        store.saveChat(false)
        #expect(!PadWorkExpansionStore(defaults: defaults).loadChat())
        store.save(["work:b", "work:a"])
        #expect(store.load() == ["work:a", "work:b"])
        store.save(["work:b"])
        #expect(store.load() == ["work:b"])
        store.save([])
        #expect(store.load().isEmpty)
    }

    @Test func processClockMatchesDesktopClientSideAdvancementPolicy() {
        #expect(PadProcessClockPolicy.canAdvance(
            isActiveProcess: true,
            clientIsOnline: true,
            sessionExecutionStatus: "running",
            sceneIsActive: true
        ))
        #expect(!PadProcessClockPolicy.canAdvance(
            isActiveProcess: false,
            clientIsOnline: true,
            sessionExecutionStatus: "running",
            sceneIsActive: true
        ))
        #expect(!PadProcessClockPolicy.canAdvance(
            isActiveProcess: true,
            clientIsOnline: false,
            sessionExecutionStatus: "running",
            sceneIsActive: true
        ))
        #expect(!PadProcessClockPolicy.canAdvance(
            isActiveProcess: true,
            clientIsOnline: true,
            sessionExecutionStatus: "completed",
            sceneIsActive: true
        ))
        #expect(!PadProcessClockPolicy.canAdvance(
            isActiveProcess: true,
            clientIsOnline: true,
            sessionExecutionStatus: "running",
            sceneIsActive: false
        ))
    }

    @Test func serverUserInputStatusOverridesLocalSubmittedReceipt() {
        #expect(padUserInputStatusText("pending", submittedLocally: true) == "已提交，等待会话更新")
        #expect(padUserInputStatusText("submitted", submittedLocally: false) == "已提交，等待会话更新")
        #expect(padUserInputStatusText("unknown", submittedLocally: true) == "提交结果待同步，请勿重复提交")
        #expect(padUserInputStatusText("expired", submittedLocally: true) == "此问题已失效")
    }

    @Test func receivedHistoryAndOptimisticMessagesUseSharedGroupingWithoutLosingReplies() throws {
        let name = "pad-projection-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "session:a"
        let messages = try JSONDecoder().decode([ClientMessage].self, from: Data(#"[{"id":"u","turnId":"t","type":"userMessage","text":"question"},{"id":"p","turnId":"t","type":"agentMessage","text":"checking","presentationRole":"commentary","turnStatus":"running"},{"id":"tool","turnId":"t","type":"mcpToolCall","text":"result","turnStatus":"running"},{"id":"a","turnId":"t","type":"agentMessage","text":"answer","presentationRole":"final_answer"}]"#.utf8))
        workspace.messages = messages
        #expect(workspace.displayEntries.map(\.id) == ["message:u", "message:p", "process:t", "message:a"])
        #expect(workspace.processPresentations["process:t"]?.state == .running)
        #expect(workspace.activeProcessEntryID == "process:t")
        #expect(workspace.processPresentations["process:t"]?.duration == nil)
        #expect(workspace.processSteps["process:t"]?.map(\.kind) == [.action])
        #expect(workspace.processPresentations["process:t"]?.currentStepTitle == "Used tool")
        workspace.outgoingMessages["session:a"] = [ClientMessage(id: "pending", text: "next")]
        #expect(workspace.displayEntries.map(\.id) == ["message:u", "message:p", "process:t", "message:a", "message:pending"])
        workspace.messages.append(ClientMessage(id: "pending", text: "next"))
        #expect(workspace.displayEntries.filter { $0.id == "message:pending" }.count == 1)
        workspace.selection = "session:b"
        #expect(workspace.displayEntries.isEmpty)
        #expect(workspace.processPresentations.isEmpty)
        #expect(workspace.activeProcessEntryID == nil)
        #expect(workspace.processSteps.isEmpty)
        workspace.selection = "session:a"
        #expect(workspace.displayEntries.map(\.id) == ["message:u", "message:p", "process:t", "message:a", "message:pending"])
    }

    @Test func messageTimeSeparatorsFollowDesktopGapAndRecomputeAtHistoryBoundary() throws {
        let name = "pad-time-separators-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "session:time"
        let messages = try JSONDecoder().decode([ClientMessage].self, from: Data(#"""
        [
            {"id":"first","type":"userMessage","text":"one","createdAt":"2026-09-27T10:00:00Z"},
            {"id":"near","type":"agentMessage","text":"two","createdAt":"2026-09-27T10:04:59Z"},
            {"id":"later","type":"userMessage","text":"three","createdAt":"2026-09-27T10:10:00Z"}
        ]
        """#.utf8))
        workspace.messages = messages
        #expect(workspace.timeSeparatorTextByMessageID["first"] == nil)
        #expect(workspace.timeSeparatorTextByMessageID["near"] == nil)
        #expect(workspace.timeSeparatorTextByMessageID["later"] != nil)

        workspace.messages = Array(messages.suffix(1))
        #expect(workspace.timeSeparatorTextByMessageID.isEmpty)
        workspace.messages = messages
        #expect(workspace.timeSeparatorTextByMessageID.count == 1)
    }

    @Test func planRevisionsUpdateOneProcessCardAndOlderWindowsCannotRollItBack() throws {
        let name = "pad-plan-revision-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "session:plan"

        func planMessage(revision: Int, status: String) throws -> ClientMessage {
            let source: [String: Any] = [
                "id": "plan:one", "turnId": "turn:one", "turnStatus": "inProgress",
                "type": "executionPlan", "text": "Plan update", "title": "Execution plan",
                "executionPlan": [
                    "schemaVersion": 1, "planId": "plan:one", "revision": revision,
                    "lifecycle": "active", "updatedAt": "2026-09-24T00:00:00Z",
                    "steps": [["stepId": "step:one", "ordinal": 0,
                               "text": "Inspect", "status": status]]
                ]
            ]
            return try JSONDecoder().decode(ClientMessage.self,
                from: JSONSerialization.data(withJSONObject: source))
        }

        let first = try planMessage(revision: 1, status: "pending")
        let updated = try planMessage(revision: 2, status: "completed")
        workspace.applyLatestWindow([first], cursor: nil, revision: 10)
        #expect(workspace.displayEntries.map(\.id) == ["message:plan:one"])
        #expect(workspace.messages.first?.executionPlan?.steps.first?.status == "pending")
        workspace.applyLatestWindow([updated], cursor: nil, revision: 11)
        #expect(workspace.displayEntries.map(\.id) == ["message:plan:one"])
        #expect(workspace.messages.count == 1)
        #expect(workspace.messages.first?.executionPlan?.revision == 2)
        #expect(workspace.messages.first?.executionPlan?.steps.first?.status == "completed")
        workspace.applyLatestWindow([first], cursor: nil, revision: 10)
        #expect(workspace.messages.first?.executionPlan?.revision == 2)
    }

    @Test func settledProcessDoesNotKeepCurrentStepSubtitle() throws {
        let name = "pad-settled-process-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "session:settled"
        let running = try JSONDecoder().decode([ClientMessage].self, from: Data(
            #"[{"id":"tool","turnId":"turn","type":"mcpToolCall","title":"Fetch records","text":"Fetching","turnStatus":"running","status":"running"}]"#.utf8))
        workspace.messages = running
        #expect(workspace.activeProcessEntryID == "process:turn")
        #expect(workspace.processPresentations["process:turn"]?.currentStepTitle == "Fetch records")

        let completed = try JSONDecoder().decode([ClientMessage].self, from: Data(
            #"[{"id":"tool","turnId":"turn","type":"mcpToolCall","title":"Fetch records","text":"Fetched","turnStatus":"completed","status":"completed"}]"#.utf8))
        workspace.messages = completed
        #expect(workspace.processPresentations["process:turn"]?.state == .completed)
        #expect(workspace.activeProcessEntryID == nil)
        #expect(workspace.processPresentations["process:turn"]?.currentStepTitle == nil)
    }

    @Test func residentSourceWindowUsesMacSemanticDisplayWeightAndExpandsLocally() {
        let name = "pad-resident-window-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "session:resident"
        workspace.messages = (0..<35).map { ClientMessage(id: "message:\($0)", text: "Message \($0)") }

        #expect(workspace.displayEntries.count == 20)
        #expect(workspace.displayEntries.first?.id == "message:message:15")
        #expect(workspace.hasHiddenDisplayHistory)
        #expect(workspace.historyRequestCursor?.hasPrefix("resident:") == true)

        #expect(workspace.revealEarlierDisplayEntries())
        #expect(workspace.displayEntries.count == 35)
        #expect(!workspace.hasHiddenDisplayHistory)
        #expect(workspace.historyRequestCursor == nil)
    }
}
