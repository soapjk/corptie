import AppKit
import Foundation
import Testing
@testable import CorptieMac

struct DetachedChatWindowTests {
    @Test
    func chatHeaderExposesAnIndependentFloatingWindowAction() throws {
        let source = try contents(of: "Conversation/ConversationHeader.swift")

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
        #expect(source.contains("systemImage: \"arrow.uturn.backward\""))
        #expect(source.contains("func returnToMain(sessionID: String)"))
        #expect(source.contains("close(sessionID: sessionID)"))
        #expect(source.contains("AppDelegate.shared?.openSessionInMainWindow(sessionID: sessionID)"))
        #expect(source.contains("DetachedChatWindowDragArea()"))
        #expect(source.contains("override func mouseDragged(with event: NSEvent)"))
        #expect(source.contains("window?.performDrag(with: event)"))
        #expect(source.contains("func windowDidEndLiveResize(_ notification: Notification)"))
        #expect(source.contains("panel.setFrame(frame, display: true, animate: true)"))
        #expect(source.contains(".popover(isPresented: $showsWindowPresets"))
        #expect(source.contains("DetachedWindowTrafficLightButton("))
        #expect(source.contains("panel.setFrameUsingName(frameName)"))
        #expect(source.contains("panel.setFrameAutosaveName(frameName)"))
        #expect(source.contains("panel.saveFrame(usingName:"))
    }

    @Test
    func detachedWindowPresetsUseTheCurrentScreensVisibleFrame() {
        let screen = NSRect(x: 100, y: 50, width: 3_200, height: 1_800)
        let minimum = NSSize(width: 220, height: 420)
        let normal = NSSize(width: 560, height: 640)

        let right = DetachedChatWindowGeometry.frame(
            for: .narrowRight,
            visibleFrame: screen,
            normalSize: normal,
            minimumSize: minimum
        )
        #expect(right == NSRect(x: 2_500, y: 50, width: 800, height: 1_800))

        let left = DetachedChatWindowGeometry.frame(
            for: .narrowLeft,
            visibleFrame: screen,
            normalSize: normal,
            minimumSize: minimum
        )
        #expect(left == NSRect(x: 100, y: 50, width: 800, height: 1_800))

        let smallerScreen = NSRect(x: 0, y: 0, width: 1_440, height: 900)
        let narrowOnSmallerScreen = DetachedChatWindowGeometry.frame(
            for: .narrowRight,
            visibleFrame: smallerScreen,
            normalSize: normal,
            minimumSize: minimum
        )
        #expect(narrowOnSmallerScreen.width == 440)

        let maximized = DetachedChatWindowGeometry.frame(
            for: .maximized,
            visibleFrame: screen,
            normalSize: normal,
            minimumSize: minimum
        )
        #expect(maximized == screen)
    }

    @Test
    func detachedWindowRestoredFrameStaysVisibleAndPreservesPosition() {
        let primary = NSRect(x: 0, y: 0, width: 1_440, height: 900)
        let secondary = NSRect(x: 1_440, y: 0, width: 1_920, height: 1_080)
        let requested = NSRect(x: 1_700, y: 180, width: 620, height: 740)

        #expect(DetachedChatWindowGeometry.constrainedFrame(
            requested,
            in: [primary, secondary],
            fallback: primary
        ) == requested)
        #expect(DetachedChatWindowGeometry.constrainedFrame(
            requested,
            in: [primary],
            fallback: primary
        ) == NSRect(x: 820, y: 160, width: 620, height: 740))
        #expect(DetachedChatWindowFrameStore.name(for: "session:one")
            != DetachedChatWindowFrameStore.name(for: "session:two"))
    }

    @Test @MainActor
    func appKitPersistsDetachedWindowPositionAndSize() {
        let name = DetachedChatWindowFrameStore.name(for: "test:\(UUID().uuidString)")
        defer { NSWindow.removeFrame(usingName: name) }
        let initial = NSRect(x: 120, y: 130, width: 440, height: 520)
        let expected = NSRect(x: 230, y: 240, width: 600, height: 700)
        let panel = NSPanel(contentRect: initial, styleMask: [.resizable], backing: .buffered, defer: false)
        #expect(panel.setFrameAutosaveName(name))
        panel.setFrame(expected, display: false)
        panel.saveFrame(usingName: name)

        let reopened = NSPanel(contentRect: initial, styleMask: [.resizable], backing: .buffered, defer: false)
        #expect(reopened.setFrameUsingName(name))
        #expect(reopened.frame == expected)
    }

    @Test
    func detachedWindowSizeIsRememberedPerSession() throws {
        let suiteName = "DetachedChatWindowTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        DetachedChatWindowSizeStore.save(
            NSSize(width: 612, height: 734),
            for: "session:one",
            defaults: defaults
        )

        #expect(DetachedChatWindowSizeStore.size(for: "session:one", defaults: defaults)
            == NSSize(width: 612, height: 734))
        #expect(DetachedChatWindowSizeStore.size(for: "session:two", defaults: defaults) == nil)
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

        let appSource = try contents(of: "Application/AppDelegate.swift")
        #expect(appSource.contains("DispatchQueue.main.async { [weak self] in"))
        #expect(appSource.contains("detachedChatWindowIsKey: DetachedChatWindowManager.shared.hasKeyWindow"))
    }

    @Test
    func returningFromDetachedChatOpensTheMatchingMainWindowSession() throws {
        let source = try contents(of: "Application/AppDelegate.swift")

        #expect(source.contains("func openSessionInMainWindow(sessionID: String)"))
        #expect(source.contains("openWarRoom()"))
        #expect(source.contains("AppTabRouter.shared.openSession(sessionID, source: .userSelection)"))
    }

    @Test
    func detachedComposerTargetsItsOwnSessionWithoutChangingGlobalSelection() throws {
        let source = try contents(of: "Conversation/Composer/MessageComposer.swift")
        let composerStart = try #require(source.range(of: "struct MessageComposer: View"))
        let composer = source[composerStart.lowerBound..<source.endIndex]

        #expect(composer.contains("backendClient.sendMessage(submission.text, to: session"))
        #expect(composer.contains("SessionComposerStopButton(session: session)"))
        let stopButton = try contents(of: "SessionComposerStopButton.swift")
        #expect(stopButton.contains("backendClient.interrupt(session: session, surface: .sessionDetailComposerControl)"))
        #expect(!stopButton.contains("backendClient.selectedSession"))
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
