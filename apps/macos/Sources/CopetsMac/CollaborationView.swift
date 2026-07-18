import SwiftUI

@MainActor
final class CollaborationViewModel: ObservableObject {
    @Published private(set) var agents: [CollaborationAgent] = []
    @Published private(set) var services: [CollaborationService] = []
    @Published private(set) var tasks: [CollaborationTask] = []
    @Published private(set) var selectedTask: CollaborationTask?
    @Published private(set) var selectedDeliveries: [CollaborationDelivery] = []
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?

    private let baseURL = CorptieAppEnvironment.backendBaseURL

    func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response: CollaborationOverviewResponse = try await get("collaboration/overview")
            agents = response.agents
            services = response.services
            tasks = response.tasks
            errorMessage = nil
            if let taskId = selectedTask?.taskId,
               tasks.contains(where: { $0.taskId == taskId }) {
                await loadTask(taskId)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadTask(_ taskId: String) async {
        do {
            let response: CollaborationTaskResponse = try await get("collaboration/tasks/\(taskId)")
            selectedTask = response.task
            selectedDeliveries = response.deliveries ?? []
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func clearTaskSelection() {
        selectedTask = nil
        selectedDeliveries = []
    }

    func createService(
        serviceId: String,
        name: String,
        description: String,
        ownerAgentId: String,
        version: String,
        endpoint: String
    ) async -> Bool {
        do {
            let _: CollaborationServiceResponse = try await send(
                "collaboration/services",
                method: "POST",
                body: [
                    "serviceId": serviceId,
                    "name": name,
                    "description": description,
                    "ownerAgentId": ownerAgentId,
                    "currentVersion": version,
                    "status": "unknown",
                    "endpoint": endpoint
                ]
            )
            await refresh()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func cancelSelectedTask(reason: String) async {
        guard let taskId = selectedTask?.taskId else { return }
        do {
            let response: CollaborationTaskResponse = try await send(
                "collaboration/tasks/\(taskId)/interventions/cancel",
                method: "POST",
                body: ["reason": reason]
            )
            selectedTask = response.task
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func retry(_ delivery: CollaborationDelivery) async {
        do {
            let _: CollaborationDeliveryResponse = try await send(
                "collaboration/deliveries/\(delivery.deliveryId)/retry",
                method: "POST",
                body: nil
            )
            if let taskId = selectedTask?.taskId { await loadTask(taskId) }
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func get<Response: Decodable>(_ path: String) async throws -> Response {
        let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: path))
        return try decode(data: data, response: response)
    }

    private func send<Response: Decodable>(
        _ path: String,
        method: String,
        body: [String: Any]?
    ) async throws -> Response {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        return try decode(data: data, response: response)
    }

    private func decode<Response: Decodable>(data: Data, response: URLResponse) throws -> Response {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(BackendErrorResponse.self, from: data).error)
                ?? "The collaboration request failed."
            throw BackendError.message(message)
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }
}

private enum CollaborationSection: String, CaseIterable, Identifiable {
    case inbox
    case verification
    case escalated
    case allTasks
    case agents
    case services

    var id: String { rawValue }

    @MainActor var title: String {
        switch self {
        case .inbox: L10n("Waiting for handling")
        case .verification: L10n("Waiting for verification")
        case .escalated: L10n("Needs user attention")
        case .allTasks: L10n("All tasks")
        case .agents: L10n("Agents")
        case .services: L10n("Services")
        }
    }

    var symbol: String {
        switch self {
        case .inbox: "tray.full"
        case .verification: "checkmark.seal"
        case .escalated: "exclamationmark.triangle"
        case .allTasks: "clock.arrow.circlepath"
        case .agents: "person.2"
        case .services: "shippingbox"
        }
    }
}

struct CollaborationView: View {
    @ObservedObject private var appLanguage = AppLanguageController.shared
    @StateObject private var model = CollaborationViewModel()
    @State private var section: CollaborationSection? = .inbox
    @State private var selectedTaskId: String?
    @State private var isAddingService = false

    var body: some View {
        NavigationSplitView {
            List(selection: $section) {
                Section(L10n("Work")) {
                    sidebarRow(.inbox, count: model.tasks.filter(\.isWaitingForHandling).count)
                    sidebarRow(.verification, count: model.tasks.filter(\.isWaitingForVerification).count)
                    sidebarRow(.escalated, count: model.tasks.filter(\.needsUserAttention).count)
                    sidebarRow(.allTasks, count: model.tasks.count)
                }
                Section(L10n("Registry")) {
                    sidebarRow(.agents, count: model.agents.count)
                    sidebarRow(.services, count: model.services.count)
                }
            }
            .navigationTitle(L10n("Collaboration"))
        } content: {
            content
                .navigationTitle(section?.title ?? L10n("Collaboration"))
                .toolbar {
                    ToolbarItemGroup {
                        if section == .services {
                            Button { isAddingService = true } label: {
                                Label(L10n("Register Service"), systemImage: "plus")
                            }
                        }
                        Button { Task { await model.refresh() } } label: {
                            Label(L10n("Refresh"), systemImage: "arrow.clockwise")
                        }
                    }
                }
        } detail: {
            if let task = model.selectedTask {
                CollaborationTaskDetailView(task: task, deliveries: model.selectedDeliveries, model: model)
            } else {
                ContentUnavailableView(L10n("Select a collaboration task"), systemImage: "arrow.left.and.right")
            }
        }
        .frame(minWidth: 980, minHeight: 620)
        .task { await model.refresh() }
        .onChange(of: selectedTaskId) { _, taskId in
            guard let taskId else {
                model.clearTaskSelection()
                return
            }
            Task { await model.loadTask(taskId) }
        }
        .onChange(of: section) { _, _ in
            selectedTaskId = nil
        }
        .sheet(isPresented: $isAddingService) {
            RegisterServiceView(model: model, isPresented: $isAddingService)
        }
        .overlay(alignment: .bottom) {
            if let error = model.errorMessage {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(.red, in: Capsule())
                    .padding()
            }
        }
        .environment(\.locale, appLanguage.locale)
    }

    @ViewBuilder
    private var content: some View {
        switch section ?? .inbox {
        case .agents:
            CollaborationAgentList(agents: model.agents)
        case .services:
            CollaborationServiceList(services: model.services, agents: model.agents)
        case .inbox:
            taskList(model.tasks.filter(\.isWaitingForHandling))
        case .verification:
            taskList(model.tasks.filter(\.isWaitingForVerification))
        case .escalated:
            taskList(model.tasks.filter(\.needsUserAttention))
        case .allTasks:
            taskList(model.tasks)
        }
    }

    private func sidebarRow(_ item: CollaborationSection, count: Int) -> some View {
        Label {
            HStack {
                Text(item.title)
                Spacer()
                Text("\(count)").foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: item.symbol)
        }
        .tag(item)
    }

    private func taskList(_ tasks: [CollaborationTask]) -> some View {
        List(tasks, selection: $selectedTaskId) { task in
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(task.title).font(.headline)
                    Spacer()
                    CollaborationStatusBadge(status: task.status)
                }
                Text(task.summary).lineLimit(2).foregroundStyle(.secondary)
                HStack {
                    Text(task.type.replacingOccurrences(of: "_", with: " "))
                    Spacer()
                    Text(L10nFormat("Iteration %lld/%lld", task.iteration, task.maxIterations))
                }
                .font(.caption)
                .foregroundStyle(.tertiary)
            }
            .padding(.vertical, 5)
            .tag(task.taskId)
        }
        .overlay {
            if tasks.isEmpty {
                ContentUnavailableView(L10n("No tasks in this view"), systemImage: "checkmark.circle")
            }
        }
    }
}

private struct CollaborationAgentList: View {
    let agents: [CollaborationAgent]

    var body: some View {
        List(agents) { agent in
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Image(systemName: "person.crop.circle.fill")
                        .font(.title2)
                        .foregroundStyle(agent.status == "available" ? .green : .secondary)
                    VStack(alignment: .leading) {
                        Text(agent.name).font(.headline)
                        Text(agent.agentId).font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                    Spacer()
                    CollaborationStatusBadge(status: agent.status)
                }
                Text(agent.description).foregroundStyle(.secondary)
                if let session = agent.currentSessionId {
                    Label(session, systemImage: "bubble.left.and.bubble.right")
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                }
                Text(agent.capabilities.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .padding(.vertical, 6)
        }
    }
}

private struct CollaborationServiceList: View {
    let services: [CollaborationService]
    let agents: [CollaborationAgent]

    var body: some View {
        List(services) { service in
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(service.name).font(.headline)
                    Spacer()
                    CollaborationStatusBadge(status: service.status)
                }
                Text(service.description).foregroundStyle(.secondary)
                Label(ownerName(service.ownerAgentId), systemImage: "person.crop.circle")
                    .font(.caption)
                HStack {
                    if let version = service.currentVersion { Text("v\(version)") }
                    if let endpoint = service.endpoint { Text(endpoint).textSelection(.enabled) }
                }
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
            }
            .padding(.vertical, 6)
        }
        .overlay {
            if services.isEmpty {
                ContentUnavailableView(L10n("No services registered"), systemImage: "shippingbox")
            }
        }
    }

    private func ownerName(_ id: String) -> String {
        agents.first(where: { $0.agentId == id })?.name ?? id
    }
}

private struct CollaborationTaskDetailView: View {
    let task: CollaborationTask
    let deliveries: [CollaborationDelivery]
    @ObservedObject var model: CollaborationViewModel
    @State private var cancellationReason = "Canceled by the user after reviewing the collaboration timeline."
    @State private var confirmsCancellation = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(task.title).font(.title2.bold())
                        Text(task.summary).foregroundStyle(.secondary)
                    }
                    Spacer()
                    CollaborationStatusBadge(status: task.status)
                }

                GroupBox(L10n("Participants")) {
                    LabeledContent(L10n("Initiator"), value: task.initiatorAgentId)
                    LabeledContent(L10n("Recipient"), value: task.recipientAgentId)
                    if let serviceId = task.serviceId { LabeledContent(L10n("Service"), value: serviceId) }
                    LabeledContent(L10n("Iteration"), value: L10nFormat("%lld of %lld", task.iteration, task.maxIterations))
                }

                GroupBox(L10n("Acceptance criteria")) {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(task.acceptanceCriteria, id: \.self) { criterion in
                            Label(criterion, systemImage: "checkmark.circle")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                Text(L10n("Timeline")).font(.headline)
                ForEach(timeline) { entry in
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: entry.isMessage ? "bubble.left.fill" : "circle.fill")
                            .font(entry.isMessage ? .body : .system(size: 7))
                            .frame(width: 22, height: 22)
                            .foregroundStyle(entry.isMessage ? .blue : .secondary)
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(entry.title).font(.subheadline.bold())
                                Spacer()
                                Text(entry.createdAt).font(.caption).foregroundStyle(.tertiary)
                            }
                            if let body = entry.body {
                                Text(body).textSelection(.enabled)
                            }
                        }
                    }
                    Divider()
                }

                if !deliveries.isEmpty {
                    Text(L10n("Deliveries")).font(.headline)
                    ForEach(deliveries) { delivery in
                        CollaborationDeliveryRow(delivery: delivery) {
                            Task { await model.retry(delivery) }
                        }
                    }
                }

                if !task.isTerminal {
                    Divider()
                    Button(L10n("Cancel task…"), role: .destructive) { confirmsCancellation = true }
                }
            }
            .padding(24)
        }
        .alert(L10n("Cancel this collaboration task?"), isPresented: $confirmsCancellation) {
            TextField(L10n("Reason"), text: $cancellationReason)
            Button(L10n("Keep task"), role: .cancel) {}
            Button(L10n("Cancel task"), role: .destructive) {
                Task { await model.cancelSelectedTask(reason: cancellationReason) }
            }
        } message: {
            Text(L10n("This is recorded as a user intervention in the task timeline."))
        }
    }

    private var timeline: [CollaborationTimelineEntry] {
        let messages = (task.messages ?? []).map {
            CollaborationTimelineEntry(
                id: "message:\($0.messageId)",
                createdAt: $0.createdAt,
                title: "\($0.senderAgentId) · \($0.messageType.replacingOccurrences(of: "_", with: " "))",
                body: $0.body,
                isMessage: true
            )
        }
        let events = (task.events ?? []).map {
            CollaborationTimelineEntry(
                id: "event:\($0.eventId)",
                createdAt: $0.createdAt,
                title: $0.type.replacingOccurrences(of: "_", with: " "),
                body: $0.actorAgentId.map { "Actor: \($0)" },
                isMessage: false
            )
        }
        return (messages + events).sorted { $0.createdAt < $1.createdAt }
    }
}

private struct CollaborationDeliveryRow: View {
    let delivery: CollaborationDelivery
    let retry: () -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(delivery.deliveryId).font(.caption.monospaced())
                Text(delivery.lastError ?? "Attempt \(delivery.attemptCount)")
                    .font(.caption)
                    .foregroundStyle(delivery.lastError == nil ? Color.secondary : Color.red)
            }
            Spacer()
            CollaborationStatusBadge(status: delivery.status)
            if delivery.status == "failed" {
                Button(L10n("Retry"), action: retry)
            }
        }
    }
}

private struct CollaborationTimelineEntry: Identifiable {
    let id: String
    let createdAt: String
    let title: String
    let body: String?
    let isMessage: Bool
}

private struct CollaborationStatusBadge: View {
    let status: String

    var body: some View {
        Text(status.replacingOccurrences(of: "_", with: " "))
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.14), in: Capsule())
            .foregroundStyle(color)
    }

    private var color: Color {
        switch status {
        case "available", "running", "completed", "delivered": .green
        case "busy", "working", "verifying", "delivering": .blue
        case "failed", "rejected", "canceled", "escalated": .red
        case "pending", "queued", "proposed", "needs_information", "revision_requested": .orange
        default: .secondary
        }
    }
}

private struct RegisterServiceView: View {
    @ObservedObject var model: CollaborationViewModel
    @Binding var isPresented: Bool
    @State private var serviceId = ""
    @State private var name = ""
    @State private var description = ""
    @State private var ownerAgentId = ""
    @State private var version = ""
    @State private var endpoint = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n("Register Service")).font(.title2.bold())
            Form {
                TextField(L10n("Service ID"), text: $serviceId)
                TextField(L10n("Name"), text: $name)
                TextField(L10n("Description"), text: $description)
                Picker(L10n("Owner"), selection: $ownerAgentId) {
                    Text(L10n("Select an Agent")).tag("")
                    ForEach(model.agents) { agent in Text(agent.name).tag(agent.agentId) }
                }
                TextField(L10n("Current version"), text: $version)
                TextField(L10n("Local endpoint"), text: $endpoint)
            }
            HStack {
                Spacer()
                Button(L10n("Cancel")) { isPresented = false }
                Button(L10n("Register")) {
                    Task {
                        if await model.createService(
                            serviceId: serviceId,
                            name: name,
                            description: description,
                            ownerAgentId: ownerAgentId,
                            version: version,
                            endpoint: endpoint
                        ) {
                            isPresented = false
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(serviceId.isEmpty || name.isEmpty || ownerAgentId.isEmpty)
            }
        }
        .padding(24)
        .frame(width: 480)
    }
}

private extension CollaborationTask {
    var isWaitingForHandling: Bool {
        ["proposed", "accepted", "working", "needs_information", "revision_requested"].contains(status)
    }

    var isWaitingForVerification: Bool {
        ["delivered", "verifying"].contains(status)
    }

    var needsUserAttention: Bool {
        status == "escalated"
    }

    var isTerminal: Bool {
        ["completed", "rejected", "canceled", "escalated"].contains(status)
    }
}
