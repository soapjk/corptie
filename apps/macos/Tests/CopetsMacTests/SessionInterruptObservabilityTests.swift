import Foundation
import Testing
@testable import CorptieMac

struct SessionInterruptObservabilityTests {
    @Test
    func interruptRequestEncodesExactClientInteractionSource() throws {
        let source = SessionInterruptSource.userAction(
            surface: .taskDetailExecutionControl,
            interactionId: "interrupt:test-interaction",
            clientTimestampMs: 1_788_572_227_389
        )

        let data = try JSONEncoder().encode(SessionInterruptRequest(source: source))
        let payload = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let encodedSource = try #require(payload["source"] as? [String: Any])

        #expect(encodedSource["type"] as? String == "desktop")
        #expect(encodedSource["surface"] as? String == "task_detail.execution_control")
        #expect(encodedSource["action"] as? String == "interrupt_session")
        #expect(encodedSource["trigger"] as? String == "button")
        #expect(encodedSource["interactionId"] as? String == "interrupt:test-interaction")
        #expect(encodedSource["clientTimestampMs"] as? Int == 1_788_572_227_389)
    }

    @Test
    func everyInterruptButtonDeclaresItsOwnSurface() throws {
        let rootSource = try source(named: "Conversation/Composer/MessageComposer.swift")
        let taskSource = try source(named: "WorkTasks/CorptieTaskDetailView.swift")

        let stopSource = try source(named: "SessionComposerStopButton.swift")
        #expect(stopSource.contains("surface: .sessionDetailComposerControl"))
        #expect(stopSource.contains("session.executionTaskStatus == .running"))
        #expect(stopSource.contains("session.canInterruptNow"))
        #expect(stopSource.contains(".disabled(!online)"))
        #expect(rootSource.contains("SessionComposerStopSurface(session: session, online: online"))
        for name in ["Conversation/ConversationHeader.swift", "WorkspaceMessagePanel.swift", "DetachedChatWindowManager.swift"] {
            #expect(try !source(named: name).contains("SessionHeaderStopButton"))
        }
        #expect(taskSource.contains("surface: .taskDetailExecutionControl"))
    }

    @Test
    func stopButtonUsesTintedCircleAndOnlyOccupiesSpaceWhileInterruptible() throws {
        let button = try source(named: "SessionComposerStopButton.swift")
        #expect(button.contains(".background(Color.red.opacity(0.12), in: Circle())"))
        #expect(button.contains(".contentShape(Circle())"))
        #expect(!button.contains("conversationGlassControl"))
        #expect(!button.contains("strokeBorder"))
        #expect(!button.contains("compact ? ComposerShellMetrics.actionHitEdge : 44"))
        let composer = try source(named: "Conversation/Composer/MessageComposer.swift")
        #expect(composer.contains("headerAtBottom: true"))
        let footer = try #require(composer.range(of: "private var composerToolbar:"))
        let status = try #require(composer.range(of: "statusRow", range: footer.lowerBound..<composer.endIndex))
        let stop = try #require(composer.range(of: "stopButton(compact: false)", range: footer.lowerBound..<composer.endIndex))
        #expect(status.lowerBound < stop.lowerBound)
        #expect(composer.contains("if showsStopControl {"))
        #expect(composer.contains(".transition(.move(edge: .trailing).combined(with: .opacity))"))
        #expect(composer.contains(".animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: showsStopControl)"))
    }

    private func source(named name: String) throws -> String {
        let testsURL = URL(fileURLWithPath: #filePath)
        let packageRoot = testsURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(
            contentsOf: packageRoot.appendingPathComponent("Sources/CopetsMac/\(name)"),
            encoding: .utf8
        )
    }
}
