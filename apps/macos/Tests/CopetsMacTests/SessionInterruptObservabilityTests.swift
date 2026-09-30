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
        let rootSource = try source(named: "Floating/SessionList/SessionCards.swift")
            + source(named: "Conversation/Composer/MessageComposer.swift")
        let taskSource = try source(named: "WorkTasks/CorptieTaskDetailView.swift")

        #expect(rootSource.contains("surface: .sessionListRowControl"))
        let stopSource = try source(named: "SessionComposerStopButton.swift")
        #expect(stopSource.contains("surface: .sessionDetailComposerControl"))
        #expect(stopSource.contains("session.executionTaskStatus == .running"))
        #expect(stopSource.contains("session.canInterruptNow"))
        #expect(stopSource.contains(".disabled(!backendClient.isOnline)"))
        #expect(rootSource.contains("SessionComposerStopButton(session: session)"))
        for name in ["Conversation/ConversationHeader.swift", "WorkspaceMessagePanel.swift", "DetachedChatWindowManager.swift"] {
            #expect(try !source(named: name).contains("SessionHeaderStopButton"))
        }
        #expect(taskSource.contains("surface: .taskDetailExecutionControl"))
    }

    @Test
    func stopButtonHasDefinedCircleInComposerHeader() throws {
        let button = try source(named: "SessionComposerStopButton.swift")
        #expect(button.contains(".conversationGlassControl(tint: .red)"))
        #expect(button.contains(".contentShape(Rectangle())"))
        #expect(button.contains(".frame(width: 44, height: 32)"))
        let composer = try source(named: "Conversation/Composer/MessageComposer.swift")
        let chrome = try #require(composer.range(of: "ConversationComposerChrome {"))
        let status = try #require(composer.range(of: "ThreadMetaView(", range: chrome.lowerBound..<composer.endIndex))
        let stop = try #require(composer.range(of: "SessionComposerStopButton(session: session)", range: chrome.lowerBound..<composer.endIndex))
        #expect(status.lowerBound < stop.lowerBound)
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
