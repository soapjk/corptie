import Foundation
import Observation
import CorptieClientCore

struct PendingCommand: Codable {
    let requestID: String
    let sessionID: String
    let kind: String
    let serverID: String
    let address: String
}

@MainActor @Observable
final class PadWorkspace {
    var works: [ClientWork] = []
    var tasks: [ClientTask] = []
    var sessions: [ClientSession] = []
    var tasksByWork: [String: [ClientTask]] = [:]
    var discussionsByWork: [String: [ClientSession]] = [:]
    var sessionsByID: [String: ClientSession] = [:]
    var workCursor: String?
    var taskCursor: String?
    var sessionCursor: String?
    var selection: String? {
        didSet { if oldValue != selection { clearSelectionState() } }
    }
    var messages: [ClientMessage] = []
    var before: String?
    var capabilities: ClientSessionCapabilities?
    var drafts: [String: String] = [:]
    var status = ""
    var liveStatus = "正在连接实时更新"
    var messageRevision = 0
    var controlRevision = 0
    var scrollRequest = 0
    var timelineGeneration = 0
    var inventoryGeneration = 0
    var realtimeGeneration: UUID?
    var inventoryDirty = false
    var messagesDirty = false
    var refreshWorker: Task<Void, Never>?
    var pending: PendingCommand?
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        pending = defaults.data(forKey: "pendingCommand").flatMap { try? JSONDecoder().decode(PendingCommand.self, from: $0) }
    }

    func inventory(_ connection: PadConnection, more: Bool = false) async {
        await connection.perform {
            inventoryGeneration += 1
            let generation = inventoryGeneration
            let api = ClientInventory(transport: try await connection.transport())
            if !more || workCursor != nil {
                let page = try await api.works(cursor: more ? workCursor : nil)
                guard generation == inventoryGeneration, !Task.isCancelled else { return }
                works = Self.merge(more ? works : [], page.items)
                workCursor = page.nextCursor
            }
            if !more || taskCursor != nil {
                let page = try await api.tasks(cursor: more ? taskCursor : nil)
                guard generation == inventoryGeneration, !Task.isCancelled else { return }
                tasks = Self.merge(more ? tasks : [], page.items)
                taskCursor = page.nextCursor
            }
            if !more || sessionCursor != nil {
                let page = try await api.sessions(cursor: more ? sessionCursor : nil)
                guard generation == inventoryGeneration, !Task.isCancelled else { return }
                sessions = Self.merge(more ? sessions : [], page.items)
                sessionCursor = page.nextCursor
            }
            rebuildGroups()
        }
    }

    func rebuildGroups() {
        tasksByWork = Dictionary(grouping: tasks, by: \.workId)
        discussionsByWork = Dictionary(grouping: sessions.filter { $0.sessionKind == "workChat" && $0.workId != nil }, by: { $0.workId! })
        sessionsByID = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    }

    func sessionIsKnownUnavailable(_ id: String) -> Bool {
        sessionCursor == nil && sessionsByID[id] == nil
    }

    static func merge<T: Identifiable>(_ old: [T], _ new: [T]) -> [T] where T.ID == String {
        let replacements = Dictionary(new.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        let existing = Set(old.map(\.id))
        return old.map { replacements[$0.id] ?? $0 } + new.filter { !existing.contains($0.id) }
    }

    func load(_ connection: PadConnection, older: Bool = false) async {
        guard let id = selection else { return }
        await connection.perform {
            timelineGeneration += 1
            let generation = timelineGeneration
            let api = ClientSessionAPI(transport: try await connection.transport())
            let caps = try await api.capabilities(sessionId: id)
            guard !Task.isCancelled, selection == id, generation == timelineGeneration else { return }
            capabilities = caps
            guard caps.readMessages else {
                connection.notice = "设备未获消息读取权限，请在 Mac 上授权。"
                return
            }
            let page = try await api.messages(sessionId: id, before: older ? before : nil)
            guard !Task.isCancelled, selection == id, generation == timelineGeneration else { return }
            let updated = older ? Self.merge(page.items, messages) : page.items
            if messages != updated {
                messages = updated
                if !older { messageRevision += 1 }
            }
            before = page.nextBefore
        }
    }

    func clearSelectionState() {
        timelineGeneration += 1
        messages = []
        before = nil
        capabilities = nil
        status = ""
    }

    func command(_ connection: PadConnection, stop: Bool) async {
        guard let id = selection, pending == nil else { return }
        let text = drafts[id] ?? ""
        guard stop || (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && text.utf16.count <= 16000) else { return }
        await connection.perform {
            let api = ClientSessionAPI(transport: try await connection.transport())
            let command = PendingCommand(requestID: UUID().uuidString, sessionID: id, kind: stop ? "stop" : "send", serverID: connection.serverID, address: connection.address)
            // Persist the identity before any mutation. Never persist message text in preferences.
            defaults.set(try JSONEncoder().encode(command), forKey: "pendingCommand")
            pending = command
            status = "请求提交中；网络中断时请核对回执，不要重复发送。"
            let receipt = try await (stop
                ? api.stop(sessionId: id, requestId: command.requestID)
                : api.send(sessionId: id, requestId: command.requestID, text: text))
            settle(receipt)
        }
        if pending == nil { await load(connection) }
    }

    func reconcile(_ connection: PadConnection) async {
        guard let pending, pending.serverID == connection.serverID, pending.address == connection.address else { return }
        await connection.perform {
            let api = ClientSessionAPI(transport: try await connection.transport())
            settle(try await api.receipt(requestId: pending.requestID))
        }
    }

    func settle(_ receipt: ClientCommandReceipt) {
        guard let pending, receipt.requestId == pending.requestID, receipt.sessionId == pending.sessionID,
              receipt.kind == pending.kind else {
            status = "回执与本机请求不一致，保留待核对记录。"
            return
        }
        if receipt.status == "accepted" || receipt.status == "stop_requested" {
            if receipt.kind == "send" {
                drafts[receipt.sessionId] = ""
                if selection == receipt.sessionId { scrollRequest += 1 }
            }
            status = receipt.kind == "send" ? "已接收，正在等待模型回复。" : "已请求停止，正在同步状态。"
            forgetPending()
        } else {
            status = "执行结果待核对（\(receipt.status)）。不会自动重发。"
        }
    }

    func forgetPending() {
        pending = nil
        defaults.removeObject(forKey: "pendingCommand")
    }
}
