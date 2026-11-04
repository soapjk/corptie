import AppKit
import SwiftUI
import Testing
@testable import CorptieMac

@Suite(.serialized)
@MainActor
struct SceneLayoutTests {
    private final class ColumnState: ObservableObject {
        @Published var showsNavigation = true
    }
    private final class ProbeStorage {
        var view: NSView?
        var creations = 0
    }
    private struct ColumnProbe: NSViewRepresentable {
        let storage: ProbeStorage
        func makeNSView(context: Context) -> NSView {
            let view = NSView()
            storage.view = view; storage.creations += 1
            return view
        }
        func updateNSView(_ nsView: NSView, context: Context) {}
        func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSView, context: Context) -> CGSize? {
            CGSize(width: proposal.width ?? 100, height: proposal.height ?? 100)
        }
    }
    private struct ColumnsFixture: View {
        @ObservedObject var state: ColumnState
        let navigation: ProbeStorage
        let detail: ProbeStorage
        var body: some View {
            ScenePageColumns(showsNavigation: state.showsNavigation) {
                ColumnProbe(storage: navigation)
            } detail: { _ in
                ColumnProbe(storage: detail)
            }
        }
    }

    @Test func columnsFillTheTitledWindowAndKeepDetailIdentityAcrossResize() async throws {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.titlebarAppearsTransparent = true
        window.appearance = NSAppearance(named: .aqua)
        let state = ColumnState(), navigation = ProbeStorage(), detail = ProbeStorage()
        let host = NSHostingView(rootView: ColumnsFixture(state: state, navigation: navigation, detail: detail))
        window.contentView = host
        defer { window.contentView = nil; window.close() }
        for size in [NSSize(width: 1440, height: 900), NSSize(width: 1024, height: 768),
                     NSSize(width: 640, height: 420), NSSize(width: 820, height: 640), NSSize(width: 1440, height: 900)] {
            window.setContentSize(size)
            window.layoutIfNeeded(); host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(30))
            host.layoutSubtreeIfNeeded()
            let detailView = try #require(detail.view)
            let rect = detailView.convert(detailView.bounds, to: host)
            let topGap = host.isFlipped ? rect.minY - host.bounds.minY : host.bounds.maxY - rect.maxY
            let bottomGap = host.isFlipped ? host.bounds.maxY - rect.maxY : rect.minY - host.bounds.minY
            #expect(abs(topGap - MainWindowLayoutMetrics.titlebarHeight) < 1)
            #expect(abs(bottomGap) < 1, "Content must reach the bottom without a page-card gutter")
            #expect(abs(rect.maxX - host.bounds.maxX) < 1)
            if size.width >= 820 {
                let nav = try #require(navigation.view)
                let navRect = nav.convert(nav.bounds, to: host)
                #expect(abs(navRect.minX) < 1)
                #expect(abs(navRect.width - 284) < 1)
                #expect(abs(rect.minX - navRect.maxX) < 1)
                #expect(abs(navRect.height - rect.height) < 1)
            } else {
                #expect(abs(rect.minX) < 1)
                #expect(navigation.view?.window == nil)
            }
            #expect(detail.creations == 1, "Resizing must not recreate the detail host or its input state")
            try assertFullHeightBackground(host, hasNavigation: size.width >= 820)
        }
        state.showsNavigation = false
        try await Task.sleep(for: .milliseconds(30)); host.layoutSubtreeIfNeeded()
        let detailView = try #require(detail.view)
        #expect(abs(detailView.convert(detailView.bounds, to: host).minX) < 1)
        #expect(detail.creations == 1)
        try assertFullHeightBackground(host, hasNavigation: false)
    }

    private func assertFullHeightBackground(_ host: NSView, hasNavigation: Bool) throws {
        let image = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: image)
        let scale = CGFloat(image.pixelsWide) / host.bounds.width
        for x: CGFloat in [30, host.bounds.width - 30] {
            let top = try #require(image.colorAt(x: Int(x * scale), y: 2)?.usingColorSpace(.deviceRGB))
            let bottom = try #require(image.colorAt(x: Int(x * scale), y: image.pixelsHigh - 3)?.usingColorSpace(.deviceRGB))
            #expect(top.alphaComponent > 0.95 && bottom.alphaComponent > 0.95)
            #expect(abs(top.redComponent - bottom.redComponent) < 0.02)
        }
        if hasNavigation {
            let nav = try #require(image.colorAt(x: Int(30 * scale), y: image.pixelsHigh - 3)?.usingColorSpace(.deviceRGB))
            let main = try #require(image.colorAt(x: image.pixelsWide - Int(30 * scale), y: image.pixelsHigh - 3)?.usingColorSpace(.deviceRGB))
            #expect(main.redComponent - nav.redComponent > 0.005, "Sidebar and detail keep their console canvas roles")
        }
    }

    @Test func recordRowsFitNarrowAndWideHostsWithLongContent() throws {
        _ = NSApplication.shared
        let record = SceneRecord(instanceId: "scene:test", recordId: "record:test", recordType: "Measurement",
            data: [:], recordVersion: 1, archivedAt: nil, createdAt: "", updatedAt: "")
        let row = SceneRecordPresentation(record: record,
            title: String(repeating: "Long metric 指标 ", count: 10), value: "-1000000 " + String(repeating: "u", count: 32),
            metadata: "Nov 2, 2026 at 11:30 · Manual entry")
        for width: CGFloat in [280, 320, 420, 760] {
            let host = NSHostingView(rootView: SceneRecordRow(row: row, compact: width < 420,
                pending: false, disabled: false, toggle: {}).frame(width: width))
            host.frame = NSRect(x: 0, y: 0, width: width, height: 300)
            host.layoutSubtreeIfNeeded()
            #expect(host.fittingSize.width <= width + 1)
            #expect(host.fittingSize.height >= 60)
        }
    }

    @Test func creationSheetFitsNarrowHostsAndTranslationsAreComplete() throws {
        _ = NSApplication.shared
        let host = NSHostingView(rootView: SceneCreationSheet(draft: .init(templateId: "daily-checklist", name: ""),
            client: SceneAPIClient()) { _ in })
        for width: CGFloat in [320, 420, 480] {
            host.frame = NSRect(x: 0, y: 0, width: width, height: 400)
            host.layoutSubtreeIfNeeded()
            #expect(host.fittingSize.width <= 480.5)
        }
        let resources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources/CopetsMac/Resources")
        var keySets: [Set<String>] = []
        for language in ["en", "zh-Hans"] {
            let url = resources.appendingPathComponent("\(language).lproj/Scenes.strings")
            let dictionary = try #require(PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: String])
            #expect(dictionary.values.allSatisfy { !$0.isEmpty })
            keySets.append(Set(dictionary.keys))
        }
        #expect(keySets[0] == keySets[1])
    }
}
