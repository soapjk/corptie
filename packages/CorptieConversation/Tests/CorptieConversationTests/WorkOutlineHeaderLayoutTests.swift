import Foundation
import SwiftUI
import Testing
#if os(macOS)
import AppKit
@testable import CorptieConversation

@MainActor struct WorkOutlineHeaderLayoutTests {
    @Test func longTitleReclaimsSpacePreviouslyTakenByBlankButton() throws {
        let name = String(repeating: "较长的Work标题", count: 10)
        let old = geometry(name: name, width: 312, legacy: true)
        let new = geometry(name: name, width: 312)
        #expect(try frame("title", new).width > frame("title", old).width + 30)
        #expect(try frame("discussion", new).maxX >= 312 - 24 - 16)
        #expect(try abs(frame("actions", new).maxX - 312) < 1)
    }

    @Test func shortTitlesKeepDiscussionAdjacentAndLongTitlesExhaustWhitespaceFirst() throws {
        for width in [180.0, 240.0, 312.0, 600.0] {
            for name in ["短", "Work", "中英文标题", String(repeating: "W", count: 100), String(repeating: "长标题", count: 40)] {
                let result = geometry(name: name, width: width)
                let title = try frame("title", result), discussion = try frame("discussion", result)
                let actions = try frame("actions", result)
                #expect(abs(discussion.minX - title.maxX - 6) < 1)
                #expect(discussion.width >= 49 && discussion.maxX <= actions.minX)
                #expect(abs(actions.maxX - width) < 1)
                #expect(title.minX >= 0 && title.width > 0)
                // Text may return an intrinsic width rounded to the last whole
                // glyph, leaving at most one glyph plus the 4pt minimum gap.
                if name.count > 50 { #expect(actions.minX - discussion.maxX <= 16) }
            }
        }
    }

    @Test func noDiscussionReservesNoBadgeOrGapAndHoverKeepsWidthStable() throws {
        let long = String(repeating: "Work", count: 40)
        let absent = geometry(name: long, width: 312, discussions: 0)
        let present = geometry(name: long, width: 312)
        #expect(try frame("title", absent).width >= frame("title", present).width + 55)
        let hover = geometry(name: long, width: 312, hover: true)
        #expect(try frame("title", hover) == frame("title", present))
        #expect(try frame("actions", hover) == frame("actions", present))
    }

    @Test func multipleDiscussionsUseOverflowOnlyWhenTheyCannotFit() throws {
        let narrow = geometry(name: String(repeating: "长标题", count: 40), width: 240, discussions: 3)
        #expect(narrow.frames["overflow"] != nil)
        #expect(try frame("overflow", narrow).maxX <= frame("actions", narrow).minX)
        #expect(try frame("title", narrow).width > 100)
        let wide = geometry(name: "短", width: 600, discussions: 3)
        #expect(wide.frames["discussion"] != nil)
        #expect(wide.frames["overflow"] == nil)
    }

    @Test func mobileSizedControlsAndLargeTitlesStayInsideNarrowRows() throws {
        for width in [240.0, 375.0, 768.0] {
            for fontSize in [16.0, 28.0] {
                let capture = FrameCapture()
                let host = NSHostingView(rootView: WorkOutlineHeaderRow(minimumHeight: 44, toggleExpanded: {}) {
                    Button {} label: {
                        HStack(spacing: 7) {
                            Color.clear.frame(width: 28, height: 28)
                            ConsoleWorkTitle(title: String(repeating: "较长标题", count: 20), isWorking: true, isActive: false)
                                .font(.system(size: fontSize, weight: .semibold)).lineLimit(fontSize > 16 ? 2 : 1)
                        }.frame(minHeight: 44)
                    }.buttonStyle(.plain).background(FrameProbe(id: "title", capture: capture))
                } discussion: {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 6) {
                            ForEach(0..<3) { _ in WorkDiscussionButton(isSelected: false, isRunning: false, minimumHitHeight: 44) {} }
                        }.fixedSize()
                        Menu {} label: {
                            WorkDiscussionLabel(isSelected: true, isRunning: true, isActive: false,
                                hasUnread: true, title: "讨论 3", minimumHitHeight: 44)
                        }.buttonStyle(.plain).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                            .fixedSize().background(FrameProbe(id: "overflow", capture: capture))
                    }.padding(.leading, 6)
                } actions: {
                    UnreadSessionDot().background(FrameProbe(id: "unread", capture: capture))
                }.frame(width: width))
                host.frame = CGRect(x: 0, y: 0, width: width, height: 80)
                host.layoutSubtreeIfNeeded()
                let frames = capture.views.mapValues { $0.convert($0.bounds, to: host) }
                let title = try #require(frames["title"]), menu = try #require(frames["overflow"])
                let unread = try #require(frames["unread"])
                #expect(title.maxX <= menu.minX)
                #expect(menu.width >= 44 && menu.height >= 44)
                #expect(menu.maxX <= unread.minX && unread.maxX <= width)
                #expect(host.fittingSize.height >= 44)
                #expect(host.fittingSize.width <= width)
            }
        }
    }

    @Test func blankTitleDiscussionAndCreateClicksAreIndependent() throws {
        _ = NSApplication.shared
        let capture = FrameCapture()
        var toggles = 0, opens = 0, creates = 0
        let host = NSHostingView(rootView: WorkOutlineHeaderRow(toggleExpanded: { toggles += 1 }) {
            Button { toggles += 1 } label: { Text("Work").padding(4).contentShape(Rectangle()) }
                .buttonStyle(.plain).background(FrameProbe(id: "title", capture: capture))
        } discussion: {
            WorkDiscussionButton(isSelected: false, isRunning: false) { opens += 1 }
                .background(FrameProbe(id: "discussion", capture: capture)).padding(.leading, 6)
        } actions: {
            Button { creates += 1 } label: { Image(systemName: "plus").frame(width: 24, height: 24).contentShape(Rectangle()) }
                .buttonStyle(.plain).background(FrameProbe(id: "actions", capture: capture))
        }.frame(width: 600))
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 600, height: 28),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.orderBack(nil)
        defer { window.orderOut(nil) }
        host.layoutSubtreeIfNeeded()
        func click(_ point: CGPoint) throws {
            let location = host.convert(point, to: nil)
            for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                let event = try #require(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                    timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                    context: nil, eventNumber: 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
                window.sendEvent(event)
            }
            RunLoop.main.run(until: Date().addingTimeInterval(0.03))
        }
        for y in [2.0, 14.0, 26.0] { try click(CGPoint(x: 400, y: y)) }
        #expect(toggles == 3)
        #expect(opens == 0)
        #expect(creates == 0)
        for id in ["title", "discussion", "actions"] {
            let probe = try #require(capture.views[id])
            let rect = probe.convert(probe.bounds, to: host)
            try click(CGPoint(x: rect.midX, y: rect.midY))
        }
        #expect(toggles == 4)
        #expect(opens == 1)
        #expect(creates == 1)
    }

    @Test func manyHeadersDoNotIntroduceLayoutObserversOrSignificantOverhead() {
        // Warm fonts/SwiftUI before comparing the same fixed-size list fixture.
        _ = geometry(name: "Warmup", width: 312)
        func duration(legacy: Bool) -> TimeInterval {
            let start = Date()
            let capture = FrameCapture()
            let host = NSHostingView(rootView: VStack(spacing: 0) {
                ForEach(0..<100, id: \.self) { index in
                    Fixture(name: "Work_\(index)_长标题回归", legacy: legacy, capture: capture)
                }
            }.frame(width: 312))
            host.frame = CGRect(x: 0, y: 0, width: 312, height: 2800)
            host.layoutSubtreeIfNeeded()
            _ = host.fittingSize
            return Date().timeIntervalSince(start)
        }
        let old = duration(legacy: true), new = duration(legacy: false)
        print("Work header 100-row native layout: legacy=\(old)s updated=\(new)s")
        #expect(new < old * 2 + 0.5)
    }

    private func geometry(name: String, width: CGFloat, legacy: Bool = false, discussions: Int = 1,
                          hover: Bool = false) -> (frames: [String: CGRect], host: NSView) {
        let capture = FrameCapture()
        let host = NSHostingView(rootView: Fixture(name: name, legacy: legacy,
            discussions: discussions, hover: hover, capture: capture).frame(width: width))
        host.frame = CGRect(x: 0, y: 0, width: width, height: 28)
        host.layoutSubtreeIfNeeded()
        return (capture.views.mapValues { $0.convert($0.bounds, to: host) }, host)
    }
    private func frame(_ id: String, _ result: (frames: [String: CGRect], host: NSView)) throws -> CGRect {
        try #require(result.frames[id] ?? (id == "discussion" ? result.frames["overflow"] : nil),
            "Missing \(id): \(result.frames)")
    }

    private struct Fixture: View {
        let name: String
        var legacy = false
        var discussions = 1
        var hover = false
        let capture: FrameCapture
        var title: some View {
            Button {} label: {
                HStack(spacing: 7) {
                    Color.clear.frame(width: 22, height: 22)
                    ConsoleWorkTitle(title: name, isWorking: false).font(.system(size: 11, weight: .semibold)).lineLimit(1)
                }.padding(.vertical, 3)
            }.buttonStyle(.plain).background(FrameProbe(id: "title", capture: capture))
        }
        @ViewBuilder var discussion: some View {
            if discussions == 1 {
                Color.clear.frame(width: 50, height: 28)
                    .background(FrameProbe(id: "discussion", capture: capture)).padding(.leading, 6)
            } else if discussions > 0 {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 6) {
                        ForEach(0..<discussions, id: \.self) { _ in Color.clear.frame(width: 50, height: 28) }
                    }.fixedSize().background(FrameProbe(id: "discussion", capture: capture))
                    Color.clear.frame(width: 50, height: 28).background(FrameProbe(id: "overflow", capture: capture))
                }.padding(.leading, 6)
            }
        }
        var actions: some View {
            Color.clear.frame(width: 24, height: 24).opacity(hover ? 1 : 0.45)
                .background(FrameProbe(id: "actions", capture: capture))
        }
        var body: some View {
            if legacy {
                HStack(spacing: 0) {
                    title
                    discussion
                    Button {} label: { HStack { Spacer(minLength: 4) }.frame(minHeight: 28) }.buttonStyle(.plain)
                    actions
                }
            } else {
                WorkOutlineHeaderRow(toggleExpanded: {}) { title } discussion: { discussion } actions: { actions }
            }
        }
    }
}

@MainActor private final class FrameCapture { var views: [String: NSView] = [:] }
private struct FrameProbe: NSViewRepresentable {
    let id: String
    let capture: FrameCapture
    func makeNSView(context: Context) -> NSView {
        let view = ProbeView(); capture.views[id] = view; return view
    }
    func updateNSView(_ view: NSView, context: Context) { capture.views[id] = view }
    private final class ProbeView: NSView { override func hitTest(_ point: NSPoint) -> NSView? { nil } }
}
#endif
