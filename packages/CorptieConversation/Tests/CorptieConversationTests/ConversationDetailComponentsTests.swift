import Foundation
import Testing
import SwiftUI
@testable import CorptieClientCore
@testable import CorptieConversation
#if os(macOS)
import AppKit
#endif

struct ConversationDetailComponentsTests {
    @MainActor @Test func presentationV2UsesIndependentNativeDisclosureWithoutLayoutMeasurement() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("CorptieClientCore/Tests/CorptieClientCoreTests/Fixtures/detail-v2-presentation.json")
        let fixture = try ClientDetailV2JSON.decode(Data(contentsOf: url))
        let initial = try JSONDecoder().decode(ClientDetailV2State.self, from: JSONEncoder().encode(fixture["snapshot"]))
        let caps = fixture["profile"]["clientCapabilities"].items.compactMap(\.text)
        let profile = try #require(fixture["profile"]["catalog"].text)
        try initial.validate(catalogProfile: profile, clientCapabilities: caps)
        let store = ClientDetailStore()
        try store.apply(.snapshot(initial.renderingDocument(catalogProfile: profile, clientCapabilities: caps)))
        let first = store.orderedCards[0], second = store.orderedCards[1]
        first.setNodeExpanded("section", true)
        first.setResourceExpanded(collection: "resources", id: "memory:1", true)
        #expect(first.isNodeExpanded("section"))
        #expect(!second.isNodeExpanded("section"))
        #expect(!second.isResourceExpanded(collection: "resources", id: "memory:1"))
        let callbacks = ConversationDetailActions(canPerform: { _ in false }, perform: { _, _ in Issue.record("Rendering must not execute") })
        #if os(macOS)
        for width in [240.0, 375.0, 768.0] {
            let view = NSHostingView(rootView: ConversationDetailRenderer(store: store, actions: callbacks).frame(width: width))
            view.frame = NSRect(x: 0, y: 0, width: width, height: 800)
            view.layoutSubtreeIfNeeded()
            #expect(view.fittingSize.width <= width + 1)
            #expect(view.fittingSize.height.isFinite && view.fittingSize.height > 0)
            first.setNodeExpanded("section", false)
            first.setResourceExpanded(collection: "resources", id: "memory:1", false)
            view.layoutSubtreeIfNeeded()
            #expect(view.fittingSize.height.isFinite && view.fittingSize.height > 0)
        }
        #endif
    }
    @Test func editorInputPolicyKeepsMultilineMemoryAndRejectsUnsafeReferenceLocators() {
        #expect(ConversationDetailFormInputPolicy.isMultiline(operation: "memory.update", field: "content"))
        #expect(!ConversationDetailFormInputPolicy.isMultiline(operation: "reference.add", field: "locator"))
        #expect(!ConversationDetailFormInputPolicy.isMultiline(operation: "unregistered.operation", field: "content"))
        for value in ["https://example.invalid/path", "http://example.invalid/path?q=value"] {
            #expect(ConversationDetailFormInputPolicy.acceptsReferenceLocator(value))
        }
        for value in ["", "relative/path", "file:///private/document", "javascript:alert(1)",
                      "https://user:password@example.invalid/path", "https://example.invalid/" + String(repeating: "😀", count: 2048)] {
            #expect(!ConversationDetailFormInputPolicy.acceptsReferenceLocator(value))
        }
        let content = "First paragraph\n\n第二段\n" + String(repeating: "有界原生编辑器\n", count: 500)
        var draft = ConversationDetailFormDraft()
        draft.receive(values: ["content": .string(content)], resourceRevision: "before")
        draft.edit("content", value: .string(content + "Local change"))
        draft.receive(values: ["content": .string("Remote change")], resourceRevision: "after")
        #expect(draft.conflict && draft.values["content"] == .string(content + "Local change"))
    }
    @MainActor @Test func actualBusinessEditorAndPagedStateRenderWithoutLosingDirtyDrafts() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("CorptieClientCore/Tests/CorptieClientCoreTests/Fixtures/detail-v2-business-interactive.json")
        let fixture = try ClientDetailV2JSON.decode(Data(contentsOf: url))
        let caps = fixture["clientCapabilities"].items.compactMap(\.text), profile = try #require(fixture["catalog"].text)
        let initial = try JSONDecoder().decode(ClientDetailV2State.self, from: JSONEncoder().encode(fixture["snapshot"]))
        let expected = try JSONDecoder().decode(ClientDetailV2State.self, from: JSONEncoder().encode(fixture["expectedState"]))
        let document = try initial.renderingDocument(catalogProfile: profile, clientCapabilities: caps)
        let store = ClientDetailStore(); try store.apply(.snapshot(document))
        let callbacks = ConversationDetailActions(canPerform: { _ in false }, perform: { _, _ in Issue.record("Layout cannot dispatch commands") })
        var draft = ConversationDetailFormDraft()
        draft.receive(values: ["content": .string("Original content")], resourceRevision: "revision-1")
        draft.edit("content", value: .string("Unsaved local content"))
        let updated = try expected.renderingDocument(previous: initial, document: document, catalogProfile: profile, clientCapabilities: caps)
        try store.apply(.snapshot(updated))
        draft.receive(values: ["content": .string("Saved content")], resourceRevision: "revision-2")
        #expect(draft.conflict && draft.values["content"] == .string("Unsaved local content"))
        #expect(store.orderedCards.count == 3)
        #if os(macOS)
        for width in [240.0, 375.0, 768.0] {
            let view = NSHostingView(rootView: ConversationDetailRenderer(store: store, actions: callbacks).frame(width: width))
            view.frame = NSRect(x: 0, y: 0, width: width, height: 800); view.layoutSubtreeIfNeeded()
            #expect(abs(view.fittingSize.width - width) < 1)
            #expect(view.fittingSize.height.isFinite && view.fittingSize.height > 0 && view.fittingSize.height < 5000)
        }
        #endif
    }
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
