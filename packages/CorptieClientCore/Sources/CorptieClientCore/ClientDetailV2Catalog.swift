import Foundation

public struct ClientDetailCollection: Codable, Equatable, Sendable {
    public let revision: Int
    public let order: [String]
    public let items: [String: [String: ClientInspectorValue]]
    public let nextCursor: String?
}

public struct ClientDetailComponent: Codable, Equatable, Sendable {
    public struct Option: Codable, Equatable, Sendable {
        public let value: String
        public let label: ClientDetailText
    }
    public struct Control: Codable, Equatable, Sendable {
        public let field: String
        public let kind: String
        public let label: ClientDetailText
        public let options: [Option]?
    }
    public let label: ClientDetailText?
    public let semantic: String?
    public let actionId: String?
    public let format: String?
    public let collection: String?
    public let controls: [Control]?
    public let presentationRole: String?
    public let presentation: String?
    public let itemBindings: [String: String]?
}

/// Presentation metadata is local only; it is never encoded as native-v1.
public struct ClientDetailV2Presentation: Equatable, Sendable {
    public let titleBinding: String?
    public let collections: [String: ClientDetailCollection]
    public let components: [String: ClientDetailComponent]
    public let dates: [String: Date]
    public let fieldLimits: [String: Int]
    public var render: ClientDetailRenderDescriptor? = nil
    public var disclosures: [String: ClientDetailDisclosurePresentation] = [:]
}

public enum ClientDetailV2Catalog {
    public static let profile = ClientDetailPresentationCatalog.profile1
    public static let componentKinds = ClientDetailPresentationCatalog.nativeCapabilities
    private static func fail() throws { throw ClientDetailV2Canonical.Failure.shape }
    static func decode<T: Decodable>(_ type: T.Type, _ value: ClientInspectorValue) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(value))
    }
    private static func keys(_ value: ClientInspectorValue, _ allowed: Set<String>, _ required: Set<String> = []) throws {
        try ClientDetailV2JSON.keys(value, allowed: allowed, required: required)
    }
    private static func token(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 512 && value.utf8.allSatisfy { (32...126).contains($0) }
    }
    private static func text(_ value: ClientInspectorValue) throws {
        try keys(value, ["fallback", "key", "parameters"], ["fallback"])
        let text = try decode(ClientDetailText.self, value)
        guard text.fallback.unicodeScalars.count <= 4096, (text.key?.unicodeScalars.count ?? 0) <= 256,
              (text.parameters?.count ?? 0) <= 16,
              text.parameters?.values.allSatisfy({ $0.unicodeScalars.count <= 1024 }) ?? true else { try fail(); return }
    }
    private static func wireKeys(_ value: ClientInspectorValue, depth: Int = 0) throws {
        guard depth <= 32 else { throw ClientDetailV2Canonical.Failure.depth }
        if case .object(let fields) = value {
            guard fields.keys.allSatisfy(token) else { try fail(); return }
            for child in fields.values { try wireKeys(child, depth: depth + 1) }
        } else if case .array(let values) = value {
            for child in values { try wireKeys(child, depth: depth + 1) }
        }
    }
    public static func templateID(structure: ClientInspectorValue) throws -> String {
        guard structure.fields["templateId"] == nil, let semantic = structure["card"]["semanticKind"].text,
              !semantic.isEmpty, semantic.utf8.count <= 64,
              semantic.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }) else { throw ClientDetailV2Canonical.Failure.shape }
        return "native:\(semantic):" + String(try ClientDetailV2Canonical.hash(structure).dropFirst(7))
    }

    /// Field maps are closed objects. Optional means absent, never arbitrary
    /// null, object or array. Schema and instance recursion share the wire cap.
    private static func fieldMap(_ schema: ClientInspectorValue, values: ClientInspectorValue, depth: Int) throws {
        guard case .object(let definitions) = schema, definitions.count <= 64,
              case .object(let fields) = values, Set(fields.keys).isSubset(of: Set(definitions.keys)), depth <= 32 else { try fail(); return }
        for (name, definition) in definitions {
            try field(definition, value: fields[name], depth: depth + 1)
        }
    }
    private static func field(_ schema: ClientInspectorValue, value: ClientInspectorValue?, depth: Int) throws {
        try keys(schema, ["type", "required", "maxLength", "properties", "items", "maxItems"], ["type", "required"])
        guard depth <= 32, case .bool(let required) = schema["required"], let type = schema["type"].text else { try fail(); return }
        let allowed: Set<String>
        switch type {
        case "string": allowed = ["type", "required", "maxLength"]
        case "integer", "bool": allowed = ["type", "required"]
        case "object": allowed = ["type", "required", "properties"]
        case "array": allowed = ["type", "required", "items", "maxItems"]
        default: try fail(); return
        }
        try keys(schema, allowed)
        if let limit = schema.fields["maxLength"] {
            guard let n = limit.number, n >= 1, n <= 65536, n.rounded() == n else { try fail(); return }
        }
        if type == "object" { try fieldMap(schema["properties"], values: .object([:]), depth: depth + 1, schemaOnly: true) }
        if type == "array" {
            guard let n = schema["maxItems"].number, (1...20).contains(n), n.rounded() == n else { try fail(); return }
            try field(schema["items"], value: nil, depth: depth + 1, schemaOnly: true)
        }
        guard let value else { if required { try fail() }; return }
        switch (type, value) {
        case ("string", .string(let text)):
            guard text.unicodeScalars.count <= Int(schema["maxLength"].number ?? 4096) else { try fail(); return }
        case ("bool", .bool): break
        case ("integer", .number(let n)):
            guard n.isFinite, n.rounded() == n, abs(n) <= Double(ClientDetailProtocol.maxRevision) else { try fail(); return }
        case ("object", .object): try fieldMap(schema["properties"], values: value, depth: depth + 1)
        case ("array", .array(let values)):
            guard values.count <= Int(schema["maxItems"].number!) else { try fail(); return }
            for item in values { try field(schema["items"], value: item, depth: depth + 1) }
        default: try fail()
        }
    }
    // Validate optional nested schemas even when their field is absent.
    private static func fieldMap(_ schema: ClientInspectorValue, values: ClientInspectorValue, depth: Int, schemaOnly: Bool) throws {
        guard case .object(let definitions) = schema, definitions.count <= 64, depth <= 32 else { try fail(); return }
        for definition in definitions.values { try field(definition, value: nil, depth: depth + 1, schemaOnly: true) }
    }
    private static func field(_ schema: ClientInspectorValue, value: ClientInspectorValue?, depth: Int, schemaOnly: Bool) throws {
        // A harmless synthetic value exercises the same shape checker, with
        // required suppressed only for schema validation, never instance data.
        var fields = schema.fields
        guard case .bool = fields["required"] else { try fail(); return }
        fields["required"] = .bool(false)
        try field(.object(fields), value: nil, depth: depth)
    }

    public static func validate(template: ClientInspectorValue, instance: ClientDetailV2State.Instance) throws {
        try wireKeys(template)
        try wireKeys(instance.body)
        try keys(template, ["templateId", "templateVersion", "catalogProfile", "requiredCapabilities", "fieldSchema", "collectionSchema", "card"],
            ["templateId", "templateVersion", "catalogProfile", "requiredCapabilities", "fieldSchema", "collectionSchema", "card"])
        var structure = template.fields; structure.removeValue(forKey: "templateId")
        guard let catalog = template["catalogProfile"].text,
              let registered = ClientDetailPresentationCatalog.capabilities(for: catalog),
              template["templateId"].text == (try templateID(structure: .object(structure))),
              let version = template["templateVersion"].number, version >= 1, version <= Double(ClientDetailProtocol.maxRevision), version.rounded() == version,
              case .array(let capabilities) = template["requiredCapabilities"] else { try fail(); return }
        let tokens = capabilities.compactMap(\.text)
        guard tokens.count == capabilities.count, tokens == tokens.sorted(), Set(tokens).count == tokens.count,
              Set(tokens).isSubset(of: registered), instance.collections.count <= 64 else { try fail(); return }
        try fieldMap(template["fieldSchema"], values: .object(instance.fields), depth: 0)
        let collectionSchema = template["collectionSchema"]
        guard case .object(let schemas) = collectionSchema, schemas.count <= 64,
              Set(instance.collections.keys).isSubset(of: Set(schemas.keys)) else { try fail(); return }
        for (name, schema) in schemas {
            try keys(schema, ["itemSchema", "maxItems"], ["itemSchema", "maxItems"])
            guard schema["maxItems"].number == 20 else { try fail(); return }
            try fieldMap(schema["itemSchema"], values: .object([:]), depth: 0, schemaOnly: true)
            guard let raw = instance.collections[name] else { continue }
            try keys(raw, ["revision", "order", "items", "nextCursor"], ["revision", "order", "items", "nextCursor"])
            let page = try decode(ClientDetailCollection.self, raw)
            guard (1...ClientDetailProtocol.maxRevision).contains(page.revision), page.order.count <= 20,
                  Set(page.order).count == page.order.count, Set(page.order) == Set(page.items.keys),
                  page.order.allSatisfy(token), page.nextCursor.map(token) ?? true else { try fail(); return }
            for item in page.items.values { try fieldMap(schema["itemSchema"], values: .object(item), depth: 0) }
        }
        let card = template["card"]
        let presentation = catalog == ClientDetailPresentationCatalog.profile2
        let renderKeys: Set<String> = presentation ? ["render"] : []
        try keys(card, Set(["title", "titleBinding", "semanticKind", "rootNodeId", "nodes", "fallback"]).union(renderKeys),
                 Set(["title", "semanticKind", "rootNodeId", "nodes", "fallback"]).union(renderKeys))
        if presentation {
            let render = card["render"]
            switch render["kind"].text {
            case "native": try keys(render, ["kind"], ["kind"])
            case "web":
                let names: Set<String> = ["kind", "rendererId", "rendererVersion", "assetHash", "dataBinding", "bridgeVersion"]
                try keys(render, names, names)
                guard tokens.contains("detail.web"), token(render["rendererId"].text ?? ""),
                      let version = render["rendererVersion"].number, version >= 1,
                      version <= Double(ClientDetailProtocol.maxRevision), version.rounded() == version,
                      render["assetHash"].text?.utf8.count == 71,
                      render["assetHash"].text?.range(of: #"^sha256:[0-9a-f]{64}$"#, options: .regularExpression) != nil,
                      render["bridgeVersion"] == .number(1), let binding = render["dataBinding"].text, token(binding),
                      template["fieldSchema"][binding]["type"].text == "object" else { try fail(); return }
            default: try fail()
            }
        }
        try text(card["title"]); try text(card["fallback"])
        if let binding = card.fields["titleBinding"] {
            guard let name = binding.text, template["fieldSchema"][name]["type"].text == "string" else { try fail(); return }
        }
        for node in card["nodes"].items {
            try keys(node, ["id", "kind", "props", "children", "binding"], ["id", "kind", "props", "children"])
            guard let kind = node["kind"].text, ClientDetailProtocol.componentKinds.contains(kind) || componentKinds.contains(kind) else { try fail(); return }
            if componentKinds.contains(kind) {
                guard tokens.contains(kind), node["children"].items.isEmpty else { try fail(); return }
                try validateComponent(node, template: template, instance: instance)
            } else {
                let disclosure = presentation && kind == "disclosure"
                try keys(node["props"], Set(["text", "label", "semantic", "actionId"]).union(disclosure ? ["previewBinding", "initiallyExpanded"] : []))
                for name in ["text", "label"] { if let label = node["props"].fields[name] { try text(label) } }
                if disclosure {
                    if let binding = node["props"].fields["previewBinding"] {
                        guard let name = binding.text, token(name), template["fieldSchema"][name]["type"].text == "string" else { try fail(); return }
                    }
                    if let expanded = node["props"].fields["initiallyExpanded"], case .bool = expanded {} else if node["props"].fields["initiallyExpanded"] != nil { try fail() }
                }
            }
        }
    }

    private static func validateComponent(_ node: ClientInspectorValue, template: ClientInspectorValue, instance: ClientDetailV2State.Instance) throws {
        let kind = node["kind"].text!, props = node["props"]
        let presentation = template["catalogProfile"].text == ClientDetailPresentationCatalog.profile2
        let allowed: Set<String>
        switch kind {
        case "detail.keyValue", "detail.image", "detail.progress": allowed = ["label"]
        case "detail.status": allowed = ["semantic"]
        case "detail.dateTime": allowed = ["format"]
        case "detail.resourceList": allowed = Set(["collection", "actionId"]).union(presentation ? ["presentation", "itemBindings", "presentationRole"] : [])
        case "detail.button": allowed = Set(["actionId"]).union(presentation ? ["presentationRole"] : [])
        case "detail.form": allowed = ["actionId", "controls"]
        default: allowed = []
        }
        try keys(props, allowed)
        let component = try decode(ClientDetailComponent.self, props)
        guard component.presentationRole.map({ ["primary", "link", "secondary", "destructive"].contains($0) }) ?? true else { try fail(); return }
        if let label = props.fields["label"] { try text(label) }
        if let action = component.actionId { guard instance.actions[action] != nil else { try fail(); return } }
        switch kind {
        case "detail.button":
            guard component.actionId != nil,
                  component.presentationRole.map({ ["primary", "link", "secondary", "destructive"].contains($0) }) ?? true else { try fail(); return }
        case "detail.resourceList":
            guard let name = component.collection, template["collectionSchema"].fields[name] != nil else { try fail(); return }
            guard component.presentation.map({ ["plain", "disclosure"].contains($0) }) ?? true else { try fail(); return }
            if component.presentation == "disclosure" {
                try keys(props["itemBindings"], ["preview", "body", "metadata"], ["preview", "body"])
                guard let bindings = component.itemBindings,
                      bindings.values.allSatisfy({ token($0) && template["collectionSchema"][name]["itemSchema"][$0]["type"].text == "string" }) else { try fail(); return }
            } else if props.fields["itemBindings"] != nil { try fail(); return }
            if let page = instance.collections[name] {
                for item in page["items"].fields.values {
                    guard token(item["resourceType"].text ?? ""), token(item["id"].text ?? ""), item["title"].text != nil,
                          item.fields["actionId"].map({ instance.actions[$0.text ?? ""] != nil }) ?? true else { try fail(); return }
                }
            }
        case "detail.form":
            guard component.actionId != nil, let controls = component.controls, controls.count <= 16,
                  Set(controls.map(\.field)).count == controls.count else { try fail(); return }
            for raw in props["controls"].items {
                try keys(raw, ["field", "kind", "label", "options"], ["field", "kind", "label"])
                try text(raw["label"])
                for option in raw["options"].items {
                    try keys(option, ["value", "label"], ["value", "label"])
                    try text(option["label"])
                }
            }
            for control in controls {
                let type = template["fieldSchema"][control.field]["type"].text
                guard control.label.fallback.unicodeScalars.count <= 4096 else { try fail(); return }
                switch control.kind {
                case "text": guard type == "string", control.options == nil else { try fail(); return }
                case "toggle": guard type == "bool", control.options == nil else { try fail(); return }
                case "picker":
                    guard type == "string", let options = control.options, (1...20).contains(options.count),
                          Set(options.map(\.value)).count == options.count,
                          options.allSatisfy({ token($0.value) && $0.label.fallback.unicodeScalars.count <= 4096 }),
                          instance.fields[control.field].map({ value in options.contains { $0.value == value.text } }) ?? true else { try fail(); return }
                default: try fail()
                }
            }
        default:
            guard let binding = node["binding"].text, !binding.contains("."), let schema = template["fieldSchema"].fields[binding] else { try fail(); return }
            let value = instance.fields[binding]
            switch kind {
            case "detail.image":
                guard schema["type"].text == "object" else { try fail(); return }
                if let value { guard token(value["resourceType"].text ?? ""), token(value["id"].text ?? "") else { try fail(); return } }
            case "detail.progress":
                guard schema["type"].text == "integer", value.map({ (0...100).contains($0.number ?? -1) }) ?? true else { try fail(); return }
            case "detail.dateTime":
                guard schema["type"].text == "string", ["date", "time", "dateTime"].contains(component.format ?? "dateTime") else { try fail(); return }
                if let value { guard date(value.text ?? "") != nil else { try fail(); return } }
            case "detail.status":
                guard schema["type"].text == "string", ["neutral", "failure", "warning", "success", "retrying", "scheduled"].contains(component.semantic ?? "neutral") else { try fail(); return }
            default: guard schema["type"].text == "string" else { try fail(); return }
            }
        }
    }
    public static func date(_ source: String) -> Date? {
        guard source.utf8.count <= 64, source.range(of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$"#, options: .regularExpression) != nil else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let value = formatter.date(from: source) { return value }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: source)
    }

    static func presentation(template: ClientInspectorValue, instance: ClientDetailV2State.Instance) throws -> ClientDetailV2Presentation {
        var result = ClientDetailV2Presentation(titleBinding: template["card"]["titleBinding"].text,
            collections: try instance.collections.mapValues { try decode(ClientDetailCollection.self, $0) },
            components: try Dictionary(uniqueKeysWithValues: template["card"]["nodes"].items.filter { componentKinds.contains($0["kind"].text ?? "") }.map {
                ( $0["id"].text!, try decode(ClientDetailComponent.self, $0["props"]) )
            }),
            dates: Dictionary(uniqueKeysWithValues: template["card"]["nodes"].items.filter { $0["kind"].text == "detail.dateTime" }.compactMap { node in
                guard let name = node["binding"].text, let source = instance.fields[name]?.text, let date = date(source) else { return nil }
                return (node["id"].text!, date)
            }),
            fieldLimits: template["fieldSchema"].fields.mapValues { Int($0["maxLength"].number ?? 4096) })
        if template["catalogProfile"].text == ClientDetailPresentationCatalog.profile2 {
            result.render = try decode(ClientDetailRenderDescriptor.self, template["card"]["render"])
            result.disclosures = try Dictionary(uniqueKeysWithValues: template["card"]["nodes"].items.filter { $0["kind"].text == "disclosure" }.map {
                ($0["id"].text!, try decode(ClientDetailDisclosurePresentation.self, $0["props"]))
            })
        }
        return result
    }

    /// Only after rich validation: adapt known extensions for the frozen graph.
    static func nativeDefinition(_ template: ClientInspectorValue) -> [String: ClientInspectorValue] {
        var definition = template["card"].fields
        guard template["catalogProfile"].text == ClientDetailPresentationCatalog.profile2 else { return definition }
        definition.removeValue(forKey: "render")
        definition["nodes"] = .array(template["card"]["nodes"].items.map { node in
            guard node["kind"].text == "disclosure" else { return node }
            var clean = node.fields, props = node["props"].fields
            props.removeValue(forKey: "previewBinding"); props.removeValue(forKey: "initiallyExpanded")
            clean["props"] = .object(props); return .object(clean)
        })
        return definition
    }
}
