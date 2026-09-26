import Foundation
import Observation
import CorptieClientCore

func padUserInputStatusText(_ status: String?, submittedLocally: Bool) -> String {
    switch status {
    case "dispatching": return "正在提交，等待确认"
    case "unknown": return "提交结果待同步，请勿重复提交"
    case "submitted": return "已提交，等待会话更新"
    case "pending" where submittedLocally: return "已提交，等待会话更新"
    default: return "此问题已失效"
    }
}

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

struct ReceiptReconciliationKey: Hashable {
    let requestID: String
    let serverID: String
    let address: String
    let deviceID: String?
}

struct CommandConfirmation: Identifiable {
    let id = UUID()
    let command: ClientConversationCommand
    let text: String
    let sessionID: String
    let draftSessionID: String
    let draftRevision: Int
    let serverID: String
    let address: String
    let deviceID: String?
}

/// Deduplicates automatic history requests emitted by scroll geometry. A new
/// pagination cursor rearms a reader that remains near the top; underfilled
/// timelines may bootstrap a bounded number of pages, matching the Mac client.
struct PadHistoryAutoLoadGate: Equatable {
    private(set) var scope: String?
    private(set) var lastNearTopCursor: String?
    private(set) var underfilledRequestCount = 0
    private(set) var lastUnderfilledCursor: String?

    mutating func requestCursor(
        scope: String,
        before: String?,
        nearTop: Bool,
        underfilled: Bool,
        isLoading: Bool,
        connectionBusy: Bool
    ) -> String? {
        if self.scope != scope {
            self.scope = scope
            lastNearTopCursor = nil
            underfilledRequestCount = 0
            lastUnderfilledCursor = nil
        }
        if !nearTop { lastNearTopCursor = nil }
        guard let before, !isLoading, !connectionBusy else { return nil }

        if underfilled {
            guard underfilledRequestCount < 4,
                  lastUnderfilledCursor != before else { return nil }
            lastUnderfilledCursor = before
            underfilledRequestCount += 1
            return before
        }

        guard nearTop, lastNearTopCursor != before else { return nil }
        lastNearTopCursor = before
        return before
    }
}

@MainActor @Observable
final class PadWorkspace {
    var works: [ClientWork] = []
    var tasks: [ClientTask] = []
    var sessions: [ClientSession] = []
    var tasksByWork: [String: [ClientTask]] = [:]
    var discussionsByWork: [String: [ClientSession]] = [:]
    /// Sessions outside any Work (macOS "Chat" group), in inventory order.
    private(set) var independentSessions: [ClientSession] = []
    var sessionsByID: [String: ClientSession] = [:]
    private(set) var processingWorkIDs: Set<String> = []
    private(set) var executionByTaskID: [String: String] = [:]
    private(set) var activityByTaskID: [String: TaskSessionActivity] = [:]
    private(set) var sessionIDByTaskID: [String: String] = [:]
    /// Unread projection (macOS `WorkRailUnreadSummary`): Sessions whose agent output
    /// the user has not opened, the Works they belong to, and independent chats.
    private(set) var unreadSessionIDs: Set<String> = []
    private(set) var unreadWorkIDs: Set<String> = []
    private(set) var hasUnreadIndependentSessions = false
    /// Sequences already submitted as read receipts; hides the dot until the host echoes the cursor.
    @ObservationIgnored private var submittedReadSequences: [String: Int] = [:]
    @ObservationIgnored private var readReceiptScope = ""
    var workCursor: String?
    var taskCursor: String?
    var sessionCursor: String?
    var selection: String? {
        didSet { if oldValue != selection { selectSession(from: oldValue, to: selection) } }
    }
    var messages: [ClientMessage] = [] {
        didSet { if oldValue != messages { refreshDisplayEntries() } }
    }
    var outgoingMessages: [String: [ClientMessage]] = [:] {
        didSet {
            if oldValue[selection ?? ""] != outgoingMessages[selection ?? ""] { refreshDisplayEntries() }
        }
    }
    private(set) var displayEntries: [ConversationEntry<ClientMessage>] = []
    private(set) var processPresentations: [String: ConversationProcessPresentation] = [:]
    private(set) var activeProcessEntryID: String?
    private(set) var processSteps: [String: [ConversationExecutionStep]] = [:]
    @ObservationIgnored private var projectedMessages: [ClientMessage] = []
    var outgoingStates: [String: String] = [:]
    var outgoingRequestIDs: [String: String] = [:]
    var lastTimelineRevision: Int?
    var visibleMessages: [ClientMessage] {
        Self.merge(messages, (outgoingMessages[selection ?? ""] ?? []).filter { item in
            !messages.contains { $0.id == item.id }
        })
    }

    private func refreshDisplayEntries() {
        let source = visibleMessages
        guard source != projectedMessages else { return }
        projectedMessages = source
        displayEntries = ConversationTimeline.makeEntries(from: source)
        let now = Date()
        processSteps = Dictionary(uniqueKeysWithValues: displayEntries.compactMap { entry in
            guard case let .process(_, items) = entry.kind else { return nil }
            return (entry.id, ConversationExecutionProjection.steps(for: items))
        })
        processPresentations = Dictionary(uniqueKeysWithValues: displayEntries.compactMap { entry in
            guard case let .process(_, items) = entry.kind else { return nil }
            let state = ConversationProcessPresentation.state(for: items)
            let currentStepTitle: String? = if state == .running,
                                               let lastStep = processSteps[entry.id]?.last {
                if let plan = lastStep.plan {
                    plan.steps.first(where: { $0.status == "inProgress" })?.text
                        ?? plan.steps.first(where: { $0.status == "pending" })?.text
                } else {
                    lastStep.title
                }
            } else { nil }
            return (entry.id, ConversationProcessPresentation(
                state: state, count: items.count,
                duration: ConversationProcessPresentation.durationText(for: items, now: now),
                currentStepTitle: currentStepTitle))
        })
        activeProcessEntryID = displayEntries.last(where: {
            processPresentations[$0.id]?.state == .running
        })?.id
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
            // With no retained prefix this is a replacement of the latest page,
            // so recover its history cursor after reconnect/snapshot repair.
            if overlap == 0 { before = cursor }
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
    /// Usage of the selected Session; re-read once per timeline change, never per frame.
    var usage: ClientSessionUsage?
    @ObservationIgnored private var usageRevision: Int?
    var composerConfiguration: ClientComposerConfiguration?
    var commandCatalog: ClientConversationCommandCatalog?
    var configuringComposer = false
    var composerGeneration = 0
    var importingImagesForSession: String?
    private(set) var isLoadingDetail = false
    private(set) var isLoadingEarlier = false
    var historyRestorationAnchor: String?

    struct ResidentTimelineState {
        var messages: [ClientMessage]
        var before: String?
        var lastTimelineRevision: Int?
        var capabilities: ClientSessionCapabilities?
        var usage: ClientSessionUsage?
        var composerConfiguration: ClientComposerConfiguration?
    }

    @ObservationIgnored private var residentStates: [String: ResidentTimelineState] = [:]
    @ObservationIgnored private var residentRecency: [String] = []
    @ObservationIgnored private let residentCapacity = 48

    func saveResidentState(for sessionID: String) {
        residentStates[sessionID] = ResidentTimelineState(
            messages: messages,
            before: before,
            lastTimelineRevision: lastTimelineRevision,
            capabilities: capabilities,
            usage: usage,
            composerConfiguration: composerConfiguration
        )
        residentRecency.removeAll { $0 == sessionID }
        residentRecency.append(sessionID)
        trimResidentStatesIfNeeded()
    }

    private func trimResidentStatesIfNeeded() {
        while residentRecency.count > residentCapacity {
            let evicted = residentRecency.removeFirst()
            residentStates.removeValue(forKey: evicted)
        }
    }

    func selectSession(from oldID: String?, to newID: String?) {
        if let oldID {
            saveResidentState(for: oldID)
        }
        commandConfirmation = nil
        timelineGeneration += 1
        composerGeneration += 1
        configuringComposer = false
        status = ""
        conversationNotice = ""
        historyRestorationAnchor = nil
        isLoadingEarlier = false

        if let newID, let cached = residentStates[newID] {
            messages = cached.messages
            before = cached.before
            lastTimelineRevision = cached.lastTimelineRevision
            capabilities = cached.capabilities
            usage = cached.usage
            composerConfiguration = cached.composerConfiguration
            isLoadingDetail = false
            refreshDisplayEntries()
        } else {
            messages = []
            before = nil
            lastTimelineRevision = nil
            capabilities = nil
            usage = nil
            composerConfiguration = nil
            isLoadingDetail = (newID != nil)
            refreshDisplayEntries()
        }
    }
    var drafts: [String: String] = [:] {
        didSet {
            for id in Set(oldValue.keys).union(drafts.keys) where oldValue[id] != drafts[id] {
                draftRevisions[id, default: 0] += 1
            }
        }
    }
    private var draftRevisions: [String: Int] = [:]
    private struct SubmissionSnapshot {
        let sessionID: String
        let textRevision: Int
        let imageIDs: [UUID]
        let mentions: [String]
    }
    private var submissions: [String: SubmissionSnapshot] = [:]
    var draftImages: [String: [ClientDraftImage]] = [:]
    var draftMentions: [String: [ClientDraftMention]] = [:]
    var status = ""
    var conversationNotice = ""
    var liveStatus = "正在连接实时更新"
    var realtimeConnected = false
    var lastRealtimePulseAt: Date?
    var realtimePausedAt: Date?
    var messageRevision = 0
    var controlRevision = 0
    var directControlSnapshot: ClientControlSnapshot?
    var realtimeStateRevision = 0
    var scrollRequest = 0
    var timelineGeneration = 0
    var inventoryGeneration = 0
    var realtimeGeneration: UUID?
    var inventoryDirty = false
    var messagesDirty = false
    var refreshWorker: Task<Void, Never>?
    var pending: PendingCommand?
    var pushedReceipt: ClientCommandReceipt?
    var pushedReceiptRevision = 0
    var commandConfirmation: CommandConfirmation?
    var automaticReconciliationActive = false
    @ObservationIgnored private var reconciliationRun: UUID?
    @ObservationIgnored private var receiptReadInFlight = false
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        pending = defaults.data(forKey: "pendingCommand").flatMap { try? JSONDecoder().decode(PendingCommand.self, from: $0) }
    }

    func applyRealtimeState(_ snapshot: ClientStateSnapshot) {
        guard snapshot.schemaVersion == 2, snapshot.revision >= realtimeStateRevision else { return }
        realtimeStateRevision = snapshot.revision
        if works != snapshot.works { works = snapshot.works }
        if tasks != snapshot.tasks { tasks = snapshot.tasks }
        if sessions != snapshot.sessions { sessions = snapshot.sessions }
        workCursor = nil; taskCursor = nil; sessionCursor = nil
        rebuildGroups()
    }

    func applyRealtimeTimeline(_ snapshot: ClientTimelineSnapshot) {
        guard snapshot.schemaVersion == 2, selection != nil else { return }
        capabilities = snapshot.capabilities
        usage = snapshot.usage
        composerConfiguration = snapshot.composer
        applyLatestWindow(snapshot.messages.items, cursor: snapshot.messages.nextBefore, revision: snapshot.revision)
        isLoadingDetail = false
        liveStatus = "实时连接正常"
    }

    @discardableResult
    func applyRealtimeTimeline(_ delta: ClientTimelineDelta) -> Bool {
        guard delta.schemaVersion == 2, delta.snapshotRequired == false,
              delta.baseRevision == (lastTimelineRevision ?? 0) else { return false }
        var expected = delta.baseRevision
        var byID = Dictionary(uniqueKeysWithValues: messages.map { ($0.id, $0) })
        for change in delta.changes {
            expected += 1
            guard change.revision == expected else { return false }
            switch change.operation {
            case "upsert":
                guard let item = change.item, item.id == change.itemId else { return false }
                byID[item.id] = item
            case "delete": byID[change.itemId] = nil
            default: return false
            }
        }
        guard expected == delta.revision else { return false }
        let next = byID.values.sorted {
            let left = $0.createdAt ?? "", right = $1.createdAt ?? ""
            return left == right ? $0.id < $1.id : left < right
        }
        let previous = messages
        messages = next
        lastTimelineRevision = delta.revision
        if previous != next { messageRevision += 1 }
        return true
    }

    func inventory(_ connection: PadConnection, more: Bool = false) async {
        await connection.perform {
            inventoryGeneration += 1
            let generation = inventoryGeneration
            let api = ClientInventory(transport: try await connection.transport())
            var fetchMore = more
            repeat {
                if !fetchMore || workCursor != nil {
                    let page = try await api.works(cursor: fetchMore ? workCursor : nil)
                    guard generation == inventoryGeneration, !Task.isCancelled else { return }
                    works = Self.merge(fetchMore ? works : [], page.items)
                    workCursor = page.nextCursor
                }
                if !fetchMore || taskCursor != nil {
                    let page = try await api.tasks(cursor: fetchMore ? taskCursor : nil)
                    guard generation == inventoryGeneration, !Task.isCancelled else { return }
                    tasks = Self.merge(fetchMore ? tasks : [], page.items)
                    taskCursor = page.nextCursor
                }
                if !fetchMore || sessionCursor != nil {
                    let page = try await api.sessions(cursor: fetchMore ? sessionCursor : nil)
                    guard generation == inventoryGeneration, !Task.isCancelled else { return }
                    sessions = Self.merge(fetchMore ? sessions : [], page.items)
                    sessionCursor = page.nextCursor
                }
                rebuildGroups()
                if !more && (workCursor != nil || taskCursor != nil || sessionCursor != nil) {
                    fetchMore = true
                } else {
                    break
                }
            } while !Task.isCancelled
        }
    }

    func rebuildGroups() {
        // The desktop outline hides archived Tasks (`archived != true`) and completed Tasks (`lifecycleState != "done"`).
        // Also filter tasks whose bound currentSessionId is known unavailable (session was archived by effectiveSessionArchivedSQL).
        sessionsByID = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        tasksByWork = Dictionary(grouping: tasks.filter { task in
            guard !task.archived && task.lifecycleState != "done" else { return false }
            if let sessionID = task.currentSessionId, !sessionID.isEmpty,
               sessionCursor == nil && sessionsByID[sessionID] == nil {
                return false
            }
            return true
        }, by: \.workId)
        discussionsByWork = Dictionary(grouping: sessions.filter { $0.sessionKind == "workChat" && $0.workId != nil }, by: { $0.workId! })
        let independent = sessions.filter { $0.workId == nil }
        if independentSessions != independent { independentSessions = independent }
        var execution: [String: String] = [:]
        var activity: [String: TaskSessionActivity] = [:]
        var resolvedSessionIDs: [String: String] = [:]
        var processing: Set<String> = []
        // Device inventory contains only live Sessions. Index once, never scan per rendered row.
        var latestByTask: [String: ClientSession] = [:]
        for session in sessions {
            guard let taskID = session.taskId else { continue }
            if latestByTask[taskID].map({ $0.updatedAt < session.updatedAt }) ?? true {
                latestByTask[taskID] = session
            }
        }
        for task in tasks {
            let bindingID = task.currentSessionId?.trimmingCharacters(in: .whitespacesAndNewlines)
            let bound = bindingID.flatMap { sessionsByID[$0] } ?? latestByTask[task.id]
            if let sessionID = bound?.id ?? bindingID, !sessionID.isEmpty {
                resolvedSessionIDs[task.id] = sessionID
            }
            let status = bound?.executionStatus ?? task.executionStatus
            execution[task.id] = status
            let resolved = TaskSessionActivity.resolve(hasBinding: bindingID?.isEmpty == false || bound != nil,
                sessionExecutionStatus: bound?.executionStatus, taskExecutionStatus: task.executionStatus)
            activity[task.id] = resolved
            if resolved == .processing {
                processing.insert(task.workId)
            }
        }
        if executionByTaskID != execution { executionByTaskID = execution }
        if activityByTaskID != activity { activityByTaskID = activity }
        if sessionIDByTaskID != resolvedSessionIDs { sessionIDByTaskID = resolvedSessionIDs }
        if processingWorkIDs != processing { processingWorkIDs = processing }
        rebuildUnread()
    }

    private func rebuildUnread() {
        var unreadSessions: Set<String> = []
        var unreadWorks: Set<String> = []
        var independent = false
        for session in sessions where isUnread(session) {
            unreadSessions.insert(session.id)
            if let workID = session.workId { unreadWorks.insert(workID) } else { independent = true }
        }
        if unreadSessionIDs != unreadSessions { unreadSessionIDs = unreadSessions }
        if unreadWorkIDs != unreadWorks { unreadWorkIDs = unreadWorks }
        if hasUnreadIndependentSessions != independent { hasUnreadIndependentSessions = independent }
    }

    /// Desktop rule plus the locally submitted receipt, so the dot clears on tap
    /// instead of waiting for the next inventory round-trip.
    func isUnread(_ session: ClientSession) -> Bool {
        let acknowledged = max(session.lastReadMessageSequence, submittedReadSequences[session.id] ?? 0)
        return SessionReadAttention.needsUserAttention(executionStatus: session.executionStatus,
            lastAgentMessageSequence: session.lastAgentMessageSequence, lastReadMessageSequence: acknowledged)
    }

    /// Mirrors macOS `markOpenedSessionRead`: submit once per new agent sequence while the
    /// conversation is open in an active scene; roll back the local mark on failure.
    func acknowledgeOpenedSession(_ connection: PadConnection, isActive: Bool) {
        let scope = "\(connection.serverID)|\(connection.address)"
        if scope != readReceiptScope {
            readReceiptScope = scope
            submittedReadSequences = [:]
        }
        guard isActive, let id = selection, let session = sessionsByID[id],
              let sequence = SessionReadAttention.sequenceForOpenedSession(
                  lastAgentMessageSequence: session.lastAgentMessageSequence,
                  lastReadMessageSequence: session.lastReadMessageSequence,
                  alreadySubmittedSequence: submittedReadSequences[id]) else { return }
        submittedReadSequences[id] = sequence
        rebuildUnread()
        Task { [weak self] in
            do {
                let api = ClientSessionAPI(transport: try await connection.transport())
                _ = try await api.readReceipt(sessionId: id, throughSequence: sequence)
            } catch {
                guard let self, self.submittedReadSequences[id] == sequence, self.readReceiptScope == scope else { return }
                self.submittedReadSequences[id] = nil
                self.rebuildUnread()
            }
        }
    }

    func sessionIsKnownUnavailable(_ id: String) -> Bool {
        sessionCursor == nil && sessionsByID[id] == nil
    }

    static func merge<T: Identifiable>(_ old: [T], _ new: [T]) -> [T] where T.ID == String {
        let replacements = Dictionary(new.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        let existing = Set(old.map(\.id))
        return old.map { replacements[$0.id] ?? $0 } + new.filter { !existing.contains($0.id) }
    }

    func loadEarlierMessagesIfNeeded(_ connection: PadConnection) async {
        guard selection != nil, before != nil, !isLoadingEarlier, !connection.busy else { return }
        isLoadingEarlier = true
        defer { isLoadingEarlier = false }
        await load(connection, older: true)
    }

    func load(_ connection: PadConnection, older: Bool = false) async {
        guard let id = selection else { return }
        conversationNotice = ""
        if !older {
            timelineGeneration += 1
        }
        let generation = timelineGeneration
        do {
            let api = ClientSessionAPI(transport: try await connection.transport())
            let caps: ClientSessionCapabilities
            if let existing = capabilities, older {
                caps = existing
            } else {
                caps = try await api.capabilities(sessionId: id)
            }
            guard !Task.isCancelled, selection == id, generation == timelineGeneration else { return }
            capabilities = caps
            guard caps.readMessages else {
                conversationNotice = "设备未获消息读取权限，请在 Mac 上授权。"
                return
            }
            let page = try await api.messages(sessionId: caps.sessionId, before: older ? before : nil)
            guard !Task.isCancelled, selection == id, generation == timelineGeneration else { return }
            if older {
                let anchorID = messages.first?.id
                messages = Self.merge(page.items, messages)
                before = page.nextBefore
                historyRestorationAnchor = anchorID
            } else {
                applyLatestWindow(page.items, cursor: page.nextBefore, revision: page.revision)
                isLoadingDetail = false
            }
            saveResidentState(for: id)
            if !older, caps.composer == true, composerConfiguration == nil {
                await configureComposer(connection)
            }
            if !older, caps.readMessages, commandCatalog == nil {
                await loadCommandCatalog(connection)
            }
            if !older { await loadUsage(api, sessionID: id, routedID: caps.sessionId, generation: generation) }
        } catch is CancellationError {
            return
        } catch {
            guard selection == id, generation == timelineGeneration else { return }
            conversationNotice = PadConnection.explain(error)
        }
    }

    func clearSelectionState() {
        if let id = selection {
            residentStates.removeValue(forKey: id)
            residentRecency.removeAll { $0 == id }
        }
        commandConfirmation = nil
        timelineGeneration += 1
        messages = []
        refreshDisplayEntries()
        lastTimelineRevision = nil
        before = nil
        capabilities = nil
        usage = nil
        usageRevision = nil
        composerConfiguration = nil
        commandCatalog = nil
        composerGeneration += 1
        configuringComposer = false
        status = ""
        conversationNotice = ""
        historyRestorationAnchor = nil
        isLoadingEarlier = false
        isLoadingDetail = false
    }

    /// One usage read per applied timeline window (desktop refreshes after each
    /// live usage burst). Hosts without a usage reader answer 409; that clears it.
    func loadUsage(_ api: ClientSessionAPI, sessionID: String, routedID: String, generation: Int) async {
        guard usageRevision != messageRevision else { return }
        let revision = messageRevision
        do {
            let snapshot = try await api.usage(sessionId: routedID)
            guard !Task.isCancelled, selection == sessionID, generation == timelineGeneration else { return }
            usageRevision = revision
            if usage != snapshot { usage = snapshot }
        } catch is CancellationError {
            return
        } catch {
            guard selection == sessionID, generation == timelineGeneration else { return }
            usageRevision = revision
            if usage != nil { usage = nil }
        }
    }

    func loadCommandCatalog(_ connection: PadConnection) async {
        guard let id = selection else { return }
        let routedID = capabilities?.sessionId ?? id
        let generation = timelineGeneration
        do {
            let api = ClientSessionAPI(transport: try await connection.transport())
            let catalog = try await api.commandCatalog(sessionId: routedID)
            guard selection == id, generation == timelineGeneration, !Task.isCancelled else { return }
            commandCatalog = catalog
        } catch {
            // Non-blocking: catalog is an enhancement for discovery and suggestions
        }
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

    func command(_ connection: PadConnection, stop: Bool, schedule: ClientMessageSchedule? = nil,
                 confirmation: CommandConfirmation? = nil, suggestedReply: String? = nil) async {
        if let confirmation, !confirmationMatches(confirmation, connection: connection) {
            commandConfirmation = nil
            status = "命令、草稿或连接已变化，请重新发送并确认。"
            return
        }
        guard let id = selection, pending == nil, importingImagesForSession != id else { return }
        let routedID = capabilities?.sessionId ?? id
        let text = suggestedReply ?? (drafts[id] ?? "")
        let images = suggestedReply == nil ? (draftImages[id] ?? []) : []
        let mentions = suggestedReply == nil
            ? (draftMentions[id] ?? []).filter { text.contains("@\($0.displayName)") } : []
        let slashCommand = stop || suggestedReply != nil ? nil : ClientConversationCommand.parse(text)
        if slashCommand != nil, !images.isEmpty || !mentions.isEmpty || schedule != nil {
            status = "请单独发送斜杠命令，不要附带图片、引用或定时设置。"
            return
        }
        guard stop || ((!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty) && text.utf16.count <= 16000) else { return }
        let snapshot = submissionSnapshot(sessionID: id)
        let serverID = connection.serverID, address = connection.address, deviceID = connection.deviceID
        var receivedAcknowledgement = false
        await connection.perform {
            let api = ClientSessionAPI(transport: try await connection.transport())
            guard connection.serverID == serverID, connection.address == address, connection.deviceID == deviceID,
                  !Task.isCancelled else { return }
            if let confirmation, !confirmationMatches(confirmation, connection: connection) {
                commandConfirmation = nil
                status = "命令、草稿或连接已变化，请重新发送并确认。"
                return
            }
            commandConfirmation = nil
            let command = PendingCommand(requestID: UUID().uuidString, sessionID: routedID,
                kind: stop ? "stop" : (slashCommand == nil ? "send" : "conversation_command"), serverID: connection.serverID,
                address: connection.address, draftSessionID: id)
            // Persist the identity before any mutation. Never persist message text in preferences.
            defaults.set(try JSONEncoder().encode(command), forKey: "pendingCommand")
            pending = command
            // Suggested replies are independent of the user's current draft.
            // They still use the same idempotent send/receipt path, but a later
            // acknowledgement must never clear text or images being composed.
            if !stop && suggestedReply == nil { submissions[command.requestID] = snapshot }
            status = ""
            if !stop, slashCommand == nil, schedule == nil, let deviceID = connection.deviceID {
                let messageID = ClientSessionAPI.messageID(deviceID: deviceID, requestID: command.requestID)
                outgoingMessages[id, default: []].append(ClientMessage(id: messageID, text: text.isEmpty ? "图片消息" : text))
                outgoingStates[messageID] = "Sending"
                outgoingRequestIDs[command.requestID] = messageID
                scrollRequest += 1
            }
            let receipt: ClientCommandReceipt
            do {
                if let slashCommand {
                    receipt = try await api.conversationCommand(sessionId: routedID, requestId: command.requestID,
                        command: slashCommand, confirmed: confirmation != nil)
                } else if stop {
                    receipt = try await api.stop(sessionId: routedID, requestId: command.requestID)
                } else {
                    receipt = try await api.send(sessionId: routedID, requestId: command.requestID, text: text, images: images, mentions: mentions, schedule: schedule)
                }
            } catch {
                if let failure = error as? ClientServiceFailure, failure.code == "COMMAND_CONFIRMATION_REQUIRED",
                   let slashCommand, pending?.requestID == command.requestID {
                    forgetPending()
                    // The server rejected before dispatch. Confirmation is an
                    // explicit NEW intent, never a replay of an uncertain send.
                    let proposal = CommandConfirmation(command: slashCommand, text: text,
                        sessionID: routedID, draftSessionID: id, draftRevision: snapshot.textRevision,
                        serverID: serverID, address: address, deviceID: deviceID)
                    commandConfirmation = proposal
                    if !confirmationMatches(proposal, connection: connection) {
                        commandConfirmation = nil
                        status = "命令、草稿或连接已变化，请重新发送并确认。"
                    }
                    return
                }
                rejectBeforeDispatch(error, requestID: command.requestID)
                throw error
            }
            receivedAcknowledgement = true
            // A concurrent receipt read may have already settled this request
            // while the original POST response was still in transit.
            if pending?.requestID == command.requestID { settle(receipt) }
            if schedule != nil, receipt.status == "accepted" { status = "定时消息已创建，可在自动化页面查看。" }
        }
        if !receivedAcknowledgement, let pending, let messageID = outgoingRequestIDs[pending.requestID], outgoingStates[messageID] == "Sending" {
            outgoingStates[messageID] = "送达状态未确认"
        }
        if pending == nil {
            inventoryDirty = true; messagesDirty = true
            scheduleRefresh(connection)
        }
    }

    func sendSuggestedReply(_ connection: PadConnection, sessionID: String, text: String) async {
        guard selection == sessionID else { return }
        await command(connection, stop: false, suggestedReply: text)
    }

    private func confirmationMatches(_ proposal: CommandConfirmation, connection: PadConnection) -> Bool {
        commandConfirmation?.id == proposal.id
            && selection == proposal.draftSessionID
            && (capabilities?.sessionId ?? selection) == proposal.sessionID
            && connection.serverID == proposal.serverID && connection.address == proposal.address
            && connection.deviceID == proposal.deviceID
            && draftRevisions[proposal.draftSessionID, default: 0] == proposal.draftRevision
            && drafts[proposal.draftSessionID] == proposal.text
            && (draftImages[proposal.draftSessionID] ?? []).isEmpty
            && (draftMentions[proposal.draftSessionID] ?? []).isEmpty
    }

    func reconcile(_ connection: PadConnection) async {
        guard let key = reconciliationKey(connection) else { return }
        _ = await queryReceipt(connection, key: key)
    }

    func reconciliationKey(_ connection: PadConnection) -> ReceiptReconciliationKey? {
        guard connection.connected, let pending,
              pending.serverID == connection.serverID, pending.address == connection.address else { return nil }
        return ReceiptReconciliationKey(requestID: pending.requestID, serverID: pending.serverID,
            address: pending.address, deviceID: connection.deviceID)
    }

    /// Foreground-owned, finite backoff. Queries only: never replays the POST.
    func reconcileAutomatically(_ connection: PadConnection,
                                delays: [Duration] = [.seconds(3)]) async {
        guard let key = reconciliationKey(connection) else { return }
        let run = UUID()
        reconciliationRun = run
        automaticReconciliationActive = true
        defer {
            if reconciliationRun == run {
                reconciliationRun = nil
                automaticReconciliationActive = false
            }
        }
        for delay in delays {
            do { try await Task.sleep(for: delay) } catch { return }
            guard !Task.isCancelled, reconciliationRun == run, reconciliationKey(connection) == key else { return }
            guard await queryReceipt(connection, key: key) else { return }
        }
        guard !Task.isCancelled, reconciliationRun == run, reconciliationKey(connection) == key else { return }
        status = "暂时无法确认请求结果。已停止自动核对，可稍后查询回执；不会自动重发。"
    }

    /// Returns whether another query may help. Reads do not take the global UI lock.
    private func queryReceipt(_ connection: PadConnection, key: ReceiptReconciliationKey) async -> Bool {
        guard !Task.isCancelled, reconciliationKey(connection) == key else { return false }
        guard !receiptReadInFlight else { return true }
        receiptReadInFlight = true
        defer { receiptReadInFlight = false }
        do {
            let api = ClientSessionAPI(transport: try await connection.transport())
            let receipt = try await api.receipt(requestId: key.requestID)
            guard !Task.isCancelled, reconciliationKey(connection) == key else { return false }
            settle(receipt)
            if pending == nil {
                inventoryDirty = true; messagesDirty = true
                scheduleRefresh(connection)
                return false
            }
        } catch is CancellationError {
            return false
        } catch {
            guard !Task.isCancelled, reconciliationKey(connection) == key else { return false }
            // Denial is not proof of non-delivery. Preserve identity and stop
            // automatic reads until access is restored by the user.
            var denied = (error as? ClientServiceFailure).map { [401, 403].contains($0.statusCode) } == true
            if let failure = error as? ClientConnectionError,
               case .httpStatus(let statusCode) = failure {
                denied = [401, 403].contains(statusCode)
            }
            if denied {
                status = PadConnection.explain(error)
                return false
            }
            if !automaticReconciliationActive { status = PadConnection.explain(error) }
        }
        return true
    }

    func settle(_ receipt: ClientCommandReceipt) {
        guard let pending, receipt.requestId == pending.requestID, receipt.sessionId == pending.sessionID,
              receipt.kind == pending.kind else {
            status = "回执与本机请求不一致，保留待核对记录。"
            return
        }
        if receipt.kind == "conversation_command", receipt.status == "completed" {
            let draftSessionID = pending.draftSessionID ?? receipt.sessionId
            clearSubmittedDraft(requestID: receipt.requestId)
            if receipt.commandResult?.conversationCleared == true {
                for item in outgoingMessages.removeValue(forKey: draftSessionID) ?? [] {
                    outgoingStates.removeValue(forKey: item.id)
                }
                if selection == draftSessionID {
                    clearSelectionState()
                    messageRevision += 1
                }
            }
            // Receipt and realtime event are two deliveries of the SAME row.
            // Do not fabricate a user message or a model Processing state.
            if let result = receipt.commandResult, let messageID = result.messageId {
                let item = ClientMessage(commandMessageID: messageID, result: result)
                outgoingMessages[draftSessionID] = Self.merge(outgoingMessages[draftSessionID] ?? [], [item])
                if selection == draftSessionID { scrollRequest += 1 }
            }
            status = ""
            inventoryDirty = true; messagesDirty = true
            forgetPending()
        } else if receipt.status == "accepted" || receipt.status == "stop_requested" {
            if receipt.kind == "send" {
                let draftSessionID = pending.draftSessionID ?? receipt.sessionId
                clearSubmittedDraft(requestID: receipt.requestId)
                if selection == draftSessionID { scrollRequest += 1 }
            }
            status = ""
            // Acceptance confirms receipt only, not model execution.
            if let messageID = outgoingRequestIDs.removeValue(forKey: receipt.requestId), outgoingStates[messageID] != nil {
                outgoingStates[messageID] = "Sent"
            }
            forgetPending()
        } else if ["rejected", "failed", "cancelled"].contains(receipt.status) {
            finishRejectedRequest(requestID: receipt.requestId,
                message: receipt.status == "cancelled" ? "请求已取消" : "操作失败（\(receipt.errorCode ?? receipt.status)）")
        } else if receipt.status == "dispatching" {
            // Server acknowledgement of dispatch is not model execution.
            if let messageID = outgoingRequestIDs[receipt.requestId], outgoingStates[messageID] != nil {
                outgoingStates[messageID] = "Sending"
            }
            status = ""
        } else {
            if let messageID = outgoingRequestIDs[receipt.requestId], outgoingStates[messageID] != nil {
                outgoingStates[messageID] = "送达状态未确认"
            }
            status = automaticReconciliationActive ? "" : "暂时无法确认请求是否已送达，请查询回执。不会自动重发。"
        }
    }

    func captureSubmission(requestID: String, sessionID: String) {
        submissions[requestID] = submissionSnapshot(sessionID: sessionID)
    }

    private func submissionSnapshot(sessionID: String) -> SubmissionSnapshot {
        SubmissionSnapshot(sessionID: sessionID,
            textRevision: draftRevisions[sessionID, default: 0],
            imageIDs: (draftImages[sessionID] ?? []).map(\.id),
            mentions: (draftMentions[sessionID] ?? []).map { "\($0.id):\($0.displayName)" })
    }

    private func clearSubmittedDraft(requestID: String) {
        // No snapshot survives process restart: never erase a newly entered draft
        // on the basis of an old persisted request identity alone.
        guard let snapshot = submissions[requestID],
              draftRevisions[snapshot.sessionID, default: 0] == snapshot.textRevision,
              (draftImages[snapshot.sessionID] ?? []).map(\.id) == snapshot.imageIDs,
              (draftMentions[snapshot.sessionID] ?? []).map({ "\($0.id):\($0.displayName)" }) == snapshot.mentions else { return }
        drafts[snapshot.sessionID] = ""
        draftImages[snapshot.sessionID] = []
        draftMentions[snapshot.sessionID] = []
    }

    @discardableResult
    func rejectBeforeDispatch(_ error: Error, requestID: String) -> Bool {
        // These device-gateway codes are emitted before dispatch/journalling.
        // HTTP status alone is NOT proof; conflicts and uncertain failures keep
        // their original request identity for reconciliation, never replay.
        guard pending?.requestID == requestID, let failure = error as? ClientServiceFailure,
              ["INVALID_MESSAGE", "INVALID_COMMAND", "INVALID_IMAGES", "INVALID_MENTIONS",
               "INVALID_SCHEDULE", "CAPABILITY_UNSUPPORTED", "DEVICE_PERMISSION_REQUIRED",
               "INVALID_COMMAND_ARGUMENTS", "PROVIDER_COMMAND_UNSUPPORTED", "COMMAND_CONFIRMATION_REQUIRED",
               "SESSION_NOT_AVAILABLE", "COMMAND_JOURNAL_FULL", "ROUTE_NOT_AVAILABLE"].contains(failure.code) else { return false }
        finishRejectedRequest(requestID: requestID, message: PadConnection.explain(failure))
        return true
    }

    private func finishRejectedRequest(requestID: String, message: String) {
        guard pending?.requestID == requestID else { return }
        if let id = outgoingRequestIDs.removeValue(forKey: requestID), outgoingStates[id] != nil {
            outgoingStates[id] = "发送失败：\(message)"
        }
        status = message
        forgetPending()
    }

    func forgetPending() {
        if let pending { submissions.removeValue(forKey: pending.requestID) }
        pending = nil
        defaults.removeObject(forKey: "pendingCommand")
    }
}
