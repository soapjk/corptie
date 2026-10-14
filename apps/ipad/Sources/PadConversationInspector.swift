#if os(iOS)
import SwiftUI
import CorptieClientCore
import CorptieConversation
import CorptieClientSecurity

/// Pure resident-state projection. Opening the rail never requests a timeline.
struct PadConversationInspector: View {
    @Bindable var workspace: PadWorkspace
    let connection: PadConnection
    let sessionID: String
    let onOpenAutomation: (String) -> Void
    let entityCommands: PadEntityCommandState
    @State private var detailDocument: PadInspectorDocument?
    private struct TaskEditorDestination: Identifiable {
        let id: String
        let task: ClientTask
        let definition: ClientInspectorValue
        let scope: ClientDetailActionScope
    }
    @State private var detailTaskEditor: TaskEditorDestination?
    @Environment(\.openURL) private var openURL
    private var inspector: PadInspectorStore { workspace.inspectorStore(for: sessionID) }
    private var session: ClientSession? { workspace.sessionsByID[sessionID] }
    private var resourceScope: String {
        "\(connection.serverID):\(connection.address):\(connection.deviceID ?? ""):\(connection.cloudCurrentDeviceID?.uuidString ?? "lan"):\(sessionID)"
    }
    private var activeDetailDocumentIsCurrent: Bool {
        guard let document = detailDocument else { return true }
        guard inspector.connected, inspector.snapshot?.sessionId == sessionID else { return false }
        let kind = document.resource == "artifact" ? "artifact" : "memory"
        let id = document.value[kind == "artifact" ? "artifactId" : "id"].text ?? ""
        return inspector.snapshot?.residentDetailResource(kind: kind, id: id) != nil
    }
    private var kind: ConversationInspectorKind {
        .resolve(sessionKind: session?.sessionKind, taskID: session?.taskId, workID: session?.workId)
    }
    var body: some View {
        ConversationDetailDashboard {
            if let session {
                PadInspectorResources(store: inspector, connection: connection, sessionID: sessionID, workspace: workspace,
                    kind: kind, onOpenAutomation: onOpenAutomation) {
                    ConversationServerDetail(scope: "\(connection.serverID):\(connection.address):\(connection.deviceID ?? ""):\(connection.cloudCurrentDeviceID?.uuidString ?? "lan"):\(sessionID)",
                        sessionID: sessionID, actions: nativeDetailNavigation,
                        coordinator: { selected, canonical in try await detailCoordinator(selected: selected, canonicalSessionID: canonical) }, api: {
                            ClientDetailAPI(transport: try await connection.transport(), route: .pairedDevice)
                        })
                        .id("\(connection.serverID):\(connection.address):\(connection.deviceID ?? ""):\(connection.cloudCurrentDeviceID?.uuidString ?? "lan"):\(sessionID)")
                } secondary: {
                    primaryDetail(for: session)
                    ConversationWorktreeCard(sessionID: session.id, refreshID: session.updatedAt,
                        api: { ClientSessionWorktreeAPI(transport: try await connection.transport(), route: .pairedDevice) },
                        onJob: { job in
                            if job.status != "awaiting_confirmation" {
                                PadOperationNotifications.shared.track(job.id, resourceName: "Worktree")
                                if let notification = job.notification { PadOperationNotifications.shared.observe(notification) }
                            }
                        })
                        .id("\(connection.serverID):\(connection.address):\(session.id)")
                }
            } else {
                ContentUnavailableView("会话尚未同步", systemImage: "bubble.left.and.bubble.right")
            }
        }
        .accessibilityIdentifier("conversation-detail-inspector")
        .sheet(item: $detailDocument) { document in
            PadInspectorDocumentView(document: document, connection: connection, sessionID: sessionID, store: inspector)
        }
        .sheet(item: $detailTaskEditor) { destination in
            PadEditTaskSheet(connection: connection, commands: entityCommands, task: destination.task,
                detailDefinition: destination.definition, detailScope: destination.scope, detailSessionID: sessionID) { }
        }
        .onChange(of: inspector.connected) { _, connected in if !connected { detailDocument = nil; detailTaskEditor = nil } }
        .onChange(of: inspector.snapshot?.taskId) { _, _ in detailDocument = nil; detailTaskEditor = nil }
        .onChange(of: inspector.snapshot?.workId) { _, _ in detailDocument = nil; detailTaskEditor = nil }
        .onChange(of: activeDetailDocumentIsCurrent) { _, current in if !current { detailDocument = nil } }
        .task(id: resourceScope) {
            detailDocument = nil
            detailTaskEditor = nil
            await inspector.observe(sessionID: sessionID, connection: connection)
        }
    }
    private var nativeDetailNavigation: ConversationDetailActions {
        ConversationDetailActions(canPerform: { action in
            guard inspector.connected, inspector.snapshot?.sessionId == sessionID,
                  action.available, action.kind == "navigation",
                  let target = action.target else { return false }
            if action.operation == "editor.open" { return canOpenTaskEditor(action) }
            guard action.operation == "resource.open" else { return false }
            if target.resourceType == "schedule" { return true }
            if target.resourceType == "session" { return workspace.sessionsByID[target.id] != nil }
            if target.resourceType == "artifact" { return detailArtifact(target.id) != nil }
            if target.resourceType == "memory" { return detailMemory(target.id) != nil }
            if target.resourceType == "reference" { return detailReferenceURL(target.id) != nil }
            if target.resourceType == "task" {
                return workspace.tasks.first(where: { $0.id == target.id })?.currentSessionId != nil
            }
            return false
        }, perform: { action, _ in
            guard inspector.connected, inspector.snapshot?.sessionId == sessionID,
                  action.available, action.kind == "navigation",
                  let target = action.target else { return }
            if action.operation == "editor.open" { openTaskEditor(action); return }
            guard action.operation == "resource.open" else { return }
            switch target.resourceType {
            case "schedule": onOpenAutomation(target.id)
            case "session": if workspace.sessionsByID[target.id] != nil { workspace.selection = target.id }
            case "artifact":
                if let artifact = detailArtifact(target.id) {
                    detailDocument = .init(title: artifact["title"].text ?? "Artifact", resource: "artifact", value: artifact,
                        parameters: artifactReadParameters(artifact, taskID: inspector.snapshot?.taskId))
                }
            case "reference": if let url = detailReferenceURL(target.id) { openURL(url) }
            case "memory":
                if let memory = detailMemory(target.id) {
                    detailDocument = .init(title: "记忆审计", resource: "memory-audit", value: memory, parameters: ["id": memory["id"]])
                }
            case "task":
                if let id = workspace.tasks.first(where: { $0.id == target.id })?.currentSessionId { workspace.selection = id }
            default: break
            }
        })
    }
    private func detailArtifact(_ id: String) -> ClientInspectorValue? {
        inspector.snapshot?.residentDetailResource(kind: "artifact", id: id)
    }
    private func canOpenTaskEditor(_ action: ClientDetailAction) -> Bool {
        guard let target = action.target, target.resourceType == "task", target.id == session?.taskId,
              target.id == inspector.snapshot?.taskId, !inspector.busy, inspector.pending == nil, !entityCommands.isBusy,
              workspace.tasks.contains(where: { $0.id == target.id }),
              let revision = inspector.snapshot?.taskDefinition?["revision"].number,
              revision.isFinite, revision > 0, revision <= 9_007_199_254_740_991, revision.rounded(.down) == revision else { return false }
        return action.expectedResourceRevision == String(Int(revision))
    }
    private func openTaskEditor(_ action: ClientDetailAction) {
        guard canOpenTaskEditor(action), let target = action.target, let definition = inspector.snapshot?.taskDefinition,
              let task = workspace.tasks.first(where: { $0.id == target.id }),
              let scope = try? connection.detailActionScope(sessionID: sessionID, negotiation: .legacy) else { return }
        detailDocument = nil
        detailTaskEditor = .init(id: target.id, task: task, definition: definition, scope: scope)
    }
    private func detailMemory(_ id: String) -> ClientInspectorValue? {
        inspector.snapshot?.residentDetailResource(kind: "memory", id: id)
    }
    private func detailReferenceURL(_ id: String) -> URL? {
        guard let reference = inspector.snapshot?.residentDetailResource(kind: "reference", id: id),
              reference["enabled"] == .bool(true), reference["status"].text == "available", reference["targetType"].text == "webURL",
              let locator = reference["locator"].text, let url = URL(string: locator),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil, url.user == nil, url.password == nil else { return nil }
        return url
    }
    private func detailCoordinator(selected: ClientDetailAPI, canonicalSessionID: String) async throws -> ClientDetailActionCoordinator {
        let scope = try connection.detailActionScope(sessionID: canonicalSessionID, negotiation: selected.negotiation)
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: false).appendingPathComponent("Corptie/DetailActionRecovery", isDirectory: true)
        let journal = ClientDetailActionFileJournal(directory: directory, key: try await workspace.messageOutbox.timelinePersistenceKey())
        let transport = ClientDetailDynamicActionTransport(api: {
            let current = try await connection.detailActionScope(sessionID: canonicalSessionID, negotiation: selected.negotiation)
            guard current == scope else { throw ClientServiceFailure(statusCode: 401, code: "DETAIL_SCOPE_REVOKED") }
            return ClientDetailActionAPI(transport: try await connection.transport(), route: .pairedDevice, negotiation: selected.negotiation)
        })
        return ClientDetailActionCoordinator(scope: scope, transport: transport, journal: journal,
            navigation: .init(registrations: ["resource.open": ["session", "task", "schedule"]]))
    }
    @ViewBuilder private func primaryDetail(for session: ClientSession) -> some View {
        if kind == .work, let work = workspace.works.first(where: { $0.id == session.workId }) {
            ConversationWorkOverviewCard(description: inspector.snapshot?.workDescription ?? work.description)
            let tasks = (inspector.sections["focusTasks"]?.items ?? []).compactMap { value -> ConversationFocusTask? in
                let resident = workspace.tasks.first { $0.id == value["id"].text }
                return ConversationFocusTask(inspectorValue: value, sessionID: resident?.currentSessionId)
            }
            ConversationFocusTasksCard(tasks: tasks) { _, sessionID in
                workspace.selection = sessionID
            }
        }
    }
}
#endif
