import AppKit
import Testing
@testable import CorptieMac

@MainActor
struct CompactWindowControlsTests {
    private final class CloseRecorder: NSObject, NSWindowDelegate {
        var requests = 0
        func windowShouldClose(_ sender: NSWindow) -> Bool { requests += 1; return false }
    }

    @Test func compactButtonsFitInsideRailAndRestoreTheHiddenSystemControls() throws {
        let window = makeWindow()
        defer { window.contentView = nil; window.close() }
        let native = try [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].map {
            try #require(window.standardWindowButton($0))
        }
        native[1].isHidden = true
        let frames = native.map(\.frame)
        let controls = mount(on: window)
        #expect(native.allSatisfy { $0.isHidden })
        for button in controls.buttons {
            let rect = controls.convert(button.dotRect, from: button)
            #expect(rect.width == 12)
            #expect(rect.minX >= 8 && rect.maxX <= MainNavigationRailLayout.width - 8)
            #expect(controls.bounds.contains(button.frame))
            let center = button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: nil)
            #expect(controls.button(at: center) === button)
        }
        controls.removeFromSuperview()
        #expect(!native[0].isHidden && native[1].isHidden && !native[2].isHidden)
        #expect(native.map(\.frame) == frames)
        #expect(window.compactWindowControls == nil)
    }

    @Test func placementsRespectDesktopCoordinatesAndStayInsideTheVisibleScreen() {
        for area in [NSRect(x: 0, y: 24, width: 1440, height: 850),
                     NSRect(x: -1920, y: -900, width: 1920, height: 1080)] {
            for placement in CompactWindowPlacement.allCases {
                #expect(area.contains(placement.frame(in: area)))
            }
            let left = CompactWindowPlacement.left.frame(in: area)
            let right = CompactWindowPlacement.right.frame(in: area)
            #expect(left.maxX == right.minX)
            #expect(left.union(right) == area)
            #expect(CompactWindowPlacement.top.frame(in: area).maxY == area.maxY)
            #expect(CompactWindowPlacement.bottom.frame(in: area).minY == area.minY)
        }
    }

    @Test func placingAndRestoringOperateOnTheBoundWindow() throws {
        let window = makeWindow()
        defer { window.contentView = nil; window.close() }
        let controls = mount(on: window)
        let original = window.frame
        let screen = try #require(window.screen)
        controls.place(.fill)
        #expect(window.frame == screen.visibleFrame)
        controls.place(.left)
        #expect(window.frame == CompactWindowPlacement.left.frame(in: screen.visibleFrame))
        controls.restore()
        #expect(window.frame == original)
    }

    @Test func closeUsesTheBoundWindowsDelegateAndDoesNotSelectAnotherWindow() throws {
        let window = makeWindow(), other = makeWindow()
        let first = CloseRecorder(), second = CloseRecorder()
        window.delegate = first; other.delegate = second
        defer { window.contentView = nil; other.contentView = nil; window.close(); other.close() }
        let controls = mount(on: window)
        window.orderBack(nil)
        controls.buttons[0].performClick(nil)
        #expect(first.requests == 1)
        #expect(second.requests == 0)
        #expect(window.isVisible)
    }

    private func makeWindow(style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]) -> MainWindow {
        _ = NSApplication.shared
        let window = MainWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 400),
                                styleMask: style, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        return window
    }

    private func mount(on window: MainWindow) -> CompactWindowControlsView {
        let controls = CompactWindowControlsView()
        controls.frame.origin = NSPoint(x: 0, y: (window.contentView?.bounds.height ?? 400) - 32)
        window.contentView?.addSubview(controls)
        controls.layoutSubtreeIfNeeded()
        return controls
    }
}
