import Foundation

enum SceneJSONValue: Codable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: SceneJSONValue])
    case array([SceneJSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: SceneJSONValue].self) { self = .object(value) }
        else { self = .array(try container.decode([SceneJSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .bool(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var stringValue: String? { if case let .string(value) = self { value } else { nil } }
    var numberValue: Double? { if case let .number(value) = self { value } else { nil } }
    var boolValue: Bool? { if case let .bool(value) = self { value } else { nil } }
}

struct SceneTemplateSummary: Codable, Identifiable, Hashable {
    let templateId: String
    let version: Int
    let title: String
    let description: String
    var id: String { "\(templateId):\(version)" }
}

struct SceneInstance: Codable, Identifiable, Hashable {
    let instanceId: String
    let templateId: String
    let templateVersion: Int
    let name: String
    let timezone: String
    let status: String
    let instanceRevision: Int
    let resourceVersion: Int
    let createdAt: String
    let updatedAt: String
    var id: String { instanceId }
}

struct SceneRecord: Codable, Identifiable, Equatable {
    let instanceId: String
    let recordId: String
    let recordType: String
    let data: [String: SceneJSONValue]
    let recordVersion: Int
    let archivedAt: String?
    let createdAt: String
    let updatedAt: String
    var id: String { recordId }
}

struct SceneViewDefinition: Codable, Equatable {
    let viewId: String
    let title: String
    let kind: String
    let recordTypes: [String]
}

struct SceneViewResponse: Codable {
    let scene: SceneInstance
    let view: SceneViewDefinition
    let records: [SceneRecord]
    let nextOffset: Int?
}

struct SceneMutationReceipt: Codable {
    let mutationId: String
    let instanceId: String
    let instanceRevision: Int
    let summary: String
}

struct CreateSceneDraft: Identifiable {
    let id = UUID()
    var templateId: String
    var name: String
    var timezone: String = TimeZone.current.identifier
}
