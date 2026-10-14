import Foundation
import CryptoKit

/// Restricted canonical JSON used by native-v2; not a general JCS encoder.
/// Numbers must be safe integers. Business decimals are strings.
public enum ClientDetailV2Canonical {
    public enum Failure: Error { case number, depth, limit, hash, base, shape }
    public static func encode(_ value: ClientInspectorValue, depth: Int = 0) throws -> String {
        guard depth <= 32 else { throw Failure.depth }
        switch value {
        case .null: return "null"
        case .bool(let flag): return flag ? "true" : "false"
        case .number(let number):
            guard number.isFinite, number.rounded(.towardZero) == number,
                  abs(number) <= 9_007_199_254_740_991 else { throw Failure.number }
            return String(Int64(number))
        case .string(let string): return quoted(string)
        case .array(let items):
            return "[" + (try items.map { try encode($0, depth: depth + 1) }).joined(separator: ",") + "]"
        case .object(let fields):
            let keys = fields.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
            return "{" + (try keys.map { quoted($0) + ":" + (try encode(fields[$0]!, depth: depth + 1)) }).joined(separator: ",") + "}"
        }
    }
    private static func quoted(_ string: String) -> String {
        var result = "\""
        for scalar in string.unicodeScalars {
            switch scalar.value {
            case 34: result += "\\\""
            case 92: result += "\\\\"
            case 8: result += "\\b"
            case 9: result += "\\t"
            case 10: result += "\\n"
            case 12: result += "\\f"
            case 13: result += "\\r"
            case 0...31: result += String(format: "\\u%04x", scalar.value)
            default: result.unicodeScalars.append(scalar)
            }
        }
        return result + "\""
    }
    public static func hash(_ value: ClientInspectorValue) throws -> String {
        "sha256:" + SHA256.hash(data: Data(try encode(value).utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func bounded(_ value: ClientInspectorValue) throws {
        guard try encode(value).utf8.count <= 256 * 1024 else { throw Failure.limit }
    }
}

/// The v2 synchronization state is deliberately separate from the active v1
/// renderer and subscriptions until transport/catalog negotiation is ready.
public struct ClientDetailV2State: Codable, Equatable, Sendable {
    public struct Reference: Codable, Equatable, Sendable {
        public let templateId: String
        public let templateHash: String
    }
    public struct Manifest: Codable, Equatable, Sendable {
        public let revision: Int
        public let hash: String
        public let cards: [String: Reference]
        public let order: [String]
    }
    public struct Instance: Codable, Equatable, Sendable {
        public var revision: Int
        public var hash: String
        public var fields: [String: ClientInspectorValue]
        public var collections: [String: ClientInspectorValue]
        public var actions: [String: ClientInspectorValue]
        var body: ClientInspectorValue { .object(["fields": .object(fields), "collections": .object(collections), "actions": .object(actions)]) }
    }
    public let protocolVersion: Int
    public let documentId: String
    public let sessionId: String
    public let generation: String
    public var revision: Int
    public var stateHash: String
    public var manifest: Manifest
    public var templates: [String: ClientInspectorValue]
    public var instances: [String: Instance]

    private static func validRevision(_ value: Int) -> Bool { (1...ClientDetailProtocol.maxRevision).contains(value) }
    private static func validID(_ value: String) -> Bool { !value.isEmpty && value.unicodeScalars.count <= 512 }
    private static func json<T: Encodable>(_ value: T) throws -> ClientInspectorValue {
        try JSONDecoder().decode(ClientInspectorValue.self, from: JSONEncoder().encode(value))
    }
    private func validateNegotiation(catalogProfile: String, clientCapabilities: [String]?) throws {
        let capabilities = clientCapabilities ?? []
        let registered = ClientDetailPresentationCatalog.capabilities(for: catalogProfile)
        guard catalogProfile == "native-v2" || registered != nil,
              capabilities == capabilities.sorted(), Set(capabilities).count == capabilities.count,
              Set(capabilities).isSubset(of: registered ?? []),
              registered != nil ? clientCapabilities != nil : capabilities.isEmpty else {
            throw ClientDetailV2Canonical.Failure.shape
        }
        for template in templates.values {
            if registered != nil {
                guard template["catalogProfile"].text == catalogProfile,
                      case .array(let required) = template["requiredCapabilities"],
                      required.allSatisfy({ $0.text != nil }),
                      Set(required.compactMap(\.text)).isSubset(of: Set(capabilities)) else {
                    throw ClientDetailV2Canonical.Failure.shape
                }
            } else if template.fields["catalogProfile"] != nil {
                throw ClientDetailV2Canonical.Failure.shape
            }
        }
    }
    public func validate(catalogProfile: String = "native-v2", clientCapabilities: [String]? = nil) throws {
        typealias Failure = ClientDetailV2Canonical.Failure
        try validateNegotiation(catalogProfile: catalogProfile, clientCapabilities: clientCapabilities)
        try ClientDetailV2Canonical.bounded(Self.json(self))
        guard protocolVersion == 2, Self.validRevision(revision), Self.validRevision(manifest.revision),
              [documentId, sessionId, generation].allSatisfy(Self.validID), manifest.order.count <= 30,
              Set(manifest.order).count == manifest.order.count,
              Set(manifest.order) == Set(manifest.cards.keys), Set(manifest.order) == Set(instances.keys),
              templates.count <= 30 else { throw Failure.shape }
        let manifestBody = ClientInspectorValue.object(["cards": try Self.json(manifest.cards), "order": .array(manifest.order.map { .string($0) })])
        guard try ClientDetailV2Canonical.hash(manifestBody) == manifest.hash else { throw Failure.hash }
        for (hash, template) in templates {
            guard try ClientDetailV2Canonical.hash(template) == hash else { throw Failure.hash }
        }
        var nodeCount = 0
        for cardID in manifest.order {
            guard Self.validID(cardID), let reference = manifest.cards[cardID], Self.validID(reference.templateId),
                  let template = templates[reference.templateHash], template["templateId"].text == reference.templateId,
                  let instance = instances[cardID], Self.validRevision(instance.revision) else { throw Failure.shape }
            if ClientDetailPresentationCatalog.capabilities(for: template["catalogProfile"].text ?? "") != nil {
                guard template["catalogProfile"].text == catalogProfile else { throw Failure.shape }
                try ClientDetailV2Catalog.validate(template: template, instance: instance)
            } else {
                guard template.fields["catalogProfile"] == nil, instance.collections.isEmpty,
                      catalogProfile == "native-v2" else { throw Failure.shape }
            }
            nodeCount += template["card"]["nodes"].items.count
            guard nodeCount <= 500, instance.fields.count <= 64, instance.actions.count <= 32,
                  instance.actions.allSatisfy({ $0.key == $0.value["id"].text }) else { throw Failure.shape }
            guard try ClientDetailV2Canonical.hash(instance.body) == instance.hash else { throw Failure.hash }
            // Reuse the existing rooted native tree contract; do not enable new
            // rendering semantics without catalog negotiation.
            var card = ClientDetailV2Catalog.nativeDefinition(template)
            card["id"] = .string(cardID)
            card["templateRevision"] = template["templateVersion"]
            card["dataRevision"] = .string(instance.hash)
            card["data"] = .object(instance.fields)
            card["actions"] = .array(instance.actions.keys.sorted().map { instance.actions[$0]! })
            let document = ClientInspectorValue.object(["schemaVersion": .number(1), "documentId": .string(documentId),
                "sessionId": .string(sessionId), "generation": .string(generation), "revision": .number(Double(revision)),
                "order": .array([.string(cardID)]), "cards": .array([.object(card)])])
            _ = try ClientDetailDocument.decode(JSONEncoder().encode(document))
        }
        guard try calculatedStateHash() == stateHash else { throw Failure.hash }
    }
    private func calculatedStateHash() throws -> String {
        let index: [ClientInspectorValue] = instances.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }.map { cardID in
            .object(["cardId": .string(cardID), "revision": .number(Double(instances[cardID]!.revision)), "hash": .string(instances[cardID]!.hash)])
        }
        return try ClientDetailV2Canonical.hash(.object(["manifestHash": .string(manifest.hash), "instances": .array(index)]))
    }
    /// Adapt the validated native catalog into the existing shared renderer.
    /// Keep v2 and v1 generation namespaces distinct so a legacy fallback or
    /// refresh cannot create a same-revision/different-data-stamp conflict.
    public func renderingDocument(previous: Self? = nil, document: ClientDetailDocument? = nil, catalogProfile: String = "native-v2", clientCapabilities: [String]? = nil) throws -> ClientDetailDocument {
        // Check even reused cards: a reduced negotiation cannot reuse unsupported UI.
        try validateNegotiation(catalogProfile: catalogProfile, clientCapabilities: clientCapabilities)
        let renderGeneration = "v2:" + (try ClientDetailV2Canonical.hash(.string(catalogProfile == "native-v2" ? generation : catalogProfile + ":" + generation)))
        let oldCards = Dictionary(uniqueKeysWithValues: (document?.cards ?? []).map { ($0.id, $0) })
        let cards = try manifest.order.map { cardID -> ClientDetailCard in
            guard let reference = manifest.cards[cardID], let instance = instances[cardID], let template = templates[reference.templateHash] else { throw ClientDetailV2Canonical.Failure.shape }
            guard template.fields["catalogProfile"] == nil || (ClientDetailPresentationCatalog.capabilities(for: catalogProfile) != nil && template["catalogProfile"].text == catalogProfile) else { throw ClientDetailV2Canonical.Failure.shape }
            if previous?.generation == generation, previous?.documentId == documentId,
               document?.generation == renderGeneration,
               previous?.instances[cardID] == instance, previous?.manifest.cards[cardID] == reference,
               let old = oldCards[cardID] { return old }
            var definition = ClientDetailV2Catalog.nativeDefinition(template)
            definition["id"] = .string(cardID); definition["templateRevision"] = template["templateVersion"]
            definition["dataRevision"] = .string(instance.hash); definition["data"] = .object(instance.fields)
            definition["actions"] = .array(instance.actions.keys.sorted().map { instance.actions[$0]! })
            var card = try JSONDecoder().decode(ClientDetailCard.self, from: JSONEncoder().encode(ClientInspectorValue.object(definition)))
            if ClientDetailPresentationCatalog.capabilities(for: template["catalogProfile"].text ?? "") != nil {
                try ClientDetailV2Catalog.validate(template: template, instance: instance)
                card.v2Presentation = try ClientDetailV2Catalog.presentation(template: template, instance: instance)
            }
            return card
        }
        let result = ClientDetailDocument(schemaVersion: 1, documentId: documentId, sessionId: sessionId,
            generation: renderGeneration, revision: revision, cards: cards, order: manifest.order)
        try result.validate()
        return result
    }
    public func applying(_ commit: ClientDetailV2Commit, catalogProfile: String = "native-v2", clientCapabilities: [String]? = nil) throws -> Self {
        typealias Failure = ClientDetailV2Canonical.Failure
        try validate(catalogProfile: catalogProfile, clientCapabilities: clientCapabilities); try ClientDetailV2Canonical.bounded(Self.json(commit))
        guard commit.protocolVersion == 2, commit.documentId == documentId, commit.sessionId == sessionId,
              commit.generation == generation else { throw Failure.base }
        if commit.revision == revision && commit.resultStateHash == stateHash { return self }
        guard commit.baseRevision == revision, commit.baseStateHash == stateHash,
              Self.validRevision(commit.revision), commit.revision > revision else { throw Failure.base }
        var next = self, touched = Set<String>()
        for cardID in commit.removeInstanceIds {
            guard Self.validID(cardID), touched.insert(cardID).inserted,
                  next.instances.removeValue(forKey: cardID) != nil else { throw Failure.shape }
        }
        for change in commit.instanceChanges {
            guard Self.validID(change.cardId), touched.insert(change.cardId).inserted else { throw Failure.shape }
            if let replacement = change.replacement {
                guard next.instances[change.cardId] == nil else { throw Failure.shape }
                next.instances[change.cardId] = replacement
            } else {
                guard var instance = next.instances[change.cardId], change.baseRevision == instance.revision,
                      change.baseHash == instance.hash, let targetRevision = change.revision,
                      Self.validRevision(targetRevision), targetRevision > instance.revision,
                      let hash = change.resultHash, let fields = change.fields, let actions = change.actions else { throw Failure.base }
                instance.fields = try fields.applying(instance.fields)
                instance.actions = try actions.applying(instance.actions)
                if let collections = change.collections {
                    let pages = try collections.applying(instance.collections)
                    for (name, page) in pages {
                        if let old = instance.collections[name] {
                            var content = page.fields, oldContent = old.fields
                            content.removeValue(forKey: "revision"); oldContent.removeValue(forKey: "revision")
                            guard let nextRevision = page["revision"].number, let oldRevision = old["revision"].number,
                                  content == oldContent ? nextRevision == oldRevision : nextRevision > oldRevision else { throw Failure.base }
                        }
                    }
                    instance.collections = pages
                }
                instance.revision = targetRevision; instance.hash = hash
                next.instances[change.cardId] = instance
            }
        }
        if let manifest = commit.manifestChange {
            guard manifest.revision > next.manifest.revision else { throw Failure.base }
            next.manifest = manifest
        }
        next.templates.merge(commit.templates) { _, new in new }
        let referenced = Set(next.manifest.cards.values.map(\.templateHash))
        next.templates = next.templates.filter { referenced.contains($0.key) }
        next.revision = commit.revision; next.stateHash = commit.resultStateHash
        try next.validate(catalogProfile: catalogProfile, clientCapabilities: clientCapabilities)
        return next
    }
}

public struct ClientDetailV2Commit: Codable, Equatable, Sendable {
    public struct Delta: Codable, Equatable, Sendable {
        public let set: [String: ClientInspectorValue]
        public let remove: [String]
        func applying(_ fields: [String: ClientInspectorValue]) throws -> [String: ClientInspectorValue] {
            guard Set(remove).count == remove.count, remove.allSatisfy({ fields[$0] != nil && set[$0] == nil }) else { throw ClientDetailV2Canonical.Failure.shape }
            var next = fields; next.merge(set) { _, new in new }; for key in remove { next.removeValue(forKey: key) }; return next
        }
    }
    public struct Change: Codable, Equatable, Sendable {
        public let cardId: String
        public let replacement: ClientDetailV2State.Instance?
        public let baseRevision: Int?
        public let revision: Int?
        public let baseHash: String?
        public let resultHash: String?
        public let fields: Delta?
        public let actions: Delta?
        public var collections: Delta? = nil
    }
    public let protocolVersion: Int
    public let documentId: String
    public let sessionId: String
    public let generation: String
    public let baseRevision: Int
    public let revision: Int
    public let baseStateHash: String
    public let resultStateHash: String
    public let templates: [String: ClientInspectorValue]
    public let manifestChange: ClientDetailV2State.Manifest?
    public let instanceChanges: [Change]
    public let removeInstanceIds: [String]
}
