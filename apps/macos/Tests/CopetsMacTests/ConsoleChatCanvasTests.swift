import Foundation
import Testing
@testable import CorptieMac

struct ConsoleChatCanvasTests {
    @Test func discussionBorderUsesOwnSessionAndIsolatesAnimation() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources/CopetsMac")
        let canvas = try String(contentsOf: root.appendingPathComponent("ConsoleCardWorkspace.swift"), encoding: .utf8)
        let outline = try String(contentsOf: root.appendingPathComponent("UnifiedConsoleView.swift"), encoding: .utf8)
        let border = try String(contentsOf: root.appendingPathComponent("ConsoleDiscussionActivityBorder.swift"), encoding: .utf8)
        #expect(outline.contains("isChatRunning: workChat?.executionTaskStatus == .running"))
        #expect(canvas.contains("session.archived != true && session.resolvedSessionKind == .workChat"))
        #expect(canvas.contains("isChatSelected: discussionSessionIDByWork[work.id].map { selectedSessionID == $0 } ?? false"))
        #expect(canvas.contains("isChatSelected ? Color.accentColor : Color.secondary"))
        #expect(canvas.contains("isChatSelected ? Color.accentColor.opacity(0.16)"))
        #expect(canvas.contains("ConsoleDiscussionActivityBorder(isRunning: isChatRunning, isActive: isActive)"))
        #expect(border.contains("paused: !isVisible || !isActive || reduceMotion"))
        #expect(border.contains(".allowsHitTesting(false)"))
        #expect(border.contains(".strokeBorder(AngularGradient("))
        #expect(!border.contains("GeometryReader"))
        #expect(ConsoleWorkFlowingGradientPolicy.progress(at: Date(timeIntervalSinceReferenceDate: 0.5))
            != ConsoleWorkFlowingGradientPolicy.progress(at: Date(timeIntervalSinceReferenceDate: 1)))
    }

    @Test func runningTaskTitleReusesWorkGradientWithoutChangingStatusRules() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources/CopetsMac")
        let canvas = try String(contentsOf: root.appendingPathComponent("ConsoleCardWorkspace.swift"), encoding: .utf8)
        let shared = try String(contentsOf: root.appendingPathComponent("UnifiedConsoleView.swift"), encoding: .utf8)
        let label = try String(contentsOf: root.appendingPathComponent("ConsoleConversationCardLabel.swift"), encoding: .utf8)
        #expect(canvas.contains("ConsoleConversationCardLabel(title: task.title"))
        #expect(label.contains("ConsoleWorkTitle(title: title, isWorking: execution == .running, isActive: isActive)"))
        #expect(shared.contains("animates: !accessibilityReduceMotion && isActive"))
        #expect(shared.contains("paused: !isVisible"))
    }

    @Test func previewShowsSummaryRegardlessOfInterventionAndMarksStaleContent() {
        let content = TaskUserSummary.Content(schemaVersion: 1, focus: "当前目标", progress: "已完成初步分析",
            intervention: "not_required", reason: "无需操作", nextAction: "继续执行", sourceRefs: [],
            generatedAt: "", providerID: nil, model: nil,
            basis: .init(taskRevision: 1, sessionID: "s", timelineRevision: 1), messageSummary: "最新消息摘要")
        #expect(TaskCardSummaryPreview.text(content: content, isCurrent: true,
            sessionSummary: "会话摘要", description: "任务描述") == "最新消息摘要")
        #expect(TaskCardSummaryPreview.text(content: content, isCurrent: false,
            sessionSummary: nil, description: "任务描述").hasPrefix("旧摘要 · 待更新 · "))
        #expect(TaskCardSummaryPreview.text(content: nil, isCurrent: false,
            sessionSummary: "会话摘要", description: "任务描述") == "会话摘要")
        #expect(TaskCardSummaryPreview.text(content: nil, isCurrent: false,
            sessionSummary: " \n", description: "任务描述") == "任务描述")
        #expect(TaskCardSummaryPreview.text(content: nil, isCurrent: false,
            sessionSummary: nil, description: "") == "摘要待生成")
        #expect(TaskCardSummaryPreview.text(content: nil, isCurrent: false,
            sessionSummary: nil, description: String(repeating: "文", count: 500)).count == 101)
    }

    @Test func chatLivesInCanvasAndSharesInteractionWithoutAttentionFiltering() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources/CopetsMac")
        let console = try String(contentsOf: root.appendingPathComponent("UnifiedConsoleView.swift"), encoding: .utf8)
        let canvas = try String(contentsOf: root.appendingPathComponent("ConsoleCardWorkspace.swift"), encoding: .utf8)
        let chat = try String(contentsOf: root.appendingPathComponent("ConsoleChatCanvasCard.swift"), encoding: .utf8)
        #expect(!console.contains("cardChatVisible"))
        #expect(canvas.contains("ConsoleChatCanvasCard(sessions: chatSessions"))
        #expect(canvas.contains(".modifier(groupInteraction(for: Self.chatCardID))"))
        #expect(canvas.contains(".modifier(groupInteraction(for: work.id))"))
        #expect(chat.contains("ForEach(sessions)"))
        #expect(chat.contains("ConsoleConversationCardLabel(title: session.title"))
        #expect(chat.contains("session.hasPendingScheduledWake == true"))
        #expect(chat.contains("SessionContextMenuContent(session: session"))
        #expect(chat.contains("session.attention?.reason ?? session.summary"))
        #expect(!chat.contains("ConsoleAttentionPolicy"))
    }
}
