import Foundation
import CryptoKit
import Observation
import CorptieClientCore

struct PadTaskDraft: Codable {
    var title = ""
    var description = ""
    var acceptanceCriteria = ""
    var verificationCriteria = ""
    var agentID = ""
    var providerID = ""
    var model = ""
    var reasoning = ""
    var priority = "medium"
}

@MainActor @Observable
final class PadTaskCreationState {
    struct Pending: Codable {
        let sourceSessionID: String
        let input: ClientTaskCreation
    }
    private struct Record: Codable {
        let draft: PadTaskDraft
        let pending: Pending?
        let result: ClientTaskCreationResult?
    }
    let workID: String
    let sourceSessionID: String
    private let serverID: String
    private let address: String
    private let deviceID: String?
    private let defaults: UserDefaults
    private let storageKey: String
    var draft = PadTaskDraft() { didSet { scheduleSave() } }
    private(set) var pending: Pending?
    private(set) var result: ClientTaskCreationResult?
    private(set) var options: ClientTaskCreationOptions?
    private(set) var loading = false
    private(set) var submitting = false
    private(set) var checking = false
    private(set) var recoveryBlocked = false
    private(set) var reconciliationDenied = false
    var notice = ""
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private var optionsGeneration = 0

    init(workID: String, sourceSessionID: String, connection: PadConnection, defaults: UserDefaults = .standard) {
        self.workID = workID; self.sourceSessionID = sourceSessionID
        serverID = connection.serverID; address = connection.address; deviceID = connection.deviceID
        self.defaults = defaults
        let keyData = try! JSONEncoder().encode([serverID, address, deviceID ?? "", workID])
        storageKey = "taskCreation:" + SHA256.hash(data: keyData).map { String(format: "%02x", $0) }.joined()
        if let data = defaults.data(forKey: storageKey) {
            if let record = try? JSONDecoder().decode(Record.self, from: data) {
                draft = record.draft; pending = record.pending; result = record.result
            } else {
                recoveryBlocked = true
                notice = "无法读取本地创建记录。为避免重复创建，已停止提交，请保留记录并检查。"
            }
        }
    }

    func matches(_ connection: PadConnection) -> Bool {
        connection.serverID == serverID && connection.address == address && connection.deviceID == deviceID
    }

    var canSubmit: Bool {
        guard !submitting, !loading, pending == nil, result == nil, !recoveryBlocked,
              let options, options.work.id == workID, options.providerId == draft.providerID,
              options.agents.contains(where: { $0.id == draft.agentID }),
              options.providers.contains(where: { $0.id == draft.providerID && $0.available }),
              options.priorities.contains(draft.priority) else { return false }
        let title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.utf16.count <= 512,
              title.range(of: "^[A-Za-z0-9\\p{Han}]+$", options: .regularExpression) != nil,
              [draft.description, draft.acceptanceCriteria, draft.verificationCriteria].allSatisfy({ $0.utf16.count <= 16000 }) else { return false }
        if !draft.model.isEmpty {
            guard let model = options.models.first(where: { $0.id == draft.model }),
                  draft.reasoning.isEmpty || model.reasoningLevels.contains(draft.reasoning) else { return false }
        } else if !draft.reasoning.isEmpty { return false }
        return true
    }

    func selectProvider(_ id: String) {
        guard pending == nil else { return }
        draft.providerID = id; draft.model = ""; draft.reasoning = ""; options = nil
    }

    func loadOptions(_ connection: PadConnection) async {
        guard matches(connection), pending == nil, !recoveryBlocked else { return }
        optionsGeneration += 1
        let generation = optionsGeneration, provider = draft.providerID
        loading = true; notice = ""
        defer { if generation == optionsGeneration { loading = false } }
        do {
            let api = ClientSessionAPI(transport: try await connection.transport())
            guard matches(connection), !Task.isCancelled else { return }
            let next = try await api.taskCreationOptions(sourceSessionId: sourceSessionID,
                providerId: provider.isEmpty ? nil : provider)
            guard matches(connection), !Task.isCancelled, generation == optionsGeneration,
                  draft.providerID == provider else { return }
            guard next.work.id == workID else { throw ClientConnectionError.invalidResponse }
            options = next
            if !next.agents.contains(where: { $0.id == draft.agentID }) { draft.agentID = next.agents.first?.id ?? "" }
            if provider.isEmpty { draft.providerID = next.defaultProviderId ?? next.providers.first(where: \.available)?.id ?? "" }
            if !next.priorities.contains(draft.priority) { draft.priority = next.priorities.first ?? "" }
        } catch {
            guard generation == optionsGeneration, matches(connection), !Task.isCancelled else { return }
            options = nil; notice = PadConnection.explain(error)
        }
    }

    func submit(_ connection: PadConnection) async {
        guard matches(connection), canSubmit else { return }
        submitting = true; notice = ""
        defer { submitting = false }
        var input = ClientTaskCreation(requestId: UUID().uuidString, workId: workID,
            title: draft.title.trimmingCharacters(in: .whitespacesAndNewlines), mainAgentId: draft.agentID, providerId: draft.providerID)
        input.description = draft.description; input.acceptanceCriteria = draft.acceptanceCriteria
        input.verificationCriteria = draft.verificationCriteria; input.priority = draft.priority
        input.model = draft.model.isEmpty ? nil : draft.model
        input.reasoningLevel = draft.reasoning.isEmpty ? nil : draft.reasoning
        do {
            let api = ClientSessionAPI(transport: try await connection.transport())
            guard matches(connection), !Task.isCancelled, pending == nil else { return }
            pending = Pending(sourceSessionID: sourceSessionID, input: input)
            flush()
            let receipt = try await api.createTask(sourceSessionId: sourceSessionID, input: input)
            guard matches(connection) else { return }
            accept(receipt)
        } catch {
            guard matches(connection), result == nil else { return }
            // Only codes guaranteed to precede dispatch permit another submission.
            let rejectedCodes: Set<String> = ["DEVICE_PERMISSION_REQUIRED", "INVALID_CREDENTIAL", "INVALID_TASK_CREATION",
                "INVALID_ENTITY_NAME", "INVALID_FIELD_TYPE", "INVALID_PRIORITY", "TASK_OUTSIDE_WORK", "AGENT_OUTSIDE_WORK",
                "AGENT_NOT_FOUND", "SOURCE_SESSION_CHANGED", "SOURCE_SESSION_NOT_FOUND", "SESSION_NOT_AVAILABLE",
                "PROVIDER_CAPABILITY_UNAVAILABLE", "CAPABILITY_UNSUPPORTED", "ROUTE_NOT_AVAILABLE", "COMMAND_JOURNAL_FULL"]
            if let error = error as? ClientServiceFailure, rejectedCodes.contains(error.code) {
                pending = nil; flush(); notice = PadConnection.explain(error)
            } else {
                notice = pending == nil ? PadConnection.explain(error) : "创建结果尚未确认；已保留请求，不会重复提交。"
            }
        }
    }

    func reconcile(_ connection: PadConnection) async {
        guard matches(connection), let pending, result == nil, !checking else { return }
        checking = true
        defer { checking = false }
        do {
            let api = ClientSessionAPI(transport: try await connection.transport())
            guard matches(connection), !Task.isCancelled else { return }
            let receipt = try await api.receipt(requestId: pending.input.requestId)
            guard matches(connection), !Task.isCancelled else { return }
            reconciliationDenied = false
            accept(receipt)
        } catch {
            guard matches(connection), !Task.isCancelled else { return }
            if let failure = error as? ClientServiceFailure,
               ["DEVICE_PERMISSION_REQUIRED", "INVALID_CREDENTIAL"].contains(failure.code) {
                reconciliationDenied = true
            }
            if let failure = error as? ClientConnectionError,
               failure == .httpStatus(401) || failure == .httpStatus(403) { reconciliationDenied = true }
            notice = "暂时无法核对创建结果；请求与草稿已保留，请勿重复创建。"
        }
    }

    func acceptPushed(_ receipt: ClientCommandReceipt) {
        guard pending?.input.requestId == receipt.requestId else { return }
        accept(receipt)
    }

    private func accept(_ receipt: ClientCommandReceipt) {
        guard result == nil else { return }
        guard let pending, receipt.requestId == pending.input.requestId, receipt.kind == "create_task",
              receipt.sessionId == pending.sourceSessionID else {
            notice = "创建回执不匹配，已保留原请求。"; return
        }
        if receipt.status == "completed", let value = receipt.taskResult, value.workId == workID,
           !value.taskId.isEmpty, !value.sessionId.isEmpty {
            result = value; notice = "Task 与配套会话已创建。"; flush()
        } else {
            notice = receipt.status == "dispatching" ? "正在创建 Task 与配套会话…" : "创建结果尚未确认；请核对已有 Task，不要重复提交。"
        }
    }

    func startAnother() {
        guard result != nil, !submitting else { return }
        result = nil; pending = nil; draft = PadTaskDraft(); options = nil; notice = ""; flush()
    }

    func flush() {
        saveTask?.cancel(); saveTask = nil
        guard !recoveryBlocked, let data = try? JSONEncoder().encode(Record(draft: draft, pending: pending, result: result)) else { return }
        defaults.set(data, forKey: storageKey)
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            self?.flush()
        }
    }
}
