import Foundation
import Testing
@testable import CorptieClientCore

struct ClientDetailV2CatalogTests {
    private let profile = ClientDetailV2Catalog.profile
    @Test func negotiationIsExplicitAndCheckedBeforeCachedRendering() throws {
        let state = try snapshot(), caps = ClientDetailV2Catalog.componentKinds.sorted()
        let document = try state.renderingDocument(catalogProfile: profile, clientCapabilities: caps)
        let commit = try ClientDetailV2Catalog.decode(ClientDetailV2Commit.self, syncFixture()["commit"])
        for invalid: [String]? in [nil, [], Array(caps.dropLast()), caps + ["detail.unknown"], caps + [caps[0]], Array(caps.reversed())] {
            #expect(throws: (any Error).self) { try state.validate(catalogProfile: profile, clientCapabilities: invalid) }
            #expect(throws: (any Error).self) { try state.renderingDocument(previous: state, document: document, catalogProfile: profile, clientCapabilities: invalid) }
            #expect(throws: (any Error).self) { try state.applying(commit, catalogProfile: profile, clientCapabilities: invalid) }
        }
        var mixed = state
        mixed.templates["unused"] = .object(["templateId": .string("legacy")])
        #expect(throws: (any Error).self) { try mixed.validate(catalogProfile: profile, clientCapabilities: caps) }
        #expect(throws: (any Error).self) { try mixed.renderingDocument(catalogProfile: profile, clientCapabilities: caps) }
        #expect(throws: (any Error).self) { try state.validate(clientCapabilities: caps) }
        var empty = state
        empty.templates = [:]; empty.instances = [:]
        empty.manifest = .init(revision: 1, hash: try ClientDetailV2Canonical.hash(.object(["cards": .object([:]), "order": .array([])])), cards: [:], order: [])
        empty.stateHash = try ClientDetailV2Canonical.hash(.object(["manifestHash": .string(empty.manifest.hash), "instances": .array([])]))
        try empty.validate(); try empty.validate(clientCapabilities: [])
        try empty.validate(catalogProfile: profile, clientCapabilities: [])
        #expect(throws: (any Error).self) { try empty.validate(catalogProfile: "unknown") }
        #expect(throws: (any Error).self) { try empty.renderingDocument(catalogProfile: "unknown") }
        #expect(throws: (any Error).self) { try empty.applying(commit, catalogProfile: "unknown") }
        #expect(throws: (any Error).self) { try empty.validate(catalogProfile: profile) }
    }
    private func fixture() throws -> ClientInspectorValue {
        try ClientDetailV2JSON.decode(Data(contentsOf: #require(Bundle.module.url(forResource: "detail-v2-components", withExtension: "json", subdirectory: "Fixtures"))))
    }
    private func syncFixture() throws -> ClientInspectorValue {
        try ClientDetailV2JSON.decode(Data(contentsOf: #require(Bundle.module.url(forResource: "detail-v2-components-sync", withExtension: "json", subdirectory: "Fixtures"))))
    }
    @Test func sharedTwoCardCommitGoldenAndSchemaCases() throws {
        let fixture = try syncFixture()
        let state = try ClientDetailV2Catalog.decode(ClientDetailV2State.self, fixture["snapshot"])
        let commit = try ClientDetailV2Catalog.decode(ClientDetailV2Commit.self, fixture["commit"])
        let expected = try ClientDetailV2Catalog.decode(ClientDetailV2State.self, fixture["expectedState"])
        try ClientDetailV2JSON.validateEnvelope(fixture["snapshot"], commit: false)
        try ClientDetailV2JSON.validateEnvelope(fixture["commit"], commit: true)
        #expect(try state.applying(commit, catalogProfile: profile, clientCapabilities: ClientDetailV2Catalog.componentKinds.sorted()) == expected)
        #expect(state.templates.count == 1 && state.instances.count == 2)
        let document = try state.renderingDocument(catalogProfile: profile, clientCapabilities: ClientDetailV2Catalog.componentKinds.sorted())
        #expect(document.cards.map(\.displayTitle) == ["Shared components", "Second instance"])
        let f = try self.fixture()
        for vector in fixture["schemaCases"].items {
            var structure = f["structure"].fields, schemas = f["structure"]["fieldSchema"].fields
            schemas["sample"] = vector["schema"]; structure["fieldSchema"] = .object(schemas)
            var body = f["instanceBody"].fields, values = body["fields"]!.fields
            values["sample"] = vector.fields["value"]; body["fields"] = .object(values)
            if vector["valid"] == .bool(true) {
                try ClientDetailV2Catalog.validate(template: template(.object(structure)), instance: instance(.object(body)))
            } else {
                #expect(throws: (any Error).self, "\(vector["name"].text ?? "schema case")") {
                    try ClientDetailV2Catalog.validate(template: template(.object(structure)), instance: instance(.object(body)))
                }
            }
        }
    }
    @Test func unchangedPageCannotAdvanceRevision() throws {
        let fixture = try syncFixture(), state = try ClientDetailV2Catalog.decode(ClientDetailV2State.self, fixture["snapshot"])
        var page = state.instances["a"]!.collections["resources"]!.fields
        page["revision"] = .number(2)
        var commit = fixture["commit"].fields, changes = commit["instanceChanges"]!.items, change = changes[0].fields
        var nextInstance = state.instances["a"]!
        nextInstance.collections["resources"] = .object(page); nextInstance.revision = 2
        nextInstance.hash = try ClientDetailV2Canonical.hash(nextInstance.body)
        change["resultHash"] = .string(nextInstance.hash)
        commit["resultStateHash"] = .string(try ClientDetailV2Canonical.hash(.object([
            "manifestHash": .string(state.manifest.hash), "instances": .array(state.manifest.order.map { id in
                let value = id == "a" ? nextInstance : state.instances[id]!
                return .object(["cardId": .string(id), "revision": .number(Double(value.revision)), "hash": .string(value.hash)])
            })])))
        change["collections"] = .object(["set": .object(["resources": .object(page)]), "remove": .array([])])
        changes[0] = .object(change); commit["instanceChanges"] = .array(changes)
        do {
            _ = try state.applying(ClientDetailV2Catalog.decode(ClientDetailV2Commit.self, .object(commit)), catalogProfile: profile, clientCapabilities: ClientDetailV2Catalog.componentKinds.sorted())
            Issue.record("Unchanged collection accepted a revision bump")
        } catch ClientDetailV2Canonical.Failure.base { }
        catch { Issue.record("Expected revision rejection, got \(error)") }
    }
    private func template(_ structure: ClientInspectorValue) throws -> ClientInspectorValue {
        var fields = structure.fields
        fields["templateId"] = .string(try ClientDetailV2Catalog.templateID(structure: structure))
        return .object(fields)
    }
    private func instance(_ body: ClientInspectorValue, revision: Int = 1) throws -> ClientDetailV2State.Instance {
        .init(revision: revision, hash: try ClientDetailV2Canonical.hash(body), fields: body["fields"].fields,
            collections: body["collections"].fields, actions: body["actions"].fields)
    }
    private func snapshot() throws -> ClientDetailV2State {
        let f = try fixture(), t = try template(f["structure"]), hash = try ClientDetailV2Canonical.hash(t), i = try instance(f["instanceBody"])
        let cards: [String: ClientDetailV2State.Reference] = ["a": .init(templateId: t["templateId"].text!, templateHash: hash),
            "b": .init(templateId: t["templateId"].text!, templateHash: hash)]
        let refs = try JSONDecoder().decode(ClientInspectorValue.self, from: JSONEncoder().encode(cards))
        let mh = try ClientDetailV2Canonical.hash(.object(["cards": refs, "order": .array([.string("a"), .string("b")])]))
        let sh = try ClientDetailV2Canonical.hash(.object(["manifestHash": .string(mh), "instances": .array(["a", "b"].map {
            .object(["cardId": .string($0), "revision": .number(1), "hash": .string(i.hash)])
        })]))
        return .init(protocolVersion: 2, documentId: "detail:sample", sessionId: "logical:sample", generation: "components:sample", revision: 1,
            stateHash: sh, manifest: .init(revision: 1, hash: mh, cards: cards, order: ["a", "b"]), templates: [hash: t], instances: ["a": i, "b": i])
    }
    @Test func nodeAndSwiftCanonicalGoldenHashesMatch() throws {
        let f = try fixture(), t = try template(f["structure"])
        #expect(try ClientDetailV2Canonical.hash(f["structure"]) == f["structureHash"].text)
        #expect(try ClientDetailV2Canonical.hash(t) == f["templateHash"].text)
        #expect(try ClientDetailV2Canonical.hash(f["instanceBody"]) == f["instanceHash"].text)
        #expect(try ClientDetailV2Catalog.templateID(structure: f["structure"]) == "native:information:991b93227939210bda77c649172191324892a6cc561ff20726c74d6b4f51d4ad")
    }
    @MainActor @Test func twoInstancesReuseTemplateAndKeepDynamicTitleOutOfStructure() throws {
        let state = try snapshot()
        try state.validate(catalogProfile: profile, clientCapabilities: ClientDetailV2Catalog.componentKinds.sorted())
        #expect(state.templates.count == 1)
        #expect(throws: (any Error).self) { try state.validate() }
        let document = try state.renderingDocument(catalogProfile: profile, clientCapabilities: ClientDetailV2Catalog.componentKinds.sorted())
        #expect(document.cards[0].displayTitle == "Shared components")
        #expect(document.cards[0].v2Presentation?.collections["resources"]?.order == ["artifact:sample"])
        let wire = try ClientDetailV2JSON.decode(JSONEncoder().encode(document.cards[0]))
        #expect(wire.fields["v2Presentation"] == nil)
        #expect(document.cards[0].title.fallback == "Detail")
    }
    @Test func rejectsMissingExtraNullAndUnconstrainedNestedFields() throws {
        let f = try fixture(), original = f["instanceBody"]
        for fields in [original["fields"].fields.filter { $0.key != "title" },
                       original["fields"].fields.merging(["unexpected": .bool(true)]) { _, new in new },
                       original["fields"].fields.merging(["title": .null]) { _, new in new },
                       original["fields"].fields.merging(["progress": .number(101)]) { _, new in new }] {
            var body = original.fields; body["fields"] = .object(fields)
            #expect(throws: (any Error).self) { try ClientDetailV2Catalog.validate(template: template(f["structure"]), instance: instance(.object(body))) }
        }
        var structure = f["structure"].fields, schemas = f["structure"]["fieldSchema"].fields
        schemas["image"] = .object(["type": .string("object"), "required": .bool(false)])
        structure["fieldSchema"] = .object(schemas)
        #expect(throws: (any Error).self) { try ClientDetailV2Catalog.validate(template: template(.object(structure)), instance: instance(original)) }
    }
    @Test func rejectsUnknownNodesCapabilitiesAndExecutableResources() throws {
        let f = try fixture()
        var s = f["structure"].fields, card = s["card"]!.fields, nodes = card["nodes"]!.items
        var node = nodes[1].fields; node["kind"] = .string("detail.html"); nodes[1] = .object(node)
        card["nodes"] = .array(nodes); s["card"] = .object(card)
        #expect(throws: (any Error).self) { try ClientDetailV2Catalog.validate(template: template(.object(s)), instance: instance(f["instanceBody"])) }
        s = f["structure"].fields; s["requiredCapabilities"] = .array([.string("detail.html")])
        #expect(throws: (any Error).self) { try ClientDetailV2Catalog.validate(template: template(.object(s)), instance: instance(f["instanceBody"])) }
        var body = f["instanceBody"].fields, fields = body["fields"]!.fields
        fields["image"] = .object(["resourceType": .string("artifact"), "id": .string("sample"), "url": .string("https://invalid.example/image")])
        body["fields"] = .object(fields)
        #expect(throws: (any Error).self) { try ClientDetailV2Catalog.validate(template: template(f["structure"]), instance: instance(.object(body))) }
    }
    @Test func collectionsRejectDuplicateWrongOrderOversizeAndCursor() throws {
        let f = try fixture(), body = f["instanceBody"]
        for (key, value) in [("order", ClientInspectorValue.array([.string("artifact:sample"), .string("artifact:sample")])),
                             ("order", .array([.string("missing")])), ("nextCursor", .string("")),
                             ("nextCursor", .string(String(repeating: "x", count: 513))), ("revision", .number(0))] {
            var page = body["collections"]["resources"].fields; page[key] = value
            var changed = body.fields; changed["collections"] = .object(["resources": .object(page)])
            #expect(throws: (any Error).self) { try ClientDetailV2Catalog.validate(template: template(f["structure"]), instance: instance(.object(changed))) }
        }
    }
    @MainActor @Test func collectionCommitIsAtomicRevisionCheckedAndIdempotent() throws {
        let state = try snapshot(), old = state.instances["a"]!
        var page = old.collections["resources"]!.fields; page["revision"] = .number(2); page["nextCursor"] = .null
        var replacement = old; replacement.collections["resources"] = .object(page); replacement.revision = 2
        replacement.hash = try ClientDetailV2Canonical.hash(replacement.body)
        let resultHash = try ClientDetailV2Canonical.hash(.object(["manifestHash": .string(state.manifest.hash), "instances": .array([
            .object(["cardId": .string("a"), "revision": .number(2), "hash": .string(replacement.hash)]),
            .object(["cardId": .string("b"), "revision": .number(1), "hash": .string(old.hash)])])]))
        func commit(_ delta: ClientDetailV2Commit.Delta) -> ClientDetailV2Commit {
            var change = ClientDetailV2Commit.Change(cardId: "a", replacement: nil, baseRevision: 1, revision: 2, baseHash: old.hash,
                resultHash: replacement.hash, fields: .init(set: [:], remove: []), actions: .init(set: [:], remove: []))
            change.collections = delta
            return .init(protocolVersion: 2, documentId: state.documentId, sessionId: state.sessionId, generation: state.generation,
                baseRevision: 1, revision: 2, baseStateHash: state.stateHash, resultStateHash: resultHash, templates: [:], manifestChange: nil,
                instanceChanges: [change], removeInstanceIds: [])
        }
        let good = commit(.init(set: ["resources": .object(page)], remove: []))
        let next = try state.applying(good, catalogProfile: profile, clientCapabilities: ClientDetailV2Catalog.componentKinds.sorted())
        #expect(next.instances["a"] == replacement)
        #expect(try next.applying(good, catalogProfile: profile, clientCapabilities: ClientDetailV2Catalog.componentKinds.sorted()) == next)
        #expect(state.instances["a"] == old)
        let document = try state.renderingDocument(catalogProfile: profile, clientCapabilities: ClientDetailV2Catalog.componentKinds.sorted())
        let store = ClientDetailStore(); try store.apply(.snapshot(document))
        let a = store.orderedCards[0], b = store.orderedCards[1]
        a.expandedNodes.insert("root")
        try store.apply(.snapshot(next.renderingDocument(previous: state, document: document, catalogProfile: profile, clientCapabilities: ClientDetailV2Catalog.componentKinds.sorted())))
        #expect(store.orderedCards[0] === a && store.orderedCards[1] === b)
        #expect(a.expandedNodes.contains("root"))
        #expect(a.card.v2Presentation?.collections["resources"]?.revision == 2)
        #expect(b.card.v2Presentation?.collections["resources"]?.revision == 1)
        for delta in [ClientDetailV2Commit.Delta(set: ["resources": .object(page)], remove: ["resources"]),
                      .init(set: [:], remove: ["resources", "resources"]), .init(set: [:], remove: ["missing"])] {
            #expect(throws: (any Error).self) { try delta.applying(old.collections) }
            #expect(throws: (any Error).self) { try state.applying(commit(delta), catalogProfile: profile, clientCapabilities: ClientDetailV2Catalog.componentKinds.sorted()) }
        }
        page["revision"] = .number(1)
        #expect(throws: (any Error).self) { try state.applying(commit(.init(set: ["resources": .object(page)], remove: [])), catalogProfile: profile, clientCapabilities: ClientDetailV2Catalog.componentKinds.sorted()) }
    }
    @Test func recursiveArraySchemaIsClosedBoundedAndRejectsNull() throws {
        let f = try fixture()
        var structure = f["structure"].fields, schema = f["structure"]["fieldSchema"].fields
        let item = ClientInspectorValue.object(["type": .string("object"), "required": .bool(true),
            "properties": .object(["name": .object(["type": .string("string"), "required": .bool(true), "maxLength": .number(8)])])])
        schema["tags"] = .object(["type": .string("array"), "required": .bool(false), "items": item, "maxItems": .number(2)])
        structure["fieldSchema"] = .object(schema)
        let t = try template(.object(structure))
        try ClientDetailV2Catalog.validate(template: t, instance: instance(f["instanceBody"]))
        let goodItem = ClientInspectorValue.object(["name": .string("tag")])
        var body = f["instanceBody"].fields, fields = body["fields"]!.fields
        for (value, valid) in [(ClientInspectorValue.array([goodItem]), true), (.null, false),
                               (.array([goodItem, goodItem, goodItem]), false),
                               (.array([.object(["name": .string("tag"), "extra": .bool(true)])]), false),
                               (.array([.object(["name": .string("too-long-name")])]), false)] {
            fields["tags"] = value; body["fields"] = .object(fields)
            if valid { try ClientDetailV2Catalog.validate(template: t, instance: instance(.object(body))) }
            else { #expect(throws: (any Error).self) { try ClientDetailV2Catalog.validate(template: t, instance: instance(.object(body))) } }
        }
    }
    @Test func datesRequireFullTimezoneAndRejectTrailingData() {
        #expect(ClientDetailV2Catalog.date("2026-10-11T21:00:00+08:00") != nil)
        #expect(ClientDetailV2Catalog.date("2026-10-11T13:00:00Z") != nil)
        for invalid in ["2026-10-11", "2026-10-11T13:00:00", "2026-10-11T13:00:00Z trailing"] { #expect(ClientDetailV2Catalog.date(invalid) == nil) }
    }
}
