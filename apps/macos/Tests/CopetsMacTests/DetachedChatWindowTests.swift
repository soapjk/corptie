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
        #expect(source.contains("PersistentRedWindowCloseButton(action: close)"))
        #expect(source.contains("Color(red: 1, green: 0.373, blue: 0.341)"))
        #expect(source.contains(".frame(width: 14, height: 14)"))
        #expect(source.contains(".frame(width: 22, height: 22)"))
        #expect(source.contains("Image(systemName: \"arrow.uturn.backward\")"))
        #expect(source.contains("func returnToMain(sessionID: String)"))
        #expect(source.contains("close(sessionID: sessionID)"))
        #expect(source.contains("AppDelegate.shared?.openSessionInMainWindow(sessionID: sessionID)"))
    }

    @Test
    func detachedChatPanelCanBecomeKeyAndAcceptKeyboardInput() throws {
        let source = try contents(of: "DetachedChatWindowManager.swift")

        #expect(source.contains("private final class DetachedChatPanel: NSPanel"))
        #expect(source.contains("override var canBecomeKey: Bool { true }"))
        #expect(source.contains("override var canBecomeMain: Bool { true }"))
        #expect(source.contains("panel.makeKeyAndOrderFront(nil)"))
        #expect(source.contains("override func acceptsFirstMouse(for event: NSEvent?) -> Bool"))
    }

    @Test
    func detachedChatKeyWindowSuppressesMainWindowActivation() throws {
        #expect(MainWindowActivationPolicy.shouldPresentMainWindow(detachedChatWindowIsKey: false))
        #expect(!MainWindowActivationPolicy.shouldPresentMainWindow(detachedChatWindowIsKey: true))

        let managerSource = try contents(of: "DetachedChatWindowManager.swift")
        #expect(managerSource.contains("var hasKeyWindow: Bool"))
        #expect(managerSource.contains("controllers.values.contains(where: \\.isKeyWindow)"))

        let appSource = try contents(of: "CopetsMacApp.swift")
        #expect(appSource.contains("DispatchQueue.main.async { [weak self] in"))
        #expect(appSource.contains("detachedChatWindowIsKey: DetachedChatWindowManager.shared.hasKeyWindow"))
    }

    @Test
    func returningFromDetachedChatOpensTheMatchingMainWindowSession() throws {
        let source = try contents(of: "CopetsMacApp.swift")

        #expect(source.contains("func openSessionInMainWindow(sessionID: String)"))
        #expect(source.contains("openWarRoom()"))
        #expect(source.contains("AppTabRouter.shared.openSession(sessionID)"))
    }

    @Test
    func detachedComposerTargetsItsOwnSessionWithoutChangingGlobalSelection() throws {
        let source = try contents(of: "FloatingRootView.swift")
        let composerStart = try #require(source.range(of: "struct MessageComposer: View"))
        let composer = source[composerStart.lowerBound..<source.endIndex]

        #expect(composer.contains("backendClient.sendMessage(submission.text, to: session"))
        #expect(composer.contains("surface: .sessionDetailComposerControl"))
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
