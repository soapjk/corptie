import Foundation
import Combine
import CorptieClientCore

/// Frozen intent, independent of selection or subsequent editor changes. These
/// identities are reused by the existing backend creation and delivery journals.
struct UnifiedCreationSubmission {
    let requestID: String
    let messageID: String
    let deliveryID: String
    let text: String
    let imageURLs: [URL]
    let workID: String?
    let parentTaskID: String?
    let sourceSessionID: String?
    let roleID: String
    let providerID: String
    let modelID: String
    let permission: ComposerPermissionChoice
    let serviceTier: String
    let supportsPermissions: Bool
    let supportsServiceTier: Bool
}

enum UnifiedCreationStage: String {
    case idle, creatingTask, creatingChat, worktreePrepared, sessionBound, providerBound, permissions, serviceTier, images, sending, completed

    var title: String {
        switch self {
        case .idle: "准备发送"
        case .creatingTask: "正在创建任务并准备工作区和执行引擎…"
        case .creatingChat: "正在创建会话并准备执行引擎…"
        case .worktreePrepared: "工作区已就绪，正在创建会话…"
        case .sessionBound: "会话已创建，正在绑定执行引擎…"
        case .providerBound: "正在启用执行引擎…"
        case .permissions: "正在应用权限…"
        case .serviceTier: "正在应用运行模式…"
        case .images: "正在添加图片…"
        case .sending: "正在确认首条消息…"
        case .completed: "消息已接收"
        }
    }
}

@MainActor
protocol UnifiedCreationServing {
    func create(_ input: UnifiedCreationSubmission, progress: @escaping (UnifiedCreationStage) -> Void) async throws -> TaskSession
    func configure(_ session: TaskSession, route: String, values: [String: String]) async throws -> TaskSession
    func importImage(_ url: URL, session: TaskSession) async throws -> ChatImageReference
    func send(_ input: UnifiedCreationSubmission, session: TaskSession, images: [ChatImageReference]) async throws
}

extension UnifiedCreationDraft {
    /// Publish the conversation presentation synchronously, before any I/O.
    /// The Task belongs to the retained draft, not to a view's appearance task.
    func start(_ input: UnifiedCreationSubmission, service: any UnifiedCreationServing) {
        guard !busy, stage != .completed else { return }
        if submission == nil { submission = input }
        if creationService == nil { creationService = service }
        guard let submission, let service = creationService else { return }
        submissionStarted = true
        busy = true
        error = nil
        stage = createdSession == nil ? (submission.workID == nil ? .creatingChat : .creatingTask) : stage
        operationTask = Task { @MainActor in
            defer { busy = false; operationTask = nil }
            // Give the committed presentation a chance to mount before starting
            // even the local request preparation. No synchronous file reads.
            await Task.yield()
            do {
                var session: TaskSession
                if let createdSession { session = createdSession }
                else {
                    session = try await service.create(submission) { self.stage = $0 }
                    createdSession = session
                }
                if !permissionsApplied {
                    if submission.supportsPermissions {
                        stage = .permissions
                        session = try await service.configure(session, route: "permissions", values: [
                            "sandbox": submission.permission.sandbox, "approvalPolicy": submission.permission.approval
                        ])
                        createdSession = session
                    }
                    permissionsApplied = true
                }
                if !serviceTierApplied {
                    if submission.supportsServiceTier {
                        stage = .serviceTier
                        session = try await service.configure(session, route: "service-tier", values: ["serviceTier": submission.serviceTier])
                        createdSession = session
                    }
                    serviceTierApplied = true
                }
                configurationApplied = true
                while importedImages.count < submission.imageURLs.count {
                    stage = .images
                    importedImages.append(try await service.importImage(submission.imageURLs[importedImages.count], session: session))
                }
                stage = .sending
                try await service.send(submission, session: session, images: importedImages)
                stage = .completed
            } catch {
                // Keep the real stage, frozen intent, completed preparation and
                // all identities. An uncertain receipt must never start a new operation.
                self.error = error.localizedDescription
            }
        }
    }

    func claimVisibleCompletion() -> TaskSession? {
        guard isPresented, stage == .completed, !completionClaimed, let createdSession else { return nil }
        completionClaimed = true
        return createdSession
    }
}

@MainActor
final class UnifiedCreationService: UnifiedCreationServing {
    let backend: BackendClient
    let urlSession: URLSession
    private var taskCreationAttempted = false
    private var recoveryOperationID: String?

    init(backend: BackendClient, urlSession: URLSession = .shared) {
        self.backend = backend
        self.urlSession = urlSession
    }

    func create(_ input: UnifiedCreationSubmission, progress: @escaping (UnifiedCreationStage) -> Void) async throws -> TaskSession {
        let data: Data
        if let workID = input.workID {
            guard let source = input.sourceSessionID else {
                throw BackendError.message(L10n("所属 Work 没有可用于创建 CorptieTask 的 Session。"))
            }
            let observation = UnifiedCreationProgressEvents.updates
                .filter { $0.taskID == "task:\(input.requestID)" }
                .sink { progress($0.stage) }
            defer { observation.cancel() }
            if taskCreationAttempted { try await recoverTaskIfSafe(input, source: source) }
            taskCreationAttempted = true
            var fields: [String: Any] = ["id": "task:\(input.requestID)", "workId": workID,
                "title": "新任务_\(input.requestID.prefix(6))", "mainAgentId": input.roleID,
                "providerId": input.providerID, "sourceSessionId": source, "idempotencyKey": "task:\(input.requestID)"]
            if !input.modelID.isEmpty { fields["model"] = input.modelID }
            if let parent = input.parentTaskID { fields["parentTaskId"] = parent }
            data = try await post("tasks", fields: fields, headers: [
                "X-Corptie-Logical-Session-Id": source, "X-Corptie-Operation-Id": "task:\(input.requestID)"
            ])
            // The response already contains the committed Session. Waiting for
            // a full application snapshot here added a needless serial round trip.
            let result = try JSONDecoder().decode(CreatedTask.self, from: data)
            backend.acceptCreatedSession(result.session, selectImmediately: false)
            return result.session
        }
        data = try await post("desktop/chats/create", fields: ["requestId": input.requestID,
            "title": "新对话", "agentId": input.roleID, "providerId": input.providerID, "model": input.modelID])
        let result = try JSONDecoder().decode(CreatedChat.self, from: data)
        guard result.receipt.status == "completed", let session = result.session else {
            throw BackendError.message(L10n("创建结果未确认，重试将查询原操作，不会重新创建。"))
        }
        backend.acceptCreatedSession(session, selectImmediately: false)
        return session
    }

    func configure(_ session: TaskSession, route: String, values: [String: String]) async throws -> TaskSession {
        try await backend.configureComposer(session: session, route: route, values: values)
    }

    func importImage(_ url: URL, session: TaskSession) async throws -> ChatImageReference {
        try await backend.importChatImage(at: url, to: session, preserveOriginal: false)
    }

    func send(_ input: UnifiedCreationSubmission, session: TaskSession, images: [ChatImageReference]) async throws {
        _ = try await post("sessions/\(session.id)/messages", fields: ["text": input.text,
            "messageId": input.messageID, "deliveryId": input.deliveryID,
            "images": images.map { ["managedPath": $0.managedPath] }, "mentions": [], "isChoiceSelection": false])
    }

    private func post(_ path: String, fields: [String: Any], headers: [String: String] = [:]) async throws -> Data {
        try await request(path, fields: fields, headers: headers)
    }

    /// Only an explicit retry enters recovery. Reuse the existing compensation
    /// and exact-operation gate; a lost recovery response retains its identity.
    private func recoverTaskIfSafe(_ input: UnifiedCreationSubmission, source: String) async throws {
        let path = "tasks/task:\(input.requestID)/startup-recovery"
        let headers = ["X-Corptie-Logical-Session-Id": source]
        if recoveryOperationID == nil {
            // Creation may have failed before persistence. In that case replay
            // the original create command, which revalidates its authorization.
            if let data = try? await request(path, fields: nil, headers: headers),
               let state = try? JSONDecoder().decode(TaskRecovery.self, from: data), state.canRetry {
                recoveryOperationID = state.startupOperationId
            }
        }
        guard let operationID = recoveryOperationID else { return }
        let data = try await post(path, fields: ["startupOperationId": operationID], headers: headers)
        let state = try JSONDecoder().decode(TaskRecovery.self, from: data)
        if state.status == "ready" {
            recoveryOperationID = nil
            return // Read the committed Session through the original creation receipt.
        }
        // A confirmed failure may be retried by a later click. Pending or lost
        // responses must continue to refer to this same recovery attempt.
        if state.status == "failed" { recoveryOperationID = nil }
        throw BackendError.message(state.error?.code ?? L10n("创建结果未确认，重试将查询原操作，不会重新创建。"))
    }

    private func request(_ path: String, fields: [String: Any]?, headers: [String: String]) async throws -> Data {
        var request = URLRequest(url: backend.baseURL.appending(path: path))
        request.httpMethod = fields == nil ? "GET" : "POST"
        request.timeoutInterval = 300
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        if let fields { request.httpBody = try JSONSerialization.data(withJSONObject: fields) }
        let (data, response) = try await urlSession.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else {
            throw BackendError.message(BackendClient.errorMessage(from: data) ?? L10n("操作未确认，请重试原操作。"))
        }
        return data
    }

    private struct CreatedTask: Decodable { let session: TaskSession }
    private struct CreatedChat: Decodable { let receipt: ClientCommandReceipt; let session: TaskSession? }
    private struct TaskRecovery: Decodable {
        let status: String
        let canRetry: Bool
        let startupOperationId: String?
        let error: Failure?
        struct Failure: Decodable { let code: String }
    }
}

/// Reuses the existing Backend event connection. Only a pending Task creation
/// subscribes, scoped to its exact Task ID, and cancels when the request settles.
@MainActor
enum UnifiedCreationProgressEvents {
    struct Update { let taskID: String; let stage: UnifiedCreationStage }
    static let updates = PassthroughSubject<Update, Never>()
    static func publish(taskID: String, action: String?) {
        let stage: UnifiedCreationStage
        switch action {
        case "startup-worktree_prepared": stage = .worktreePrepared
        case "startup-session_bound": stage = .sessionBound
        case "startup-provider_bound": stage = .providerBound
        default: return
        }
        updates.send(.init(taskID: taskID, stage: stage))
    }
}
