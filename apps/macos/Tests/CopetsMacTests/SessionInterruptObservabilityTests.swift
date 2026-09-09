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
        let rootSource = try source(named: "FloatingRootView.swift")
        let taskSource = try source(named: "WarRoomView.swift")

        #expect(rootSource.contains("surface: .sessionListRowControl"))
        let headerSource = try source(named: "SessionHeaderStopButton.swift")
        #expect(headerSource.contains("surface: .sessionDetailToolbar"))
        #expect(headerSource.contains("session.executionTaskStatus == .running && session.canInterruptNow"))
        #expect(headerSource.contains(".disabled(!backendClient.isOnline)"))
        #expect(!rootSource.contains("surface: .sessionDetailComposerControl"))
        for name in ["FloatingRootView.swift", "WorkspaceMessagePanel.swift", "DetachedChatWindowManager.swift"] {
            #expect(try source(named: name).contains("SessionHeaderStopButton(session: session)"))
        }
        #expect(taskSource.contains("surface: .taskDetailExecutionControl"))
    }

    @Test
    func stopButtonHasDefinedCircleAndPrecedesDetachButton() throws {
        let button = try source(named: "SessionHeaderStopButton.swift")
        #expect(button.contains(".background(Color.red.opacity(0.22), in: Circle())"))
        #expect(button.contains("Circle().strokeBorder(Color.red.opacity(0.45), lineWidth: 1)"))
        let root = try source(named: "FloatingRootView.swift")
        let start = try #require(root.range(of: "struct DetailHeaderView: View"))
        let header = root[start.lowerBound...]
        let stop = try #require(header.range(of: "SessionHeaderStopButton(session: session)"))
        let detach = try #require(header.range(of: "DetachedChatWindowManager.shared.show(session: session)"))
        #expect(stop.lowerBound < detach.lowerBound)
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
