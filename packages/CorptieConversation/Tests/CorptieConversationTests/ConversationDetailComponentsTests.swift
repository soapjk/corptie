import Foundation
import Testing
import SwiftUI
@testable import CorptieClientCore
@testable import CorptieConversation
#if os(macOS)
import AppKit
#endif

struct ConversationDetailComponentsTests {
    @MainActor @Test func actualBusinessDateStateRendersNativeWithBoundedPreparation() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("CorptieClientCore/Tests/CorptieClientCoreTests/Fixtures/detail-v2-business-dates.json")
        let f = try ClientDetailV2JSON.decode(Data(contentsOf: url))
        let profile = try #require(f["catalog"].text), caps = f["clientCapabilities"].items.compactMap(\.text)
        let state = try JSONDecoder().decode(ClientDetailV2State.self, from: JSONEncoder().encode(f["snapshot"]))
        try state.validate(catalogProfile: profile, clientCapabilities: caps)
        let document = try state.renderingDocument(catalogProfile: profile, clientCapabilities: caps)
        let store = ClientDetailStore(); try store.apply(.snapshot(document))
        let callbacks = ConversationDetailActions(canPerform: { _ in false }, perform: { _, _ in Issue.record("Read-only fixture cannot dispatch actions") })
        #expect(document.cards.count == 10)
        let prepared = document.cards.reduce(0) { $0 + ($1.v2Presentation?.dates.count ?? 0) }
        #expect(prepared > 0 && prepared < 80)
        for _ in 0..<20 {
            let reused = try state.renderingDocument(previous: state, document: document, catalogProfile: profile, clientCapabilities: caps)
            #expect(reused == document)
            #expect(reused.cards.reduce(0) { $0 + ($1.v2Presentation?.dates.count ?? 0) } == prepared)
        }
        #if os(macOS)
        for locale in ["en_US", "zh_CN", "fr_FR"] {
            for zone in ["UTC", "Asia/Shanghai", "America/Los_Angeles"] {
                for width in [240.0, 375.0, 768.0] {
                    let root = ConversationDetailRenderer(store: store, actions: callbacks)
                        .environment(\.locale, Locale(identifier: locale))
                        .environment(\.timeZone, try #require(TimeZone(identifier: zone)))
                        .frame(width: width)
                    let view = NSHostingView(rootView: root)
                    view.frame = NSRect(x: 0, y: 0, width: width, height: 800)
                    view.layoutSubtreeIfNeeded()
                    #expect(abs(view.fittingSize.width - width) < 1)
                    #expect(view.fittingSize.height.isFinite && view.fittingSize.height > 0 && view.fittingSize.height < 20000)
                }
            }
        }
        let card = try #require(store.orderedCards.first { $0.id == "business-schedules" })
        let absent = try #require(card.card.nodes.first { $0.kind == "detail.dateTime" && card.card.v2Presentation?.dates[$0.id] == nil })
        let component = try #require(card.card.v2Presentation?.components[absent.id])
        let empty = NSHostingView(rootView: ConversationDetailComponentView(state: card, node: absent, component: component, actions: callbacks, scope: "test:business"))
        empty.layoutSubtreeIfNeeded()
        #expect(empty.fittingSize.height == 0)
        #endif
    }
    @Test func dirtyDraftPreservesEditsAndReportsRevisionConflict() {
        var draft = ConversationDetailFormDraft()
        draft.receive(values: ["note": .string("Original")], resourceRevision: "r1")
        draft.edit("note", value: .string("Local edit"))
        draft.receive(values: ["note": .string("Remote edit")], resourceRevision: "r1")
        #expect(draft.values["note"] == .string("Local edit"))
        #expect(!draft.conflict)
        draft.receive(values: ["note": .string("Remote edit")], resourceRevision: "r2")
        #expect(draft.conflict)
        #expect(draft.resourceRevision == "r1")
        #expect(draft.values["note"] == .string("Local edit"))
        draft.reload(values: ["note": .string("Remote edit")], resourceRevision: "r2")
        #expect(!draft.conflict && !draft.dirty)
        #expect(draft.resourceRevision == "r2")
        #expect(draft.values["note"] == .string("Remote edit"))
    }
    @MainActor @Test func fullGoldenCatalogRendersAtPhonePadAndDesktopWidths() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("CorptieClientCore/Tests/CorptieClientCoreTests/Fixtures/detail-v2-components-state.json")
        let state = try JSONDecoder().decode(ClientDetailV2State.self, from: Data(contentsOf: url))
        try state.validate(catalogProfile: ClientDetailV2Catalog.profile, clientCapabilities: ClientDetailV2Catalog.componentKinds.sorted())
        let document = try state.renderingDocument(catalogProfile: ClientDetailV2Catalog.profile, clientCapabilities: ClientDetailV2Catalog.componentKinds.sorted())
        let store = ClientDetailStore(); try store.apply(.snapshot(document))
        #expect(store.orderedCards[0].card.displayTitle == "Shared components")
        #expect(store.orderedCards[0].card.v2Presentation?.components.count == 10)
        #expect(store.orderedCards[0].card.v2Presentation?.dates["date"] != nil)
        let callbacks = ConversationDetailActions(canPerform: { _ in false }, perform: { _, _ in Issue.record("Layout must not dispatch actions") },
            resolveImage: { target in
                #expect(target.resourceType == "artifact")
                #expect(target.id == "artifact:sample")
                return Data()
            })
        #if os(macOS)
        for width in [240.0, 375.0, 768.0] {
            let view = NSHostingView(rootView: ConversationDetailRenderer(store: store, actions: callbacks).frame(width: width))
            view.frame = NSRect(x: 0, y: 0, width: width, height: 800)
            view.layoutSubtreeIfNeeded()
            #expect(abs(view.fittingSize.width - width) < 1)
            #expect(view.fittingSize.height > 100)
            #expect(view.fittingSize.height < 1200)
        }
        #endif
    }
}
