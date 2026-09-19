import Foundation
import Observation
import CorptieClientCore

struct PendingCommand: Codable {
    let requestID: String
    let sessionID: String
    let kind: String
    let serverID: String
    let address: String
    let draftSessionID: String?

    init(requestID: String, sessionID: String, kind: String, serverID: String, address: String,
         draftSessionID: String? = nil) {
        self.requestID = requestID
        self.sessionID = sessionID
        self.kind = kind
        self.serverID = serverID
        self.address = address
        self.draftSessionID = draftSessionID
    }
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
    var outgoingMessages: [String: [ClientMessage]] = [:]
    var outgoingStates: [String: String] = [:]
    var outgoingRequestIDs: [String: String] = [:]
    var lastTimelineRevision: Int?
    var visibleMessages: [ClientMessage] {
        Self.merge(messages, (outgoingMessages[selection ?? ""] ?? []).filter { item in
            !messages.contains { $0.id == item.id }
        })
    }

    /// A window is not a replacement for all loaded history. During submission,
    /// an empty projection is not proof that the conversation was cleared.
    func applyLatestWindow(_ items: [ClientMessage], cursor: String?, revision: Int?) {
        if let revision, let previous = lastTimelineRevision, revision < previous { return }
        if items.isEmpty, !messages.isEmpty, let revision, let previous = lastTimelineRevision, revision == previous { return }
        if items.isEmpty, !messages.isEmpty, !(outgoingMessages[selection ?? ""] ?? []).isEmpty { return }
        let previous = messages
        if let first = items.first?.id, let overlap = messages.firstIndex(where: { $0.id == first }) {
            messages = Array(messages.prefix(overlap)) + items
        } else {
            messages = items
            before = cursor
        }
        if let revision { lastTimelineRevision = revision }
        if let selection {
            let received = Set(items.map(\.id))
            outgoingMessages[selection]?.removeAll { received.contains($0.id) }
            for id in received { outgoingStates.removeValue(forKey: id) }
        }
        if previous != messages { messageRevision += 1 }
    }
    var before: String?
    var capabilities: ClientSessionCapabilities?
    var composerConfiguration: ClientComposerConfiguration?
    var configuringComposer = false
    var composerGeneration = 0
    var importingImagesForSession: String?
    var drafts: [String: String] = [:]
    var draftImages: [String: [ClientDraftImage]] = [:]
    var draftMentions: [String: [ClientDraftMention]] = [:]
    var status = ""
    var conversationNotice = ""
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
        conversationNotice = ""
        timelineGeneration += 1
        let generation = timelineGeneration
        do {
            let api = ClientSessionAPI(transport: try await connection.transport())
            let caps = try await api.capabilities(sessionId: id)
            guard !Task.isCancelled, selection == id, generation == timelineGeneration else { return }
            capabilities = caps
            guard caps.readMessages else {
                conversationNotice = "设备未获消息读取权限，请在 Mac 上授权。"
                return
            }
            let page = try await api.messages(sessionId: caps.sessionId, before: older ? before : nil)
            guard !Task.isCancelled, selection == id, generation == timelineGeneration else { return }
            if older {
                messages = Self.merge(page.items, messages)
                before = page.nextBefore
            } else {
                applyLatestWindow(page.items, cursor: page.nextBefore, revision: page.revision)
            }
            if !older, caps.composer == true, composerConfiguration == nil {
                await configureComposer(connection)
            }
        } catch is CancellationError {
            return
        } catch {
            guard selection == id, generation == timelineGeneration else { return }
            conversationNotice = PadConnection.explain(error)
        }
    }

    func clearSelectionState() {
        timelineGeneration += 1
        messages = []
        lastTimelineRevision = nil
        before = nil
        capabilities = nil
        composerConfiguration = nil
        composerGeneration += 1
        configuringComposer = false
        status = ""
        conversationNotice = ""
    }

    func configureComposer(_ connection: PadConnection, update: [String: String]? = nil) async {
        guard let id = selection, !configuringComposer, capabilities?.composer == true else { return }
        let routedID = capabilities?.sessionId ?? id
        composerGeneration += 1
        let generation = composerGeneration
        configuringComposer = true
        defer { if generation == composerGeneration { configuringComposer = false } }
        do {
            let api = ClientSessionAPI(transport: try await connection.transport())
            let result = try await api.composer(sessionId: routedID, update: update)
            guard selection == id, generation == composerGeneration, !Task.isCancelled else { return }
            composerConfiguration = result
        } catch {
            guard selection == id, generation == composerGeneration, !Task.isCancelled else { return }
            conversationNotice = PadConnection.explain(error)
        }
    }

    func command(_ connection: PadConnection, stop: Bool, schedule: ClientMessageSchedule? = nil) async {
        guard let id = selection, pending == nil, importingImagesForSession != id else { return }
        let routedID = capabilities?.sessionId ?? id
        let text = drafts[id] ?? ""
        let images = draftImages[id] ?? []
        let mentions = (draftMentions[id] ?? []).filter { text.contains("@\($0.displayName)") }
        guard stop || ((!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty) && text.utf16.count <= 16000) else { return }
        await connection.perform {
            let api = ClientSessionAPI(transport: try await connection.transport())
            let command = PendingCommand(requestID: UUID().uuidString, sessionID: routedID,
                kind: stop ? "stop" : "send", serverID: connection.serverID,
                address: connection.address, draftSessionID: id)
            // Persist the identity before any mutation. Never persist message text in preferences.
            defaults.set(try JSONEncoder().encode(command), forKey: "pendingCommand")
            pending = command
            status = ""
            if !stop, schedule == nil, let deviceID = connection.deviceID {
                let messageID = ClientSessionAPI.messageID(deviceID: deviceID, requestID: command.requestID)
                outgoingMessages[id, default: []].append(ClientMessage(id: messageID, text: text.isEmpty ? "图片消息" : text))
                outgoingStates[messageID] = "Sending"
                outgoingRequestIDs[command.requestID] = messageID
                scrollRequest += 1
            }
            let receipt = try await (stop
                ? api.stop(sessionId: routedID, requestId: command.requestID)
                : api.send(sessionId: routedID, requestId: command.requestID, text: text, images: images, mentions: mentions, schedule: schedule))
            settle(receipt)
            if schedule != nil, receipt.status == "accepted" { status = "定时消息已创建，可在自动化页面查看。" }
        }
        if let pending, let messageID = outgoingRequestIDs[pending.requestID], outgoingStates[messageID] == "Sending" {
            outgoingStates[messageID] = "结果待核对"
        }
        if pending == nil {
            inventoryDirty = true; messagesDirty = true
            scheduleRefresh(connection)
        }
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
                let draftSessionID = pending.draftSessionID ?? receipt.sessionId
                drafts[draftSessionID] = ""
                draftImages[draftSessionID] = []
                draftMentions[draftSessionID] = []
                if selection == draftSessionID { scrollRequest += 1 }
            }
            status = ""
            // Acceptance confirms receipt only, not model execution.
            if let messageID = outgoingRequestIDs.removeValue(forKey: receipt.requestId), outgoingStates[messageID] != nil {
                outgoingStates[messageID] = "Sent"
            }
            forgetPending()
        } else {
            if let messageID = outgoingRequestIDs[receipt.requestId], outgoingStates[messageID] != nil {
                outgoingStates[messageID] = "结果待核对"
            }
            status = "执行结果待核对（\(receipt.status)）。不会自动重发。"
        }
    }

    func forgetPending() {
        pending = nil
        defaults.removeObject(forKey: "pendingCommand")
    }
}
