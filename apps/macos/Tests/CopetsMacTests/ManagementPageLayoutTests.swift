import AppKit
import SwiftUI
import Testing
import CorptieConversation
@testable import CorptieMac

@MainActor
struct ManagementPageLayoutTests {
    private struct ControlProbe: NSViewRepresentable {
        func makeNSView(context: Context) -> NSView {
            let view = NSView()
            view.identifier = .init("test.settings-control")
            return view
        }
        func updateNSView(_ nsView: NSView, context: Context) {}
    }

    @Test func settingsControlsStackAtNarrowWidthsAndShareTheTrailingColumn() throws {
        let host = NSHostingView(rootView: SettingsOptionRow(title: "语言 / Language",
            explanation: "Choose the language used by this application. 设置说明应随可用宽度换行。") {
                ControlProbe().frame(height: 28)
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading))
        func probe(_ view: NSView) -> NSView? {
            if view.identifier?.rawValue == "test.settings-control" { return view }
            return view.subviews.lazy.compactMap { probe($0) }.first
        }
        for width: CGFloat in [400, 720, 520, 380] {
            host.frame = NSRect(x: 0, y: 0, width: width, height: 300)
            host.layoutSubtreeIfNeeded()
            let control = try #require(probe(host))
            let frame = control.convert(control.bounds, to: host)
            #expect(frame.width <= 220.5)
            #expect(frame.minX >= -0.5 && frame.maxX <= width + 0.5)
            if width >= 520 {
                #expect(abs(frame.maxX - width) < 1)
            } else {
                #expect(abs(frame.minX) < 1)
            }
        }
    }

    @Test func automationTranslationsCoverEmptyStatesAndDynamicHistoryLabels() throws {
        let resource = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/Resources/zh-Hans.lproj/Localizable.strings")
        let values = try #require(PropertyListSerialization.propertyList(from: Data(contentsOf: resource), format: nil) as? [String: String])
        for key in ["All Automations", "History", "No Automations", "No matching Automations",
                    "Tasks in this category will appear here.", "Run History (%lld)",
                    "Every %lld seconds", "After %lld seconds", "Claimed", "Waiting to retry"] {
            let value = try #require(values[key])
            #expect(value != key)
        }
        #expect(AutomationPresentation.status("future-status") == "future-status")
        #expect(AutomationPresentation.trigger("future-trigger") == "future-trigger")
    }
}
