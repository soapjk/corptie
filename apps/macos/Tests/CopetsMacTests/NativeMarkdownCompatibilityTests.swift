import AppKit
import XCTest
@testable import CorptieMac

final class NativeMarkdownCompatibilityTests: XCTestCase {
    func testRichBlocksRequestTheFullNativeContentWidth() {
        XCTAssertTrue(NativeMarkdownCompatibility.requiresFullWidthLayout("![alt](image.png)"))
        XCTAssertTrue(NativeMarkdownCompatibility.requiresFullWidthLayout("- [ ] unfinished"))
        XCTAssertTrue(NativeMarkdownCompatibility.requiresFullWidthLayout("| A | B |\n|---|---|\n| 1 | 2 |"))
        XCTAssertTrue(NativeMarkdownCompatibility.requiresFullWidthLayout("```swift\nlet value = 42\n```"))
        XCTAssertTrue(NativeMarkdownCompatibility.requiresFullWidthLayout("<details>\ntext\n</details>"))
    }

    func testKeepsSupportedMarkdownOnNativePath() {
        let markdown = """
        # Heading

        - first
        - second

        > quote with **bold**, ~~deleted~~, and [link](https://example.com)
        """

        XCTAssertFalse(NativeMarkdownCompatibility.requiresFullWidthLayout(markdown))
    }

    func testStandaloneProcessUsesNativeExpandableRow() {
        let reasoning = item(id: "reasoning", type: "reasoning", text: "Thinking")
        XCTAssertEqual(
            ChatTimelineRowRouting.route(
                for: ChatDisplayEntry(kind: .process(turnId: "turn", items: [reasoning]))
            ),
            .native
        )
    }

    func testExecutionTimelineProjectsStableReadableContextActionAndResultSteps() {
        let longDetail = String(repeating: "verbose output ", count: 30)
        let items = [
            item(id: "reasoning", type: "reasoning", text: "Inspecting the message flow"),
            item(id: "command", type: "commandExecution", text: "swift test\n\(longDetail)"),
            item(id: "warning", type: "warning", text: "One retry was required")
        ]

        let steps = NativeExecutionTimelineProjection.steps(for: items)

        XCTAssertEqual(steps.map(\.id), ["reasoning", "command", "warning"])
        XCTAssertEqual(steps.map(\.kind), [.context, .action, .result])
        XCTAssertEqual(steps.last?.state, .failed)
        XCTAssertLessThanOrEqual(steps[1].detail?.count ?? 0, NativeExecutionTimelineProjection.detailCharacterLimit)
        XCTAssertFalse(NativeExecutionTimelineProjection.plainText(for: steps).contains("**"))
    }

    @MainActor
    func testExpandedExecutionUsesDedicatedTimelineTypographyInsteadOfRawMarkdownMarkers() {
        let steps = NativeExecutionTimelineProjection.steps(for: [
            item(id: "reasoning", type: "reasoning", text: "Inspecting code"),
            item(id: "command", type: "commandExecution", text: "swift test")
        ])
        let row = AppKitChatTimelineRow(
            id: "structured-process",
            contentRevision: 1,
            nativeText: NativeExecutionTimelineProjection.plainText(for: steps),
            copyText: "Inspecting code\nswift test",
            nativeStyle: .process,
            title: "",
            metadata: "",
            expandableTurnId: "turn",
            isExpanded: true,
            processCount: steps.count,
            processSteps: steps,
            showsHeader: false
        )

        let attributed = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: 480).attributedText

        XCTAssertTrue(attributed.string.contains(L10n("Execution Context").uppercased()))
        XCTAssertTrue(attributed.string.contains(L10n("Execution Action").uppercased()))
        XCTAssertFalse(attributed.string.contains("**"))
    }

    func testUserMessageAndExecutionProcessBecomeSeparateDisplayEntries() {
        let user = item(id: "user", type: "userMessage", text: "hi")
        let reasoning = item(id: "reasoning", type: "reasoning", text: "Thinking")

        let entries = makeChatDisplayEntriesForTurn([user, reasoning])

        XCTAssertEqual(entries.count, 2)
        guard entries.count == 2 else { return }
        if case .message(let message) = entries[0].kind {
            XCTAssertEqual(message.id, user.id)
        } else {
            XCTFail("The first entry should remain the user message")
        }
        if case .process(let turnId, let items) = entries[1].kind {
            XCTAssertEqual(turnId, "turn")
            XCTAssertEqual(items.map(\.id), [reasoning.id])
        } else {
            XCTFail("The execution process should be its own display entry")
        }
    }

    func testExecutionProcessAppearsOnlyAfterItHasContent() {
        let user = item(id: "user", type: "userMessage", text: "hi", turnStatus: "inProgress")

        let userOnlyEntries = makeChatDisplayEntriesForTurn([user])

        XCTAssertEqual(userOnlyEntries.count, 1)
        guard case .message(let message) = userOnlyEntries[0].kind else {
            return XCTFail("A user-only turn should not create an empty execution process")
        }
        XCTAssertEqual(message.id, user.id)

        let reasoning = item(
            id: "reasoning",
            type: "reasoning",
            text: "Thinking",
            turnStatus: "inProgress"
        )
        let entriesWithProcessContent = makeChatDisplayEntriesForTurn([user, reasoning])

        XCTAssertEqual(entriesWithProcessContent.count, 2)
        guard case .process(_, let processItems) = entriesWithProcessContent[1].kind else {
            return XCTFail("The first execution item should create the process card")
        }
        XCTAssertEqual(processItems.map(\.id), [reasoning.id])
        XCTAssertEqual(projectedProcessState(for: processItems), .running)
    }

    func testExecutionDurationUsesTheCompleteTurnInsteadOfOnlyProcessItems() {
        let user = item(
            id: "user",
            type: "userMessage",
            text: "run tests",
            createdAt: "2026-08-12T03:55:40.000Z"
        )
        let command = item(
            id: "command",
            type: "commandExecution",
            text: "swift test",
            createdAt: "2026-08-12T03:55:44.000Z"
        )
        var final = item(
            id: "final",
            type: "agentMessage",
            text: "Done",
            createdAt: "2026-08-12T03:55:52.000Z"
        )
        final.presentationRole = "final_answer"

        let entries = makeChatDisplayEntriesForTurn([user, command, final])
        guard case .process(_, let processItems) = entries[1].kind else {
            return XCTFail("Expected an execution process")
        }

        XCTAssertEqual(processItems.first?.processStartedAt, user.createdAt)
        XCTAssertEqual(processItems.first?.processEndedAt, final.createdAt)
        XCTAssertEqual(executionProcessDurationText(for: processItems), "12s")
    }

    func testStoredTimelineJSONKeepsCommentaryInsideProcessAndFinalAnswerSeparate() throws {
        let data = Data(#"""
        [
          {"id":"user","turnId":"turn","turnStatus":"completed","type":"userMessage","title":"User","text":"Do it","options":null,"status":"completed","createdAt":"2026-08-25T00:00:00Z"},
          {"id":"commentary","turnId":"turn","turnStatus":"completed","type":"agentMessage","title":"Agent","text":"Working","options":null,"status":"completed","createdAt":"2026-08-25T00:00:01Z","presentationRole":"commentary"},
          {"id":"tool","turnId":"turn","turnStatus":"completed","type":"commandExecution","title":"Tool","text":"swift test","options":null,"status":"completed","createdAt":"2026-08-25T00:00:02Z"},
          {"id":"final","turnId":"turn","turnStatus":"completed","type":"agentMessage","title":"Agent","text":"Done","options":null,"status":"completed","createdAt":"2026-08-25T00:00:03Z","presentationRole":"final_answer"}
        ]
        """#.utf8)
        let items = try JSONDecoder().decode([CodexThreadItem].self, from: data)

        let entries = makeChatDisplayEntriesForTurn(items)

        XCTAssertEqual(entries.map(\.id), ["message:user", "process:turn", "message:final"])
        guard case .process(_, let processItems) = entries[1].kind else {
            return XCTFail("Expected commentary and tool output inside the process card")
        }
        XCTAssertEqual(processItems.map(\.id), ["commentary", "tool"])
    }

    func testSingleTimestampDoesNotInventSubsecondExecutionDuration() {
        let command = item(id: "command", type: "commandExecution", text: "swift test")

        XCTAssertNil(executionProcessDurationText(for: [command]))
    }

    @MainActor
    func testCollaborationCardPrioritizesSessionWorkAndMessageWithoutAgentNames() throws {
        var collaboration = item(
            id: "collaboration",
            type: "userMessage",
            text: "trusted envelope"
        )
        collaboration.sourceType = "collaboration"
        collaboration.presentationRole = "collaboration"
        collaboration.collaborationTaskId = "task:review"
        collaboration.presentationText = "Please review the API contract."
        collaboration.collaborationSenderName = "Platform Agent"
        collaboration.collaborationSenderAgentId = "agent:platform"
        collaboration.collaborationRecipientName = "macOS Agent"
        collaboration.collaborationRecipientAgentId = "agent:macos"
        collaboration.collaborationRecipientSessionTitle = "Sessions UI"
        collaboration.collaborationRecipientSessionId = "session:ui"
        collaboration.collaborationRecipientSessionKind = "worker"
        collaboration.collaborationTargetCorptieTaskId = "task:ui"
        collaboration.collaborationInitiatorSessionTitle = "Platform Work Chat"
        collaboration.collaborationInitiatorSessionId = "session:platform"
        collaboration.collaborationInitiatorSessionKind = "workChat"
        collaboration.collaborationSourceWorkName = "Platform"
        collaboration.collaborationSourceWorkId = "work:platform"
        collaboration.collaborationTargetWorkName = "macOS"
        collaboration.collaborationTargetWorkId = "work:macos"
        collaboration.collaborationTaskTitle = "Review collaboration card"
        collaboration.collaborationMessageKind = "change_request"
        collaboration.collaborationProcessingStatus = "running"

        let presentation = try XCTUnwrap(nativeCollaborationCardPresentation(
            for: collaboration,
            currentSessionTitle: "Fallback Session"
        ))

        XCTAssertTrue(presentation.title.contains(L10n("跨会话协作")))
        XCTAssertTrue(presentation.title.contains(L10n("修改请求")))
        XCTAssertTrue(presentation.metadata.contains(L10n("处理中")))
        XCTAssertEqual(presentation.route.destinationKind, .existingSession)
        XCTAssertEqual(presentation.route.routeLabel, L10n("发送到现有会话"))
        XCTAssertEqual(presentation.route.sourceSession, "Session · Platform Work Chat")
        XCTAssertEqual(presentation.route.sourceWork, "Work · Platform")
        XCTAssertEqual(presentation.route.targetName, "Session · Sessions UI")
        XCTAssertEqual(presentation.route.targetWork, "Work · macOS")
        let visibleContent = [
            presentation.bodyMarkdown,
            presentation.route.sourceSession,
            presentation.route.sourceWork,
            presentation.route.targetName,
            presentation.route.targetWork
        ].joined(separator: "\n")
        XCTAssertFalse(visibleContent.contains("Platform Agent"))
        XCTAssertFalse(visibleContent.contains("macOS Agent"))
        XCTAssertFalse(visibleContent.contains("agent:platform"))
        XCTAssertFalse(visibleContent.contains("agent:macos"))
        XCTAssertFalse(visibleContent.contains("session:platform"))
        XCTAssertFalse(visibleContent.contains("session:ui"))
        XCTAssertFalse(visibleContent.contains("work:platform"))
        XCTAssertFalse(visibleContent.contains("work:macos"))
        XCTAssertFalse(visibleContent.contains("task:ui"))
        XCTAssertTrue(presentation.bodyMarkdown.contains("Please review the API contract."))
        XCTAssertEqual(presentation.messageText, "Please review the API contract.")
    }

    @MainActor
    func testAuthorizedSessionChannelSendRendersAsSentWithoutTaskIdentity() throws {
        var message = item(id: "channel-message", type: "userMessage", text: "Status update")
        message.sourceType = "session_channel"
        message.presentationRole = "collaboration"
        message.presentationText = "Status update"
        message.collaborationChannelId = "channel:authorized"
        message.collaborationDirection = "outbound"
        message.collaborationInitiatorSessionId = "logical:source"
        message.collaborationInitiatorSessionTitle = "Source Work Chat"
        message.collaborationRecipientSessionId = "logical:target"
        message.collaborationRecipientSessionTitle = "Target Worker"
        message.collaborationSourceWorkId = "work:source"
        message.collaborationSourceWorkName = "Source Work"
        message.collaborationTargetWorkId = "work:target"
        message.collaborationTargetWorkName = "Target Work"
        message.collaborationMessageKind = "update"
        message.collaborationProcessingStatus = "sent"

        let presentation = try XCTUnwrap(nativeCollaborationCardPresentation(
            for: message,
            currentSessionTitle: "Source Work Chat"
        ))

        XCTAssertTrue(presentation.metadata.contains(L10n("已发送")))
        XCTAssertEqual(presentation.route.destinationKind, .existingSession)
        XCTAssertEqual(presentation.route.sourceSession, "Session · Source Work Chat")
        XCTAssertEqual(presentation.route.targetName, "Session · Target Worker")
        XCTAssertEqual(presentation.messageText, "Status update")
    }

    @MainActor
    func testCollaborationConfirmationShowsPendingCorptieTaskInsteadOfInventingTargetSession() throws {
        var confirmation = item(
            id: "collaboration-confirmation",
            type: "collaborationConfirmation",
            text: ""
        )
        confirmation.presentationRole = "collaboration_confirmation"
        confirmation.presentationText = "Investigate the delivery failure."
        confirmation.collaborationInitiatorSessionTitle = "Source Worker"
        confirmation.collaborationInitiatorSessionId = "session:source"
        confirmation.collaborationSourceWorkName = "Platform"
        confirmation.collaborationSourceWorkId = "work:platform"
        confirmation.collaborationTargetWorkName = "macOS"
        confirmation.collaborationTargetWorkId = "work:macos"
        confirmation.collaborationTaskTitle = "Repair delivery"
        confirmation.collaborationConfirmationStatus = "pending"

        let presentation = try XCTUnwrap(nativeCollaborationCardPresentation(
            for: confirmation,
            currentSessionTitle: "Source Worker"
        ))

        XCTAssertEqual(presentation.route.destinationKind, .newCorptieTask)
        XCTAssertEqual(presentation.route.routeLabel, L10n("将创建新的 CorptieTask"))
        XCTAssertEqual(presentation.route.sourceSession, "Session · Source Worker")
        XCTAssertEqual(presentation.route.sourceWork, "Work · Platform")
        XCTAssertEqual(presentation.route.targetName, "CorptieTask · Repair delivery")
        XCTAssertEqual(presentation.route.targetWork, "Work · macOS")
        let visibleContent = [
            presentation.bodyMarkdown,
            presentation.route.sourceSession,
            presentation.route.sourceWork,
            presentation.route.targetName,
            presentation.route.targetWork
        ].joined(separator: "\n")
        XCTAssertFalse(visibleContent.contains("session:source"))
        XCTAssertFalse(visibleContent.contains("work:platform"))
        XCTAssertFalse(visibleContent.contains("work:macos"))
        XCTAssertTrue(presentation.bodyMarkdown.contains("Investigate the delivery failure."))
    }

    @MainActor
    func testIncompleteCollaborationEnvelopeDoesNotRenderAsCollaboration() throws {
        var collaboration = item(id: "collaboration", type: "userMessage", text: "Need context")
        collaboration.sourceType = "collaboration"
        collaboration.presentationRole = "collaboration"
        collaboration.collaborationSenderName = "Peer Agent"
        collaboration.collaborationRecipientName = "Current Agent"

        let presentation = nativeCollaborationCardPresentation(
            for: collaboration,
            currentSessionTitle: "Current Work Session"
        )

        XCTAssertNil(presentation)
    }

    @MainActor
    func testTaskC4471174CardUsesDistinctHistoricalNamesWithoutExposingStableIDs() throws {
        var collaboration = item(
            id: "c4471174-177e-4fe9-ab1d-cd10e070da35",
            type: "userMessage",
            text: "Repair the historical route."
        )
        collaboration.sourceType = "collaboration"
        collaboration.presentationRole = "collaboration"
        collaboration.presentationText = "Repair the historical route."
        collaboration.collaborationTaskId = "task:c4471174"
        collaboration.collaborationSenderAgentId = "agent:initiator"
        collaboration.collaborationRecipientAgentId = "agent:recipient"
        collaboration.collaborationInitiatorSessionId = "session:historical-initiator"
        collaboration.collaborationInitiatorSessionTitle = "Historical Initiator Session"
        collaboration.collaborationRecipientSessionId = "session:recipient-current"
        collaboration.collaborationRecipientSessionTitle = "Recipient Worker Session"
        collaboration.collaborationSourceWorkId = "work:source"
        collaboration.collaborationTargetWorkId = "work:target"

        let presentation = try XCTUnwrap(nativeCollaborationCardPresentation(
            for: collaboration,
            currentSessionTitle: "Recipient Worker Session"
        ))

        XCTAssertEqual(presentation.route.sourceSession, "Session · Historical Initiator Session")
        XCTAssertEqual(presentation.route.targetName, "Session · Recipient Worker Session")
        let visibleContent = [
            presentation.bodyMarkdown,
            presentation.route.sourceSession,
            presentation.route.sourceWork,
            presentation.route.targetName,
            presentation.route.targetWork
        ].joined(separator: "\n")
        XCTAssertFalse(visibleContent.contains("agent:initiator"))
        XCTAssertFalse(visibleContent.contains("agent:recipient"))
        XCTAssertFalse(visibleContent.contains("work:source"))
        XCTAssertFalse(visibleContent.contains("work:target"))
        XCTAssertFalse(visibleContent.contains("session:historical-initiator"))
        XCTAssertFalse(visibleContent.contains("session:recipient-current"))
    }

    @MainActor
    func testCollaborationTurnAgentOutputAndAutomationToolDoNotBecomeUnknownAgentCards() {
        var final = item(id: "final", type: "agentMessage", text: "Created two Automations.")
        final.sourceType = "collaboration"
        final.presentationRole = "final_answer"
        XCTAssertNil(nativeCollaborationCardPresentation(for: final, currentSessionTitle: "Session"))

        var tool = item(id: "tool", type: "mcpToolCall", text: "corptie_automations_create")
        tool.sourceType = "collaboration"
        XCTAssertNil(nativeCollaborationCardPresentation(for: tool, currentSessionTitle: "Session"))
    }

    @MainActor
    func testAutomationCardShowsOnlyUserFacingFieldsAndNaturalExecutionPlan() throws {
        var automation = item(id: "automation", type: "automationEvent", text: "Inspect the process")
        automation.presentationRole = "automation"
        automation.automationId = "scheduled_task:b2cb2ad1-9048-40c6-a18b-b79ec6df8b43"
        automation.automationName = "Shadow exit monitor"
        automation.automationTriggerType = "processExit"
        automation.automationEventType = "ScheduledSessionTaskCreated"
        automation.automationEventSource = "scheduled_session_task"
        automation.automationRunId = "scheduled_run:secret"
        automation.automationProcessPollIntervalSeconds = 5
        automation.automationEventOccurredAt = "2026-08-12T03:55:44.520Z"
        automation.automationExpiresAt = "2026-08-13T03:55:44.520Z"

        let presentation = try XCTUnwrap(nativeAutomationCardPresentation(for: automation))
        XCTAssertEqual(presentation.title, "Shadow exit monitor")
        XCTAssertTrue(presentation.bodyMarkdown.contains("Inspect the process"))
        XCTAssertTrue(presentation.bodyMarkdown.contains("5"))
        XCTAssertFalse(presentation.bodyMarkdown.contains("scheduled_task:"))
        XCTAssertFalse(presentation.bodyMarkdown.contains("scheduled_run:"))
        XCTAssertFalse(presentation.bodyMarkdown.contains("ScheduledSession"))
        XCTAssertFalse(presentation.bodyMarkdown.contains("scheduled_session_task"))
    }

    @MainActor
    func testNonWhitelistedAutomationEventCannotRenderACard() {
        var automation = item(id: "automation", type: "automationEvent", text: "Done")
        automation.presentationRole = "automation"
        automation.automationName = "Nightly review"
        automation.automationEventType = "ScheduledSessionRunCompleted"
        XCTAssertNil(nativeAutomationCardPresentation(for: automation))
    }

    @MainActor
    func testUnqueryableCollaborationUsesNonExecutableSystemEventPresentation() throws {
        var anomaly = item(id: "anomaly", type: "userMessage", text: "raw")
        anomaly.presentationRole = "system_event"
        anomaly.collaborationTaskId = "task:missing"
        anomaly.systemEventKind = "invalid_collaboration_envelope"
        anomaly.systemEventReason = "task_not_found"
        anomaly.systemEventSource = "collaboration"

        XCTAssertNil(nativeCollaborationCardPresentation(for: anomaly, currentSessionTitle: "Session"))
        let presentation = try XCTUnwrap(nativeSystemEventCardPresentation(for: anomaly))
        XCTAssertTrue(presentation.title.contains("System Event"))
        XCTAssertTrue(presentation.bodyMarkdown.contains("task:missing"))
        XCTAssertTrue(presentation.bodyMarkdown.contains("not an executable"))
    }

    @MainActor
    func testExpandedExecutionRawStatusUsesLatestProviderItem() {
        var first = item(id: "command", type: "commandExecution", text: "$ npm test")
        first.rawMetadataJSON = "{\"command\":\"npm test\"}"
        var latest = item(id: "reasoning", type: "reasoning", text: "Thinking", turnStatus: "inProgress")
        latest.rawMetadataJSON = "{\"type\":\"reasoning\",\"summary\":[]}"

        let rawStatus = processRawStatusText(for: [first, latest])

        XCTAssertTrue(rawStatus.contains("item_id: reasoning"))
        XCTAssertTrue(rawStatus.contains("turn_status: inProgress"))
        XCTAssertTrue(rawStatus.contains("provider_metadata:"))
        XCTAssertTrue(rawStatus.contains("\"summary\":[]"))
        XCTAssertFalse(rawStatus.contains("npm test"))
    }

    func testPlainUserAndAgentMessagesRemainNative() {
        XCTAssertEqual(
            ChatTimelineRowRouting.route(
                for: ChatDisplayEntry(kind: .message(item(id: "user", type: "userMessage", text: "hi")))
            ),
            .native
        )
        XCTAssertEqual(
            ChatTimelineRowRouting.route(
                for: ChatDisplayEntry(kind: .message(item(id: "agent", type: "agentMessage", text: "Ready")))
            ),
            .native
        )
    }

    func testLongAgentReplyUsesDeterministicNativeLayoutPath() {
        let longReply = String(repeating: "A long model reply that wraps across several lines. ", count: 20)
        XCTAssertEqual(
            ChatTimelineRowRouting.route(
                for: ChatDisplayEntry(kind: .message(item(id: "long", type: "agentMessage", text: longReply)))
            ),
            .native
        )
        let manyLines = (0..<12).map { "line \($0)" }.joined(separator: "\n")
        XCTAssertEqual(
            ChatTimelineRowRouting.route(
                for: ChatDisplayEntry(kind: .message(item(id: "lines", type: "agentMessage", text: manyLines)))
            ),
            .native
        )
    }

    func testRichMarkdownStillUsesTheNativeTimelineLayout() {
        let markdown = "```swift\nlet value = 42\n```"
        XCTAssertEqual(
            ChatTimelineRowRouting.route(
                for: ChatDisplayEntry(kind: .message(item(id: "code", type: "agentMessage", text: markdown)))
            ),
            .native
        )
    }

    private func item(
        id: String,
        type: String,
        text: String,
        turnStatus: String = "complete",
        createdAt: String = "2026-08-12T03:55:44.520Z"
    ) -> CodexThreadItem {
        CodexThreadItem(
            id: id,
            turnId: "turn",
            turnStatus: turnStatus,
            type: type,
            title: type == "userMessage" ? "User" : "Claude Code",
            text: text,
            options: nil,
            status: nil,
            createdAt: createdAt
        )
    }
}
