import Foundation
import Testing
@testable import CorptieMac

struct DetachedChatWindowTests {
    @Test
    func chatHeaderExposesAnIndependentFloatingWindowAction() throws {
        let source = try contents(of: "FloatingRootView.swift")

        #expect(source.contains("DetachedChatWindowManager.shared.show(session: session)"))
        #expect(source.contains("accessibilityIdentifier(\"session.detail.detach\")"))
        #expect(source.contains("Image(systemName: \"macwindow.on.rectangle\")"))
    }

    @Test
    func managerKeepsOneControllerPerSessionAndAllowsDifferentSessions() throws {
        let source = try contents(of: "DetachedChatWindowManager.swift")

        #expect(source.contains("private var controllers: [String: DetachedChatWindowController] = [:]"))
        #expect(source.contains("if let controller = controllers[session.id]"))
        #expect(source.contains("controllers[session.id] = controller"))
        #expect(source.contains("panel.level = .floating"))
        #expect(source.contains("DetachedChatWindowManager.shared.close(sessionID: sessionID)"))
        #expect(source.contains("Image(systemName: \"xmark\")"))
    }

    @Test
    func detachedComposerTargetsItsOwnSessionWithoutChangingGlobalSelection() throws {
        let source = try contents(of: "FloatingRootView.swift")
        let composerStart = try #require(source.range(of: "struct MessageComposer: View"))
        let composer = source[composerStart.lowerBound..<source.endIndex]

        #expect(composer.contains("backendClient.sendMessage(submission.text, to: session"))
        #expect(composer.contains("backendClient.interrupt(session: session)"))
        #expect(composer.contains("backendClient.sessions.first(where: { $0.id == sessionId })"))
    }

    @Test
    func mainWindowNoLongerRendersTheSidebarToggle() throws {
        let source = try contents(of: "MainTabView.swift")

        #expect(!source.contains("MainWindowSidebarToggleButton(sidebarState: sidebarState)"))
    }

    private func contents(of fileName: String) throws -> String {
        let sourceRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac")
        return try String(
            contentsOf: sourceRoot.appendingPathComponent(fileName),
            encoding: .utf8
        )
    }
}
