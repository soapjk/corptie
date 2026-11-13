import Foundation
import Testing
@testable import CorptieClientCore

struct ConversationTimelineTests {
    @Test func correlatedFailuresShareOneDisclosureWithoutLosingDiagnostics() throws {
        let items = try [message("u", "userMessage", status: "failed"),
                         message("tool", "commandExecution", status: "failed"),
                         message("retry", "error", status: "failed"),
                         message("provider", "error", status: "failed"),
                         message("summary", "taskComplete", status: "failed"),
                         message("product", "system", status: "failed")]
        let entries = ConversationTimeline.makeEntries(from: items)
        #expect(entries.map(\.id) == ["message:u", "process:turn"])
        guard case let .process(_, diagnostics) = entries.last?.kind else {
            Issue.record("Missing failure disclosure"); return
        }
        #expect(diagnostics.map(\.id) == Array(items.dropFirst()).map(\.id))
        #expect(ConversationProcessPresentation.state(for: diagnostics) == .failed)
        #expect(items.allSatisfy { $0.processStartedAt == nil }, "Source events are immutable")
    }

    @Test func errorsFromDifferentTurnsAndLegacyUnboundErrorsAreNotMerged() throws {
        let items = try [message("first", "error", turn: "first", status: "failed"),
                         message("second", "error", turn: "second", status: "failed"),
                         message("unbound1", "error", turn: nil, status: "failed"),
                         message("unbound2", "error", turn: nil, status: "failed")]
        #expect(ConversationTimeline.makeEntries(from: items).map(\.id) == items.map { "message:\($0.id)" })
    }

    @Test func recoveredRetryDiagnosticsDoNotOverrideTheSuccessfulTurn() throws {
        let items = try [message("retry1", "error", status: "completed"),
                         message("retry2", "error", status: "completed"),
                         message("answer", "agentMessage", role: "final_answer", status: "completed")]
        let entries = ConversationTimeline.makeEntries(from: items)
        #expect(entries.map(\.id) == ["process:turn", "message:answer"])
        guard case let .process(_, diagnostics) = entries.first?.kind else {
            Issue.record("Missing retry disclosure"); return
        }
        #expect(ConversationProcessPresentation.state(for: diagnostics) == .completed)
    }
    @Test func materializedToolImageStaysInExecution() throws {
        let data = Data(#"{"id":"image","turnId":"turn","type":"imageView","text":"/tmp/original.png","images":[{"managedPath":"chat-resources/test/image.png"}]}"#.utf8)
        let item = try JSONDecoder().decode(ClientMessage.self, from: data)
        #expect(item.timelineHasImages)
        #expect(item.presentationKind == .unknown, "Media must not become an authored reply")
        #expect(!ConversationPresentationKind.isFormalMessage(type: item.type, presentationRole: "final_answer"))
        let entries = ConversationTimeline.makeEntries(from: [item])
        #expect(entries.map(\.id) == ["process:turn"])
        #expect(entries.first?.displayWeight == 0)
    }

    @Test func imagePresentationPreservesExplicitEventRoles() throws {
        for role in ["system_event", "automation", "collaboration", "collaboration_confirmation"] {
            let item = try imageMessage(role: role)
            let entries = ConversationTimeline.makeEntries(from: [item])
            #expect(entries.map(\.id) == ["message:image"], "Explicit events must not be folded as tools")
        }
    }

    @Test func imagesDoNotReclassifyInteractionsUnknownEventsOrAuthoredReplies() throws {
        for type in ["approval", "choice", "userInput", "automationEvent", "futureEvent", "userMessage", "agentMessage"] {
            let item = try imageMessage(type: type)
            #expect(ConversationTimeline.makeEntries(from: [item]).map(\.id) == ["message:image"])
        }
    }

    @Test func lateImageAttachmentKeepsTheSameExecutionGroup() throws {
        let before = try imageMessage(hasImages: false)
        #expect(ConversationTimeline.makeEntries(from: [before]).first?.isProcessGroup == true)
        let after = try imageMessage()
        #expect(after.id == before.id)
        #expect(ConversationTimeline.makeEntries(from: [after]).map(\.id) == ["process:turn"])
    }

    @Test func toolImageDoesNotSplitAdjacentExecutionSteps() throws {
        let items = try [message("before", "commandExecution"), imageMessage(), message("after", "mcpToolCall")]
        let entries = ConversationTimeline.makeEntries(from: items)
        #expect(entries.map(\.id) == ["process:turn"])
        guard case let .process(_, steps) = entries.first?.kind else {
            Issue.record("Missing execution group"); return
        }
        #expect(steps.map(\.id) == items.map(\.id))
    }

    @Test func processingDisclosureSurvivesSnapshotWithoutDeliveryStatusAndYieldsToRealSteps() throws {
        func input(_ authority: String?, status: String, turnStatus: String = "inProgress") throws -> ClientMessage {
            var json: [String: Any] = ["id": "input", "type": "userMessage", "text": "request",
                "turnId": "turn", "turnStatus": turnStatus, "status": status]
            json["userMessageStatus"] = authority
            return try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: json))
        }
        func projected(_ items: [ClientMessage]) -> [ConversationEntry<ClientMessage>] {
            ConversationReplyProgressProjection.entries(ConversationTimeline.makeEntries(from: items))
        }
        let acknowledged = try input("processing", status: "processing")
        let snapshot = try input(nil, status: "processing")
        for value in [acknowledged, snapshot] {
            let rows = projected([value])
            #expect(rows.map(\.id) == ["message:input", "process:input:input"])
            #expect(rows.last?.processReplyState == .running)
        }
        let step = try message("step", "commandExecution")
        let populated = projected([snapshot, step])
        #expect(populated.map(\.id) == ["message:input", "process:input:input"])
        if case .process(_, let items) = populated.last?.kind { #expect(items.map(\.id) == ["step"]) }
        else { Issue.record("Missing populated process") }
        for authority in ["unknown"] {
            #expect(projected([try input(authority, status: "processing")]).count == 1)
        }
        #expect(projected([try input(nil, status: "queued")]).count == 2)
        #expect(projected([try input(nil, status: "processing", turnStatus: "completed")]).count == 2)
    }

    @Test func pendingInputCanShowImmediateProcessingWithoutChangingExecutionAuthority() throws {
        for state in ["preparing"] {
            let value: [String: Any] = ["id": "pending", "type": "userMessage", "text": "request",
                "turnId": "delivery:pending", "turnStatus": state, "userMessageStatus": state]
            let item = try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: value))
            #expect(ConversationTimeline.makeEntries(from: [item]).count == 2)
            let immediate = ConversationTimeline.makeEntries(from: [item], showsPendingInputAsProcessing: true)
            #expect(immediate.last?.isProcessGroup == true)
            #expect(immediate.last?.processReplyState == .waiting)
            #expect(item.userMessageStatus == state)
            #expect(UserMessageStatusPresentation(authoritativeStatus: state, legacyStatus: nil,
                showsPendingAsProcessing: true)?.kind == .processing)
        }
        for authoritative in [true, false] {
            var value: [String: Any] = ["id": "queued", "type": "userMessage", "text": "queued request",
                "turnId": "delivery:queued", "turnStatus": "running", "status": "queued"]
            if authoritative { value["userMessageStatus"] = "queued" }
            let item = try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: value))
            #expect(ConversationTimeline.makeEntries(from: [item], showsPendingInputAsProcessing: true).last?.processReplyState == .waiting)
            let status = UserMessageStatusPresentation(authoritativeStatus: authoritative ? "queued" : nil,
                legacyStatus: "queued", queuePosition: 3, showsPendingAsProcessing: true)
            #expect(status?.kind == .queued)
            #expect(status?.queuePosition == 3)
        }
        for state in ["failed", "cancelled", "consumed"] {
            #expect(UserMessageStatusPresentation(authoritativeStatus: state, legacyStatus: nil,
                showsPendingAsProcessing: true)?.kind != .processing)
        }
        for role in ["automation", "system_event", "collaboration"] {
            let value: [String: Any] = ["id": "event", "type": "userMessage", "text": "event",
                "turnId": "event:pending", "turnStatus": "queued", "userMessageStatus": "queued",
                "presentationRole": role, "collaborationDirection": "inbound"]
            let item = try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: value))
            #expect(!ConversationTimeline.makeEntries(from: [item], showsPendingInputAsProcessing: true).contains { $0.isProcessGroup })
        }
    }

    @Test func reliableSubmissionKeepsOneIdentityThroughAcknowledgementExecutionAndReplay() throws {
        func input(_ state: String, turn: String, local: Bool = false) throws -> ClientMessage {
            var value: [String: Any] = ["id": "stable", "type": "userMessage", "text": "same text",
                "turnId": turn, "turnStatus": "inProgress", "userMessageStatus": state]
            if local { value["sourceType"] = "local_submission" }
            return try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: value))
        }
        func rows(_ items: [ClientMessage]) -> [ConversationEntry<ClientMessage>] {
            ConversationReplyProgressProjection.entries(ConversationTimeline.makeEntries(from: items))
        }
        let submitted = try input("queued", turn: "delivery:one", local: true)
        let accepted = try input("queued", turn: "delivery:one")
        let executing = try input("processing", turn: "provider:one")
        let tool = try message("real-step", "commandExecution", turn: "provider:one", status: "inProgress")
        let snapshots = [[submitted], [accepted], [executing], [executing, tool], [executing, tool]]
        let expected: [ConversationProcessState] = [.sending, .waiting, .running, .running, .running]
        for (index, snapshot) in snapshots.enumerated() {
            let cards = rows(snapshot).filter(\.isProcessGroup)
            #expect(cards.count == 1)
            #expect(cards.first?.id == "process:input:stable")
            #expect(cards.first?.processDisclosureID == "input:stable")
            #expect(cards.first?.processReplyState == expected[index])
        }
        // A late HTTP acknowledgement cannot replace authoritative execution.
        #expect(rows([executing, tool]).last?.processReplyState == .running)
        for (state, presentation) in [("consumed", ConversationProcessState.completed), ("failed", .failed), ("cancelled", .cancelled)] {
            let card = rows([try input(state, turn: "provider:one")]).last
            #expect(card?.id == "process:input:stable")
            #expect(card?.processReplyState == presentation)
        }
        let waiting = try JSONDecoder().decode(ClientMessage.self, from: Data(#"{"id":"next","type":"userMessage","text":"same text","turnId":"delivery:next","status":"queued"}"#.utf8))
        #expect(rows([executing, tool, waiting]).filter(\.isProcessGroup).map(\.id)
            == ["process:input:stable", "process:input:next"])
        #expect(ConversationProcessPresentation(state: .sending, count: 0).summary(languageCode: "zh") == "正在发送")
        #expect(ConversationProcessPresentation(state: .waiting, count: 0).summary(languageCode: "en") == "Waiting to run")
    }

    @Test func mobileLocalSubmissionUsesTheSameIdentityAndTerminalTurnWinsStaleStatus() throws {
        for state in [ConversationProcessState.sending, .waiting, .failed, .cancelled] {
            let local = ClientMessage(id: "mobile", text: "request", submissionState: state)
            let rows = ConversationReplyProgressProjection.entries(ConversationTimeline.makeEntries(from: [local]))
            #expect(rows.last?.id == "process:input:mobile")
            #expect(rows.last?.processReplyState == state)
        }
        for (terminal, expected) in [("failed", ConversationProcessState.failed), ("cancelled", .cancelled)] {
            let data: [String: Any] = ["id": "mobile", "type": "userMessage", "text": "request",
                "turnId": "real", "turnStatus": terminal, "status": "processing"]
            let item = try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: data))
            #expect(ConversationTimeline.makeEntries(from: [item]).last?.processReplyState == expected)
        }
    }

    private func imageMessage(type: String = "imageView", role: String? = nil,
                              hasImages: Bool = true) throws -> ClientMessage {
        var value: [String: Any] = ["id": "image", "turnId": "turn", "type": type,
                                   "text": "/tmp/qr.png", "turnStatus": "completed"]
        value["presentationRole"] = role
        value["images"] = hasImages ? [["managedPath": "chat-resources/test/qr.png"]] : []
        return try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: value))
    }
    private func message(_ id: String, _ type: String, role: String? = nil,
                         turn: String? = "turn", status: String = "running",
                         date: String? = nil, direction: String? = nil) throws -> ClientMessage {
        var value: [String: Any] = ["id": id, "type": type, "text": id, "turnStatus": status]
        value["turnId"] = turn
        value["presentationRole"] = role
        value["createdAt"] = date
        value["collaborationDirection"] = direction
        return try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: value))
    }

    @Test func commentaryAndToolsShareProcessButFinalAndUnclassifiedRepliesRemainVisible() throws {
        let items = try [message("u", "userMessage", date: "2026-09-19T00:00:00Z"),
                         message("p", "agentMessage", role: "commentary"),
                         message("t", "mcpToolCall"),
                         message("legacy", "agentMessage"),
                         message("a", "agentMessage", role: "final_answer", status: "completed", date: "2026-09-19T00:00:03Z")]
        let entries = ConversationTimeline.makeEntries(from: items)
        #expect(entries.map(\.id) == ["message:u", "message:p", "process:turn", "message:legacy", "message:a"])
        guard case let .process(_, process) = entries[2].kind else { Issue.record("Missing process"); return }
        #expect(process.map(\.id) == ["t"])
        #expect(process[0].processStartedAt == "2026-09-19T00:00:00Z")
        #expect(process[0].processEndedAt == "2026-09-19T00:00:03Z")
        #expect(items[1].processStartedAt == nil)
        #expect(entries[2].displayWeight == 0)
    }

    @Test func missingTurnIDsRecoverBoundariesWithoutCollapsingConversation() throws {
        let items = try [message("u1", "userMessage", turn: nil), message("a1", "agentMessage", turn: nil),
                         message("u2", "userMessage", turn: nil), message("t2", "commandExecution", turn: nil),
                         message("a2", "agentMessage", role: "final_answer", turn: nil)]
        #expect(ConversationTimeline.makeEntries(from: items).map(\.id) == [
            "message:u1", "message:a1", "message:u2", "process::display-segment:1", "message:a2"])
    }

    @Test func mixedTimestampFormatsSortStablyAndMissingDatesPreserveSourceOrder() throws {
        let late = try message("late", "agentMessage", date: "2026-09-19T08:00:02+08:00")
        let early = try message("early", "userMessage", date: "2026-09-19T00:00:01.000Z")
        #expect(ConversationTimeline.orderedItems([late, early]).map(\.id) == ["early", "late"])
        let undated = try message("unknown", "mcpToolCall")
        #expect(ConversationTimeline.orderedItems([late, undated, early]).map(\.id) == ["late", "unknown", "early"])
    }

    @Test func providerExecutionEventsDoNotBecomeStandaloneChatBubbles() throws {
        let executionTypes = ["sleep", "imageView", "collabAgentToolCall", "collabToolCall",
                              "functionCallOutput", "enteredReviewMode", "exitedReviewMode"]
        let items = try [message("user", "userMessage")]
            + executionTypes.enumerated().map { index, type in try message("step:\(index)", type) }
            + [message("answer", "agentMessage", role: "final_answer", status: "completed")]
        let entries = ConversationTimeline.makeEntries(from: items)
        #expect(entries.map(\.id) == ["message:user", "process:turn", "message:answer"])
        guard case let .process(_, process) = entries[1].kind else {
            Issue.record("Missing process group"); return
        }
        #expect(process.map(\.type) == executionTypes)
    }

    @Test func interactionsErrorsAndUnknownEventsRemainVisible() throws {
        let standaloneTypes = ["approval", "choice", "userInput", "error", "system",
                               "automationEvent", "systemEvent", "imageGeneration", "futureProviderEvent"]
        let items = try standaloneTypes.enumerated().map { index, type in
            try message("event:\(index)", type)
        }
        let entries = ConversationTimeline.makeEntries(from: items)
        #expect(entries.map(\.id) == items.map { "message:\($0.id)" })
    }

    @Test func concurrentUserMessageDoesNotSplitActiveTurnExecutionProcess() throws {
        // Turn 1 starts with u1, then runs tool t1
        let u1 = try message("u1", "userMessage", turn: "turn:1", date: "2026-09-19T00:00:00Z")
        let t1 = try message("t1", "commandExecution", turn: "turn:1", status: "running", date: "2026-09-19T00:00:01Z")
        // User concurrently sends u2 while turn 1 is still in progress
        let u2 = try message("u2", "userMessage", turn: "turn:2", date: "2026-09-19T00:00:02Z")
        // Turn 1 continues executing: emits t2 and final answer a1
        let t2 = try message("t2", "mcpToolCall", turn: "turn:1", status: "running", date: "2026-09-19T00:00:03Z")
        let a1 = try message("a1", "agentMessage", role: "final_answer", turn: "turn:1", status: "completed", date: "2026-09-19T00:00:04Z")

        let entries = ConversationTimeline.makeEntries(from: [u1, t1, u2, t2, a1])
        // Turn 1 entries should stay causally grouped together, followed by u2
        #expect(entries.map(\.id) == ["message:u1", "process:turn:1", "message:a1", "message:u2"])
        guard case let .process(_, processItems) = entries[1].kind else {
            Issue.record("Expected process group for turn:1")
            return
        }
        #expect(processItems.map(\.id) == ["t1", "t2"])
    }

    @Test func interleavedProcessSegmentsSplitByDirectPlanAndCommentaryCards() throws {
        let u = try message("u", "userMessage", turn: "turn:1", date: "2026-09-19T00:00:00Z")
        let t1 = try message("t1", "commandExecution", turn: "turn:1", date: "2026-09-19T00:00:01Z")
        let plan = try message("plan", "executionPlan", turn: "turn:1", date: "2026-09-19T00:00:02Z")
        let t2 = try message("t2", "mcpToolCall", turn: "turn:1", date: "2026-09-19T00:00:03Z")
        let comm = try message("c", "agentMessage", role: "commentary", turn: "turn:1", date: "2026-09-19T00:00:04Z")
        let t3 = try message("t3", "commandExecution", turn: "turn:1", date: "2026-09-19T00:00:05Z")
        let a = try message("a", "agentMessage", role: "final_answer", turn: "turn:1", status: "completed", date: "2026-09-19T00:00:06Z")

        let entries = ConversationTimeline.makeEntries(from: [u, t1, plan, t2, comm, t3, a])
        #expect(entries.map(\.id) == [
            "message:u",
            "process:turn:1",
            "message:plan",
            "process:turn:1:process-segment:1",
            "message:c",
            "process:turn:1:process-segment:2",
            "message:a"
        ])

        guard case let .process(p0Turn, p0Items) = entries[1].kind,
              case let .process(p1Turn, p1Items) = entries[3].kind,
              case let .process(p2Turn, p2Items) = entries[5].kind else {
            Issue.record("Missing expected interleaved process segments")
            return
        }

        #expect(p0Turn == "turn:1")
        #expect(p0Items.map(\.id) == ["t1"])
        #expect(p0Items[0].processStartedAt == "2026-09-19T00:00:00Z")
        #expect(p0Items[0].processEndedAt == "2026-09-19T00:00:01Z")
        #expect(ConversationProcessPresentation.state(for: p0Items) == .completed)

        #expect(p1Turn == "turn:1:process-segment:1")
        #expect(p1Items.map(\.id) == ["t2"])
        #expect(p1Items[0].processStartedAt == "2026-09-19T00:00:03Z")
        #expect(p1Items[0].processEndedAt == "2026-09-19T00:00:03Z")
        #expect(ConversationProcessPresentation.state(for: p1Items) == .completed)

        #expect(p2Turn == "turn:1:process-segment:2")
        #expect(p2Items.map(\.id) == ["t3"])
        #expect(p2Items[0].processStartedAt == "2026-09-19T00:00:05Z")
        #expect(p2Items[0].processEndedAt == "2026-09-19T00:00:06Z")
        #expect(ConversationProcessPresentation.state(for: p2Items) == .completed)
    }

    @Test(arguments: ["userMessage", "agentMessage"])
    func outboundCollaborationSplitsActiveProcessWithoutCompletingProviderTurn(transportType: String) throws {
        let items = try [message("u", "userMessage", date: "2026-10-05T00:00:00Z"),
            message("t1", "commandExecution", date: "2026-10-05T00:00:01Z"),
            message("sent", transportType, role: "collaboration", turn: "session-channel-message:sent",
                    status: "completed", date: "2026-10-05T00:00:02Z", direction: "outbound"),
            message("t2", "mcpToolCall", date: "2026-10-05T00:00:03Z")]
        let prefix = ConversationTimeline.makeEntries(from: Array(items.prefix(3)))
        let entries = ConversationTimeline.makeEntries(from: items)
        #expect(prefix.map(\.id) == ["message:u", "process:turn", "message:sent"])
        #expect(entries.map(\.id) == prefix.map(\.id) + ["process:turn:process-segment:1"])
        guard case let .process(_, before) = entries[1].kind,
              case let .message(sent) = entries[2].kind,
              case let .process(_, after) = entries[3].kind else {
            Issue.record("Missing collaboration boundary"); return
        }
        #expect(before.map(\.id) == ["t1"])
        #expect(after.map(\.id) == ["t2"])
        #expect(sent.turnId == "session-channel-message:sent")
        #expect(before.first?.processStartedAt == "2026-10-05T00:00:00Z")
        #expect(before.first?.processEndedAt == "2026-10-05T00:00:01Z")
        #expect(ConversationProcessPresentation.state(for: before) == .completed)
        #expect(after.first?.processStartedAt == "2026-10-05T00:00:03Z")
        #expect(after.first?.processEndedAt == nil)
        #expect(ConversationProcessPresentation.state(for: after) == .running)
    }

    @Test(arguments: ["running", "completed"])
    func queuedUserMessageDoesNotStealOutboundCollaborationFromExecutingTurn(status: String) throws {
        let entries = ConversationTimeline.makeEntries(from: try [
            message("u1", "userMessage", turn: "one", status: status), message("t1", "mcpToolCall", turn: "one", status: status),
            message("u2", "userMessage", turn: "two"),
            message("sent", "userMessage", role: "collaboration", turn: "channel:sent", status: "completed", direction: "outbound"),
            message("t2", "mcpToolCall", turn: "one", status: status),
            message("a", "agentMessage", role: "final_answer", turn: "one", status: "completed")])
        #expect(entries.map(\.id) == ["message:u1", "process:one", "message:sent",
            "process:one:process-segment:1", "message:a", "message:u2"])
    }

    @Test func completedHistoryRetainsTheSameCollaborationBoundaryAsLiveExecution() throws {
        let items = try [message("u", "userMessage", status: "completed"),
            message("t1", "mcpToolCall", status: "completed"),
            message("c", "agentMessage", role: "commentary", status: "completed"),
            message("sent", "userMessage", role: "collaboration", turn: "channel:sent", status: "completed", direction: "outbound"),
            message("t2", "mcpToolCall", status: "completed"),
            message("a", "agentMessage", role: "final_answer", status: "completed")]
        #expect(ConversationTimeline.makeEntries(from: items).map(\.id) == [
            "message:u", "process:turn", "message:c", "message:sent", "process:turn:process-segment:1", "message:a"])
    }

    @Test func inboundAndPostCompletionCollaborationRemainIndependent() throws {
        let items = try [message("u", "userMessage"), message("t", "mcpToolCall"),
            message("a", "agentMessage", role: "final_answer", status: "completed"),
            message("sent", "userMessage", role: "collaboration", turn: "channel:sent", status: "completed", direction: "outbound"),
            message("received", "userMessage", role: "collaboration", turn: "inbound", direction: "inbound"),
            message("reply", "agentMessage", role: "final_answer", turn: "inbound", status: "completed")]
        #expect(ConversationTimeline.makeEntries(from: items).map(\.id) == [
            "message:u", "process:turn", "message:a", "message:sent", "message:received", "message:reply"])
    }

    @Test func confirmationDoesNotEraseCommentaryOrToolHistory() throws {
        let entries = ConversationTimeline.makeEntries(from: try [message("u", "userMessage"),
            message("t1", "mcpToolCall"), message("c", "agentMessage", role: "commentary"),
            message("confirm", "collaborationConfirmation", role: "collaboration_confirmation", status: "completed"),
            message("t2", "commandExecution")])
        #expect(entries.map(\.id) == ["message:u", "process:turn", "message:c", "message:confirm",
                                     "process:turn:process-segment:1"])
        guard case let .process(_, after) = entries.last?.kind else {
            Issue.record("Missing continuing process"); return
        }
        #expect(ConversationProcessPresentation.state(for: after) == .running)
    }

    @Test func commentaryMeaningDoesNotDependOnProviderOrTurnCompletion() {
        #expect(ConversationPresentationKind.isCommentary(type: "agentMessage", presentationRole: "commentary"))
        #expect(!ConversationPresentationKind.isCommentary(type: "agentMessage", presentationRole: "final_answer"))
        #expect(!ConversationPresentationKind.isCommentary(type: "agentMessage", presentationRole: nil))
        #expect(!ConversationPresentationKind.isCommentary(type: "userMessage", presentationRole: "commentary"))
        #expect(ConversationPresentationKind.isFormalMessage(type: "userMessage", presentationRole: nil))
        #expect(ConversationPresentationKind.isFormalMessage(type: "agentMessage", presentationRole: "final_answer"))
        #expect(!ConversationPresentationKind.isFormalMessage(type: "agentMessage", presentationRole: "commentary"))
        #expect(!ConversationPresentationKind.isFormalMessage(type: "agentMessage", presentationRole: nil))
        #expect(!ConversationPresentationKind.isFormalMessage(type: "commandExecution", presentationRole: nil))
    }
}
