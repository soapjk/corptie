import AppKit
import SwiftUI
import Testing
@testable import CorptieMac

@Suite(.serialized)
@MainActor
struct SceneLayoutTests {
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
