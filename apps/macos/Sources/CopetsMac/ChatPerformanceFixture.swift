import Foundation

struct ChatPerformanceFixture: Sendable {
    struct Configuration: Equatable, Sendable {
        var turnCount = 400
        var rawItemCount = 10_000
        var longMessageCharacters = 20_000

        static let standard = Configuration()
    }

    let session: TaskSession
    let detail: CodexThreadDetail

    static func make(configuration: Configuration = .standard) -> ChatPerformanceFixture {
        precondition(configuration.turnCount > 0)
        precondition(configuration.rawItemCount >= configuration.turnCount * 3)

        let sessionId = "performance:chat-timeline-standard"
        let createdAt = "2026-08-12T00:00:00.000Z"
        let session = TaskSession(
            id: sessionId,
            title: "Chat Timeline Performance",
            agent: "Fixture",
            agentId: nil,
            sessionKind: nil,
            status: .complete,
            progress: 1,
            summary: "Local deterministic performance fixture",
            suggestedOptions: nil,
            suggestedPrompt: nil,
            activityStatus: nil,
            updatedAt: createdAt,
            accent: .violet,
            archived: false,
            pinned: false,
            sortOrder: 0,
            capabilities: nil,
            external: ExternalSession(
                provider: "fixture",
                threadId: sessionId,
                sessionId: sessionId,
                agentSessionId: nil,
                connectionStatus: "connected",
                currentModel: "fixture-model",
                currentReasoningLevel: nil,
                cwd: "/private/tmp/corptie-chat-performance-fixture",
                sandbox: nil,
                approvalPolicy: nil,
                source: "local-fixture",
                logicalSessionId: sessionId,
                workspace: nil,
                routingVersion: 1,
                providerSwitchInFlight: nil,
                providerTransition: nil
            )
        )

        var items: [CodexThreadItem] = []
        items.reserveCapacity(configuration.rawItemCount)
        let baseItemsPerTurn = configuration.rawItemCount / configuration.turnCount
        let turnsWithExtraItem = configuration.rawItemCount % configuration.turnCount

        for turnIndex in 0..<configuration.turnCount {
            let turnId = "fixture-turn-\(turnIndex)"
            let itemCount = baseItemsPerTurn + (turnIndex < turnsWithExtraItem ? 1 : 0)
            items.append(item(
                id: "\(turnId)-user",
                turnId: turnId,
                type: "userMessage",
                title: "User",
                text: userMessage(turnIndex),
                createdAt: timestamp(turnIndex: turnIndex, itemIndex: 0)
            ))

            let hasTrailingCard = turnIndex.isMultiple(of: 2)
            let processCount = itemCount - 1 - (hasTrailingCard ? 1 : 0)
            for processIndex in 0..<processCount {
                items.append(processItem(
                    turnIndex: turnIndex,
                    processIndex: processIndex,
                    turnId: turnId,
                    longMessageCharacters: configuration.longMessageCharacters
                ))
            }

            if hasTrailingCard {
                items.append(trailingItem(
                    turnIndex: turnIndex,
                    turnId: turnId,
                    createdAt: timestamp(turnIndex: turnIndex, itemIndex: itemCount - 1)
                ))
            }
        }

        let detail = CodexThreadDetail(
            id: sessionId,
            title: session.title,
            status: .complete,
            source: "fixture",
            connectionStatus: "connected",
            currentModel: "fixture-model",
            currentReasoningLevel: nil,
            activityStatus: nil,
            cwd: session.external?.cwd,
            createdAt: createdAt,
            updatedAt: createdAt,
            canSend: false,
            sendUnavailableReason: "Performance fixture is read-only.",
            capabilities: nil,
            turnCount: configuration.turnCount,
            items: items
        )
        return ChatPerformanceFixture(session: session, detail: detail)
    }

    static func appendingStreamStep(
        _ step: Int,
        to detail: CodexThreadDetail,
        finalStep: Int = 200
    ) -> CodexThreadDetail {
        guard let lastIndex = detail.items.indices.last else { return detail }
        var items = detail.items
        let previous = items[lastIndex]
        items[lastIndex] = CodexThreadItem(
            id: previous.id,
            turnId: previous.turnId,
            turnStatus: step >= finalStep ? "completed" : "running",
            type: previous.type,
            title: previous.title,
            text: previous.text + " fixture-token-\(step)",
            options: previous.options,
            status: previous.status,
            createdAt: previous.createdAt,
            sourceType: previous.sourceType,
            localVisibility: previous.localVisibility,
            workItemId: previous.workItemId,
            collaborationTaskId: previous.collaborationTaskId,
            presentationRole: previous.presentationRole,
            presentationText: previous.presentationText,
            collaborationDirection: previous.collaborationDirection,
            collaborationSenderAgentId: previous.collaborationSenderAgentId,
            collaborationSenderName: previous.collaborationSenderName,
            collaborationRecipientAgentId: previous.collaborationRecipientAgentId,
            collaborationRecipientName: previous.collaborationRecipientName,
            collaborationTaskTitle: previous.collaborationTaskTitle,
            collaborationMessageKind: previous.collaborationMessageKind,
            collaborationProcessingStatus: previous.collaborationProcessingStatus,
            collaborationConfirmationId: previous.collaborationConfirmationId,
            collaborationConfirmationStatus: previous.collaborationConfirmationStatus,
            collaborationAcceptanceCriteria: previous.collaborationAcceptanceCriteria,
            fileChanges: previous.fileChanges,
            turnDiff: previous.turnDiff
        )
        return CodexThreadDetail(
            id: detail.id,
            title: detail.title,
            status: step >= finalStep ? .complete : .running,
            source: detail.source,
            connectionStatus: detail.connectionStatus,
            currentModel: detail.currentModel,
            currentReasoningLevel: detail.currentReasoningLevel,
            activityStatus: step >= finalStep ? nil : "Streaming fixture",
            cwd: detail.cwd,
            createdAt: detail.createdAt,
            updatedAt: "2026-08-12T00:00:\(String(format: "%02d", step % 60)).000Z",
            canSend: detail.canSend,
            sendUnavailableReason: detail.sendUnavailableReason,
            capabilities: detail.capabilities,
            turnCount: detail.turnCount,
            items: items,
            actions: detail.actions
        )
    }

    private static func item(
        id: String,
        turnId: String,
        type: String,
        title: String,
        text: String,
        createdAt: String,
        presentationRole: String? = nil
    ) -> CodexThreadItem {
        CodexThreadItem(
            id: id,
            turnId: turnId,
            turnStatus: "completed",
            type: type,
            title: title,
            text: text,
            options: nil,
            status: nil,
            createdAt: createdAt,
            presentationRole: presentationRole
        )
    }

    private static func processItem(
        turnIndex: Int,
        processIndex: Int,
        turnId: String,
        longMessageCharacters: Int
    ) -> CodexThreadItem {
        let selector = (turnIndex * 31 + processIndex * 17) % 10
        let type: String
        let title: String
        let text: String
        switch selector {
        case 0:
            type = "commandExecution"
            title = "Command"
            text = "swift test --filter ChatTimelinePerformanceTests # \(turnIndex)-\(processIndex)"
        case 1, 2, 3:
            type = "reasoning"
            title = "Reasoning"
            text = markdownBody(turnIndex: turnIndex, processIndex: processIndex)
        case 4:
            type = "fileChange"
            title = "File change"
            text = "Updated /private/tmp/fixture/project/Sources/File\(turnIndex).swift:\(processIndex + 1)"
        case 5 where turnIndex.isMultiple(of: 37):
            type = "reasoning"
            title = "Long message"
            text = String(repeating: "性能基准 long markdown paragraph with [link](https://example.com). ", count: max(1, longMessageCharacters / 64))
        default:
            type = "mcpToolCall"
            title = "Tool"
            text = "Processed deterministic fixture item \(turnIndex)-\(processIndex)."
        }
        return item(
            id: "\(turnId)-process-\(processIndex)",
            turnId: turnId,
            type: type,
            title: title,
            text: text,
            createdAt: timestamp(turnIndex: turnIndex, itemIndex: processIndex + 1)
        )
    }

    private static func trailingItem(turnIndex: Int, turnId: String, createdAt: String) -> CodexThreadItem {
        if turnIndex.isMultiple(of: 20) {
            return CodexThreadItem(
                id: "\(turnId)-approval",
                turnId: turnId,
                turnStatus: "completed",
                type: "approval",
                title: "Approval",
                text: "Approve deterministic fixture action \(turnIndex)?",
                options: [
                    CodexApprovalOption(id: "approve", label: "Approve", role: "approve", index: 0, selected: nil),
                    CodexApprovalOption(id: "reject", label: "Reject", role: "reject", index: 1, selected: nil)
                ],
                status: "pending",
                createdAt: createdAt
            )
        }
        return item(
            id: "\(turnId)-answer",
            turnId: turnId,
            type: "agentMessage",
            title: "Agent",
            text: markdownBody(turnIndex: turnIndex, processIndex: 999),
            createdAt: createdAt,
            presentationRole: "final_answer"
        )
    }

    private static func userMessage(_ turnIndex: Int) -> String {
        "Fixture request \(turnIndex): verify scrolling, window resizing, Markdown, code blocks, and stable anchors."
    }

    private static func markdownBody(turnIndex: Int, processIndex: Int) -> String {
        if (turnIndex + processIndex).isMultiple(of: 10) {
            return """
            ### Fixture \(turnIndex)

            - deterministic row \(processIndex)
            - [local link](file:///private/tmp/corptie-chat-performance-fixture/file.swift)

            ```swift
            let value = \(turnIndex + processIndex)
            print(value)
            ```
            """
        }
        return "Markdown fixture **\(turnIndex)-\(processIndex)** with https://example.com and `/private/tmp/example.swift`."
    }

    private static func timestamp(turnIndex: Int, itemIndex: Int) -> String {
        let seconds = turnIndex * 100 + itemIndex
        return "2026-08-12T00:\(String(format: "%02d", (seconds / 60) % 60)):\(String(format: "%02d", seconds % 60)).000Z"
    }
}
