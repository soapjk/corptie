import Foundation
import Testing
@testable import CorptieClientCore

struct ClientDetailPresentationV2Tests {
    let profile = ClientDetailPresentationCatalog.profile2
    var caps: [String] { ClientDetailPresentationCatalog.nativeCapabilities.sorted() }
    func fixture() throws -> ClientInspectorValue {
        let url = try #require(Bundle.module.url(forResource: "detail-v2-presentation", withExtension: "json", subdirectory: "Fixtures"))
        return try ClientDetailV2JSON.decode(Data(contentsOf: url))
    }
    func state(_ value: ClientInspectorValue) throws -> ClientDetailV2State {
        try ClientDetailV2JSON.validateEnvelope(value, commit: false)
        return try ClientDetailV2Catalog.decode(ClientDetailV2State.self, value)
    }
    func template(_ raw: ClientInspectorValue, card: ClientInspectorValue? = nil, catalog: String? = nil) throws -> ClientInspectorValue {
        var structure = raw.fields; structure.removeValue(forKey: "templateId")
        if let card { structure["card"] = card }
        if let catalog { structure["catalogProfile"] = .string(catalog) }
        structure["templateId"] = .string(try ClientDetailV2Catalog.templateID(structure: .object(structure)))
        return .object(structure)
    }
    @Test @MainActor func sharedGoldenCommitRetainsLocalMetadataAndUntouchedCard() throws {
        let f = try fixture(), before = try state(f["snapshot"]), expected = try state(f["expectedState"])
        let commit = try ClientDetailV2Catalog.decode(ClientDetailV2Commit.self, f["commit"])
        try before.validate(catalogProfile: profile, clientCapabilities: caps)
        let next = try before.applying(commit, catalogProfile: profile, clientCapabilities: caps)
        #expect(next == expected)
        let document = try before.renderingDocument(catalogProfile: profile, clientCapabilities: caps)
        let store = ClientDetailStore(); try store.apply(.snapshot(document))
        let a = store.orderedCards[0], b = store.orderedCards[1]
        a.expandedNodes.insert("section")
        #expect(a.card.v2Presentation?.render?.kind == .native)
        #expect(a.card.v2Presentation?.disclosures["section"]?.previewBinding == "preview")
        #expect(a.card.v2Presentation?.disclosures["section"]?.initiallyExpanded == false)
        #expect(a.card.v2Presentation?.components["manage"]?.presentationRole == "primary")
        #expect(a.card.v2Presentation?.components["resources"]?.itemBindings?["body"] == "body")
        try store.apply(.snapshot(next.renderingDocument(previous: before, document: document, catalogProfile: profile, clientCapabilities: caps)))
        #expect(store.orderedCards[0] === a && store.orderedCards[1] === b)
        #expect(a.expandedNodes.contains("section"))
        #expect(a.card.v2Presentation?.collections["resources"]?.revision == 2)
        #expect(b.card.v2Presentation?.collections["resources"]?.revision == 1)
        store.beginPresentation(scope: "another-authority")
        #expect(store.orderedCards.isEmpty)
    }
    @Test func strictPropsAndFrozenProfileRefuseNewMetadata() throws {
        let before = try state(fixture()["snapshot"]), raw = try #require(before.templates.values.first)
        let instance = try #require(before.instances["a"])
        for (nodeID, key, value) in [
            ("section", "initiallyExpanded", ClientInspectorValue.string("false")),
            ("section", "previewBinding", .string("absent")),
            ("section", "previewBinding", .string("webData")),
            ("manage", "presentationRole", .string("#ff0000")),
            ("resources", "presentation", .string("table")),
            ("resources", "itemBindings", .object(["preview": .string("preview"), "body": .string("absent")]))
        ] {
            var card = raw["card"].fields
            card["nodes"] = .array(raw["card"]["nodes"].items.map { node in
                guard node["id"].text == nodeID else { return node }
                var next = node.fields, props = node["props"].fields
                props[key] = value; next["props"] = .object(props); return .object(next)
            })
            let bad = try template(raw, card: .object(card))
            #expect(throws: (any Error).self) { try ClientDetailV2Catalog.validate(template: bad, instance: instance) }
        }
        let old = try template(raw, catalog: ClientDetailPresentationCatalog.profile1)
        #expect(throws: (any Error).self) { try ClientDetailV2Catalog.validate(template: old, instance: instance) }
        #expect(throws: (any Error).self) { try before.validate(catalogProfile: ClientDetailPresentationCatalog.profile1, clientCapabilities: caps) }
        #expect(throws: (any Error).self) { try before.renderingDocument(catalogProfile: profile, clientCapabilities: []) }
    }
    @Test func webDescriptorIsDataNotExecutableContentAndRequiresCapability() throws {
        let before = try state(fixture()["snapshot"]), raw = try #require(before.templates.values.first)
        let instance = try #require(before.instances["a"])
        let render: [String: ClientInspectorValue] = ["kind": .string("web"), "rendererId": .string("detail.test-card"),
            "rendererVersion": .number(1), "assetHash": .string("sha256:" + String(repeating: "a", count: 64)),
            "dataBinding": .string("webData"), "bridgeVersion": .number(1)]
        func web(_ descriptor: [String: ClientInspectorValue], required: Bool = true) throws -> ClientInspectorValue {
            var raw = raw.fields, card = raw["card"]!.fields
            card["render"] = .object(descriptor); raw["card"] = .object(card)
            if required { raw["requiredCapabilities"] = .array(raw["requiredCapabilities"]!.items + [.string("detail.web")]) }
            return try template(.object(raw))
        }
        let good = try web(render)
        try ClientDetailV2Catalog.validate(template: good, instance: instance)
        let presentation = try ClientDetailV2Catalog.presentation(template: good, instance: instance)
        #expect(presentation.render?.rendererId == "detail.test-card")
        for (key, value) in [("remoteURL", ClientInspectorValue.string("https://example.com")),
                             ("assetHash", .string("latest")), ("assetHash", .string("sha256:" + String(repeating: "a", count: 64) + "\n")),
                             ("dataBinding", .string("body")),
                             ("rendererVersion", .number(1.5)), ("bridgeVersion", .number(2))] {
            var bad = render; bad[key] = value
            #expect(throws: (any Error).self) { try ClientDetailV2Catalog.validate(template: web(bad), instance: instance) }
        }
        #expect(throws: (any Error).self) { try ClientDetailV2Catalog.validate(template: web(render, required: false), instance: instance) }
    }
    @Test func negotiationRegistersVersionsWithoutAdvertisingInstalledRenderers() throws {
        let new = try ClientDetailV2Negotiation.components(clientCapabilities: caps + ["detail.web"], catalog: profile)
        #expect(new.catalog == profile && new.clientCapabilities.last == "detail.web")
        #expect(try ClientDetailV2Negotiation.components(clientCapabilities: caps).catalog == ClientDetailPresentationCatalog.profile1)
        #expect(throws: (any Error).self) { try ClientDetailV2Negotiation.components(clientCapabilities: ["detail.web"]) }
        #expect(throws: (any Error).self) { try ClientDetailV2Negotiation.components(clientCapabilities: [], catalog: "unknown") }
    }
    @Test @MainActor func explicitCollapseAndResourceExpansionSurviveDataButNotGeneration() throws {
        let f = try fixture(), before = try state(f["snapshot"]), after = try state(f["expectedState"])
        let document = try before.renderingDocument(catalogProfile: profile, clientCapabilities: caps)
        let store = ClientDetailStore(); try store.apply(.snapshot(document))
        let card = store.orderedCards[0]
        #expect(card.isNodeExpanded("section", initiallyExpanded: true))
        card.setNodeExpanded("section", false)
        #expect(!card.isNodeExpanded("section", initiallyExpanded: true))
        card.setResourceExpanded(collection: "resources", id: "memory:1", true)
        #expect(card.isResourceExpanded(collection: "resources", id: "memory:1"))
        let updated = try after.renderingDocument(catalogProfile: profile, clientCapabilities: caps)
        try store.apply(.snapshot(updated))
        #expect(store.orderedCards[0] === card)
        #expect(!card.isNodeExpanded("section", initiallyExpanded: true))
        #expect(card.isResourceExpanded(collection: "resources", id: "memory:1"))
        card.setResourceExpanded(collection: "missing", id: "memory:1", true)
        #expect(!card.isResourceExpanded(collection: "missing", id: "memory:1"))
        let retired = ClientDetailDocument(schemaVersion: updated.schemaVersion, documentId: updated.documentId,
            sessionId: updated.sessionId, generation: "new-generation", revision: 1, cards: updated.cards, order: updated.order)
        try store.apply(.snapshot(retired))
        #expect(store.orderedCards[0] !== card)
        #expect(!store.orderedCards[0].isResourceExpanded(collection: "resources", id: "memory:1"))
        #expect(store.orderedCards[0].isNodeExpanded("section", initiallyExpanded: true))
    }
}
