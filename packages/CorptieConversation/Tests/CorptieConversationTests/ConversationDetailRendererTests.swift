import Foundation
import Testing
import SwiftUI
@testable import CorptieClientCore
@testable import CorptieConversation
#if os(macOS)
import AppKit
#endif

struct ConversationDetailRendererTests {
    @MainActor @Test func v2BridgeKeepsNativeCardLayoutAtPhonePadAndDesktopWidths() throws {
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("CorptieClientCore/Tests/CorptieClientCoreTests/Fixtures")
        struct Fixture: Decodable { let snapshot: ClientDetailV2State }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: directory.appendingPathComponent("detail-v2.json")))
        let legacy = ClientDetailStore(), modern = ClientDetailStore()
        try legacy.apply(.snapshot(ClientDetailDocument.decode(Data(contentsOf: directory.appendingPathComponent("detail-v1.json")))))
        try fixture.snapshot.validate()
        try modern.apply(.snapshot(fixture.snapshot.renderingDocument()))
        #if os(macOS)
        for width in [240.0, 375.0, 768.0] {
            func size(_ store: ClientDetailStore) -> NSSize {
                let view = NSHostingView(rootView: ConversationDetailRenderer(store: store).frame(width: width))
                view.frame = NSRect(x: 0, y: 0, width: width, height: 500)
                view.layoutSubtreeIfNeeded(); return view.fittingSize
            }
            let before = size(legacy), after = size(modern)
            #expect(abs(before.height - after.height) < 0.5)
            #expect(abs(before.width - after.width) < 0.5)
        }
        #endif
    }
    @MainActor @Test func sharedFixtureRendersAtDesktopAndPhoneWidths() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("CorptieClientCore/Tests/CorptieClientCoreTests/Fixtures/detail-v1.json")
        let store = ClientDetailStore()
        try store.apply(.snapshot(ClientDetailDocument.decode(Data(contentsOf: url))))
        #if os(macOS)
        for width in [240.0, 280.0, 375.0] {
            let view = NSHostingView(rootView: ConversationDetailRenderer(store: store).frame(width: width))
            view.frame = NSRect(x: 0, y: 0, width: width, height: 500)
            view.layoutSubtreeIfNeeded()
            #expect(view.fittingSize.height > 50)
            #expect(view.fittingSize.height < 250)
            #expect(abs(view.fittingSize.width - width) < 1)
        }
        #endif
    }
}
