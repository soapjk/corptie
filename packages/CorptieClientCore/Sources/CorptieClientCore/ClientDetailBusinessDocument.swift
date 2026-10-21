import Foundation

public struct ClientDetailBusinessDocument: Decodable, Equatable, Sendable {
    public static let profile = "native-business-v1"
    public let protocolVersion: Int
    public let catalog: String
    public let documentId: String
    public let sessionId: String
    public let generation: String
    public let revision: String
    public let cards: [ClientDetailBusinessCard]
    public let order: [String]
    public var orderedCards: [ClientDetailBusinessCard] { order.compactMap { id in cards.first { $0.id == id } } }
    public static func decode(_ data: Data) throws -> Self {
        guard data.count <= ClientDetailProtocol.maxDocumentBytes else { throw ClientDetailFailure.limit }
        _ = try ClientDetailV2JSON.decode(data)
        let document = try JSONDecoder().decode(Self.self, from: data)
        guard document.protocolVersion == 1, document.catalog == profile,
              !document.sessionId.isEmpty, !document.generation.isEmpty,
              document.cards.count <= 32, Set(document.cards.map(\.id)).count == document.cards.count,
              Set(document.order) == Set(document.cards.map(\.id)), document.order.count == document.cards.count else {
            throw ClientDetailFailure.invalidGraph
        }
        for card in document.cards { try card.validate() }
        return document
    }
}

public struct ClientDetailBusinessTask: Decodable, Equatable, Sendable {
    public let taskId: String
    public let title: String
    public let status: String
    public let description: String
    public let acceptanceCriteria: String
    public let verificationCriteria: String
    public let resourceRevision: String
    public let summary: ClientDetailBusinessTaskSummary
    public var parentTaskId: String? = nil
    public var parentSessionId: String? = nil
    public var hierarchy: TaskHierarchySummary? = nil
}
public struct ClientDetailBusinessArtifact: Decodable, Equatable, Identifiable, Sendable {
    public var id: String { artifactId }
    public let artifactId: String
    public let title: String
    public let summary: String
    public let version: Int?
    public let contentHash: String
    public let readAvailable: Bool
}
public struct ClientDetailBusinessArtifacts: Decodable, Equatable, Sendable {
    public let items: [ClientDetailBusinessArtifact]
    public let hasMore: Bool
}
public struct ClientDetailBusinessCard: Decodable, Equatable, Identifiable, Sendable {
    public enum Payload: Equatable, Sendable {
        case task(ClientDetailBusinessTask), artifacts(ClientDetailBusinessArtifacts), unsupported
        case session(ClientDetailBusinessSession), summary(ClientDetailBusinessSummary), work(ClientDetailBusinessWork)
        case focus(ClientDetailBusinessList<ClientDetailBusinessFocus>), references(ClientDetailBusinessList<ClientDetailBusinessReference>)
        case memories(ClientDetailBusinessList<ClientDetailBusinessMemory>), hits(ClientDetailBusinessList<ClientDetailBusinessMemory>)
        case schedules(ClientDetailBusinessList<ClientDetailBusinessSchedule>), provider(ClientDetailBusinessProvider)
        case worktree(ClientDetailBusinessWorktree), turn(ClientDetailBusinessTurn)
    }
    public let id: String
    public let kind: String
    public let version: Int
    public let revision: String
    public let loadState: String
    public let payload: Payload
    public let actions: [ClientDetailAction]
    public let nextCursor: String?
    private enum CodingKeys: String, CodingKey { case id, kind, version, revision, loadState, data, actions, nextCursor }
    public init(from decoder: Decoder) throws {
        let value = try decoder.container(keyedBy: CodingKeys.self)
        id = try value.decode(String.self, forKey: .id); kind = try value.decode(String.self, forKey: .kind)
        version = try value.decode(Int.self, forKey: .version); revision = try value.decode(String.self, forKey: .revision)
        loadState = try value.decode(String.self, forKey: .loadState)
        nextCursor = try value.decodeIfPresent(String.self, forKey: .nextCursor)
        if version == 1 && kind == "taskInfo" {
            payload = .task(try value.decode(ClientDetailBusinessTask.self, forKey: .data))
            actions = try value.decode([ClientDetailAction].self, forKey: .actions)
        } else if version == 1 && kind == "artifacts" {
            payload = .artifacts(try value.decode(ClientDetailBusinessArtifacts.self, forKey: .data))
            actions = try value.decode([ClientDetailAction].self, forKey: .actions)
        } else if version == 1 {
            switch kind {
            case "sessionInfo": payload = .session(try value.decode(ClientDetailBusinessSession.self, forKey: .data))
            case "chatSummary": payload = .summary(try value.decode(ClientDetailBusinessSummary.self, forKey: .data))
            case "workOverview": payload = .work(try value.decode(ClientDetailBusinessWork.self, forKey: .data))
            case "focusTasks": payload = .focus(try value.decode(ClientDetailBusinessList<ClientDetailBusinessFocus>.self, forKey: .data))
            case "contextReferences": payload = .references(try value.decode(ClientDetailBusinessList<ClientDetailBusinessReference>.self, forKey: .data))
            case "memoryResources": payload = .memories(try value.decode(ClientDetailBusinessList<ClientDetailBusinessMemory>.self, forKey: .data))
            case "memoryHits": payload = .hits(try value.decode(ClientDetailBusinessList<ClientDetailBusinessMemory>.self, forKey: .data))
            case "schedules": payload = .schedules(try value.decode(ClientDetailBusinessList<ClientDetailBusinessSchedule>.self, forKey: .data))
            case "provider": payload = .provider(try value.decode(ClientDetailBusinessProvider.self, forKey: .data))
            case "worktree": payload = .worktree(try value.decode(ClientDetailBusinessWorktree.self, forKey: .data))
            case "turnMetrics": payload = .turn(try value.decode(ClientDetailBusinessTurn.self, forKey: .data))
            default: payload = .unsupported
            }
            if case .unsupported = payload { actions = [] } else { actions = try value.decode([ClientDetailAction].self, forKey: .actions) }
        } else { payload = .unsupported; actions = [] }
    }
    func validate() throws {
        func validText(_ value: String, maximum: Int = 65536) -> Bool { value.count <= maximum }
        guard !id.isEmpty, id.count <= 128, !revision.isEmpty, ["ready", "empty", "error"].contains(loadState),
              actions.count <= 64, Set(actions.map(\.id)).count == actions.count,
              nextCursor.map({ !$0.isEmpty && $0.count <= 512 }) ?? true else { throw ClientDetailFailure.invalidGraph }
        for action in actions {
            guard !action.id.isEmpty, action.id.count <= 128, action.target?.id.isEmpty == false,
                (action.target?.id.count ?? 1000) <= 512,
                action.kind == "navigation" && ["resource.open", "editor.open"].contains(action.operation)
                || action.kind == "read" && ["detail.collection.page", "artifact.content"].contains(action.operation)
                || action.kind == "command" && ["memory.update", "memory.delete", "reference.add", "reference.remove", "schedule.cancel"].contains(action.operation)
            else { throw ClientDetailFailure.invalidGraph }
        }
        switch payload {
        case .task(let task):
            guard !task.taskId.isEmpty, [task.title, task.status, task.description, task.acceptanceCriteria,
                task.verificationCriteria, task.resourceRevision].allSatisfy({ validText($0) }),
                actions.filter({ $0.kind == "navigation" }).allSatisfy({ action in
                    (action.operation == "editor.open" && action.target?.resourceType == "task" && action.target?.id == task.taskId)
                    || (action.operation == "resource.open" && action.target?.resourceType == "session"
                        && task.parentTaskId != nil && task.parentSessionId?.isEmpty == false
                        && action.target?.id == task.parentSessionId)
                }) else { throw ClientDetailFailure.invalidGraph }
        case .artifacts(let list):
            guard list.items.count <= 20, Set(list.items.map(\.id)).count == list.items.count else { throw ClientDetailFailure.limit }
            for row in list.items {
                guard !row.id.isEmpty, validText(row.title), validText(row.summary),
                      !row.readAvailable || (row.version.map { $0 > 0 } == true && row.contentHash.count == 64
                        && row.contentHash.allSatisfy({ "0123456789abcdef".contains($0) })) else { throw ClientDetailFailure.invalidGraph }
            }
            guard actions.filter({ $0.kind == "navigation" }).allSatisfy({ action in action.operation == "resource.open"
                && action.target?.resourceType == "artifact" && list.items.contains { $0.id == action.target?.id && $0.readAvailable } }) else {
                throw ClientDetailFailure.invalidGraph
            }
        case .focus(let list): try validateRows(list.items.map(\.id))
        case .references(let list): try validateRows(list.items.map(\.id))
        case .memories(let list), .hits(let list):
            try validateRows(list.items.map(\.id))
            guard list.items.allSatisfy({ validText($0.content) }) else { throw ClientDetailFailure.limit }
        case .schedules(let list): try validateRows(list.items.map(\.id))
        case .provider(let value): try validateRows(value.providers.map(\.id))
        case .turn(let value):
            guard [value.wall, value.wallPartition, value.inclusive].allSatisfy({ $0.count <= 20 && $0.values.allSatisfy({ Double($0).map { $0.isFinite && $0 >= 0 } == true }) }) else { throw ClientDetailFailure.invalidGraph }
        case .session, .summary, .work, .worktree, .unsupported: break
        }
    }
    private func validateRows(_ ids: [String]) throws {
        guard ids.count <= 20, Set(ids).count == ids.count, ids.allSatisfy({ !$0.isEmpty && $0.count <= 512 }) else { throw ClientDetailFailure.limit }
    }
    init(id: String, kind: String, version: Int, revision: String, loadState: String, payload: Payload, actions: [ClientDetailAction], nextCursor: String?) {
        self.id = id; self.kind = kind; self.version = version; self.revision = revision; self.loadState = loadState
        self.payload = payload; self.actions = actions; self.nextCursor = nextCursor
    }
    var estimatedRetainedBytes: Int {
        func texts(_ values: [String]) -> Int { values.reduce(0) { $0 + $1.utf8.count * 2 } }
        let base = 2048 + actions.count * 2048
        switch payload {
        case .task(let value): return base + texts([value.title, value.description, value.acceptanceCriteria, value.verificationCriteria, value.summary.focus, value.summary.progress, value.summary.reason, value.summary.nextAction])
        case .session(let value): return base + texts([value.sessionId, value.workName])
        case .summary(let value): return base + texts([value.text])
        case .work(let value): return base + texts([value.name, value.description])
        case .artifacts(let list): return base + list.items.reduce(0) { $0 + 2048 + texts([$1.title, $1.summary]) }
        case .memories(let list), .hits(let list): return base + list.items.reduce(0) { $0 + 2048 + texts([$1.content]) }
        case .references(let list): return base + list.items.reduce(0) { $0 + 2048 + texts([$1.title]) }
        case .focus(let list): return base + list.items.reduce(0) { $0 + 2048 + texts([$1.title, $1.summary.focus, $1.summary.progress, $1.summary.reason, $1.summary.nextAction]) }
        case .schedules(let list): return base + list.items.reduce(0) { $0 + 2048 + texts([$1.name]) }
        case .provider(let value): return base + value.providers.count * 4096 + texts([value.name, value.model, value.reasoning])
        case .worktree, .turn, .unsupported: return base + 16 * 1024
        }
    }
}
