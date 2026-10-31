import SwiftUI

@MainActor
final class CollaborationViewModel: ObservableObject {
    @Published private(set) var agents: [CollaborationAgent] = []
    @Published private(set) var services: [CollaborationService] = []
    @Published private(set) var channels: [SessionCollaborationChannel] = []
    @Published private(set) var selectedChannel: SessionCollaborationChannel?
    @Published private(set) var messages: [SessionCollaborationMessage] = []
    @Published private(set) var errorMessage: String?
    @Published private(set) var pendingMessageCount = 0
    @Published private(set) var hasOlderMessages = false
    @Published private(set) var isLoadingMessages = false
    private var selectionRequest = UUID()

    private let baseURL = CorptieAppEnvironment.backendBaseURL

    func refresh() async {
        do {
            let response: CollaborationOverviewResponse = try await get("collaboration/overview")
            agents = response.agents
            services = response.services
            channels = response.channels
            errorMessage = nil
            if let id = selectedChannel?.channelId, channels.contains(where: { $0.channelId == id }) {
                await loadChannel(id)
            }
        } catch { errorMessage = error.localizedDescription }
    }

    func loadChannel(_ id: String) async {
        let request = UUID()
        selectionRequest = request
        isLoadingMessages = true
        defer { if selectionRequest == request { isLoadingMessages = false } }
        do {
            let response: SessionCollaborationChannelResponse = try await get("collaboration/channels/\(id)")
            guard selectionRequest == request else { return }
            selectedChannel = response.channel
            messages = response.messages
            pendingMessageCount = response.pendingCount ?? 0
            hasOlderMessages = response.hasMore ?? false
            errorMessage = nil
        } catch { if selectionRequest == request { errorMessage = error.localizedDescription } }
    }

    func loadOlderMessages() async {
        guard !isLoadingMessages, let id = selectedChannel?.channelId,
              let cursor = messages.first?.cursor else { return }
        let request = selectionRequest
        isLoadingMessages = true
        defer { if selectionRequest == request { isLoadingMessages = false } }
        do {
            let response: SessionCollaborationChannelResponse = try await get(
                "collaboration/channels/\(id)", query: [URLQueryItem(name: "beforeCursor", value: cursor)])
            guard selectionRequest == request else { return }
            let existing = Set(messages.map(\.messageId))
            // Bound retained rows while navigating history; Refresh returns to latest.
            messages = Array((response.messages.filter { !existing.contains($0.messageId) } + messages).prefix(500))
            pendingMessageCount = response.pendingCount ?? 0
            hasOlderMessages = response.hasMore ?? false
            errorMessage = nil
        } catch { if selectionRequest == request { errorMessage = error.localizedDescription } }
    }

    func clearSelection() {
        selectionRequest = UUID()
        selectedChannel = nil
        messages = []
        hasOlderMessages = false
        pendingMessageCount = 0
        isLoadingMessages = false
    }

    private func get<Response: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> Response {
        var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        components.queryItems = query.isEmpty ? nil : query
        let (data, response) = try await URLSession.shared.data(from: components.url!)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(BackendErrorResponse.self, from: data).error)
                ?? "The collaboration request failed."
            throw BackendError.message(message)
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }
}

private enum CollaborationSection: String, Identifiable {
    case activeChannels, channelHistory, agents, services
    var id: String { rawValue }
    @MainActor var title: String {
        switch self {
        case .activeChannels: L10n("Active channels")
        case .channelHistory: L10n("Channel history")
        case .agents: L10n("Agents")
        case .services: L10n("Services")
        }
    }
    var symbol: String {
        switch self {
        case .activeChannels: "bubble.left.and.bubble.right.fill"
        case .channelHistory: "clock.arrow.circlepath"
        case .agents: "person.2"
        case .services: "shippingbox"
        }
    }
}

struct CollaborationView: View {
    @ObservedObject private var appLanguage = AppLanguageController.shared
    @StateObject private var model = CollaborationViewModel()
    @State private var section: CollaborationSection? = .activeChannels
    @State private var selectedChannelID: String?

    private var activeAgents: [CollaborationAgent] { model.agents.filter { $0.status != "inactive" } }
    private var activeChannels: [SessionCollaborationChannel] { model.channels.filter { $0.status == "active" } }
    private var historicalChannels: [SessionCollaborationChannel] { model.channels.filter { $0.status != "active" } }

    var body: some View {
        NavigationSplitView {
            List(selection: $section) {
                Section(L10n("Communication")) {
                    sidebarRow(.activeChannels, count: activeChannels.count)
                    sidebarRow(.channelHistory, count: historicalChannels.count)
                }
                Section(L10n("Registry")) {
                    sidebarRow(.agents, count: activeAgents.count)
                    sidebarRow(.services, count: model.services.count)
                }
            }.navigationTitle(L10n("Collaboration"))
        } content: {
            content.navigationTitle(section?.title ?? L10n("Collaboration"))
                .toolbar {
                    Button { Task { await model.refresh() } } label: {
                        Label(L10n("Refresh"), systemImage: "arrow.clockwise")
                    }
                }
        } detail: {
            if let channel = model.selectedChannel {
                SessionChannelDetailView(channel: channel, messages: model.messages,
                    hasOlderMessages: model.hasOlderMessages, isLoading: model.isLoadingMessages,
                    pendingCount: model.pendingMessageCount,
                    loadOlder: { Task { await model.loadOlderMessages() } })
            } else {
                ContentUnavailableView(L10n("Select a communication channel"), systemImage: "bubble.left.and.bubble.right")
            }
        }
        .frame(minWidth: 980, minHeight: 620)
        .task { await model.refresh() }
        .onChange(of: selectedChannelID) { _, id in
            guard let id else { model.clearSelection(); return }
            Task { await model.loadChannel(id) }
        }
        .onChange(of: section) { _, _ in selectedChannelID = nil }
        .overlay(alignment: .bottom) {
            if let error = model.errorMessage {
                Text(error).font(.callout).foregroundStyle(.white)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(.red, in: Capsule()).padding()
            }
        }
        .environment(\.locale, appLanguage.locale)
    }

    @ViewBuilder private var content: some View {
        switch section ?? .activeChannels {
        case .activeChannels: channelList(activeChannels)
        case .channelHistory: channelList(historicalChannels)
        case .agents: CollaborationAgentList(agents: activeAgents)
        case .services: CollaborationServiceList(services: model.services, agents: model.agents)
        }
    }

    private func sidebarRow(_ item: CollaborationSection, count: Int) -> some View {
        Label { HStack { Text(item.title); Spacer(); Text("\(count)").foregroundStyle(.secondary) } }
        icon: { Image(systemName: item.symbol) }.tag(item)
    }

    private func channelList(_ channels: [SessionCollaborationChannel]) -> some View {
        List(channels, selection: $selectedChannelID) { channel in
            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    Label(L10n("Session channel"), systemImage: "bubble.left.and.bubble.right").font(.headline)
                    Spacer()
                    CollaborationStatusBadge(status: channel.status)
                }
                Text(channel.sessionAId).font(.caption.monospaced()).lineLimit(1)
                Text(channel.sessionBId).font(.caption.monospaced()).lineLimit(1)
                Text(channel.updatedAt ?? channel.createdAt ?? "").font(.caption).foregroundStyle(.tertiary)
            }.padding(.vertical, 5).tag(channel.channelId)
        }.overlay {
            if channels.isEmpty {
                ContentUnavailableView(L10n("No channels in this view"), systemImage: "bubble.left.and.bubble.right")
            }
        }
    }
}

private struct SessionChannelDetailView: View {
    let channel: SessionCollaborationChannel
    let messages: [SessionCollaborationMessage]
    let hasOlderMessages: Bool
    let isLoading: Bool
    let pendingCount: Int
    let loadOlder: () -> Void
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(L10n("Communication channel")).font(.title2.bold())
                        Text(channel.channelId).font(.caption.monospaced()).textSelection(.enabled)
                    }
                    Spacer()
                    CollaborationStatusBadge(status: channel.status)
                }
                GroupBox(L10n("Equal Session participants")) {
                    LabeledContent("Session A", value: channel.sessionAId)
                    LabeledContent("Session B", value: channel.sessionBId)
                    LabeledContent(L10n("Authorized by"), value: channel.requestedBySessionId)
                    if let value = channel.authorizedAt { LabeledContent(L10n("Authorized at"), value: value) }
                    if let value = channel.revocationReason { LabeledContent(L10n("Revocation reason"), value: value) }
                }
                HStack {
                    Text(L10n("Messages")).font(.headline)
                    if pendingCount > 0 { Text("\(L10n("Pending")) · \(pendingCount)").font(.caption).foregroundStyle(.secondary) }
                }
                if hasOlderMessages {
                    Button(L10n("Load older messages"), action: loadOlder).disabled(isLoading)
                }
                ForEach(messages) { message in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(message.senderSessionId).font(.caption.monospaced()).lineLimit(1)
                            Image(systemName: "arrow.right")
                            Text(message.recipientSessionId).font(.caption.monospaced()).lineLimit(1)
                            Spacer()
                            Text(message.messageKind).font(.caption).foregroundStyle(.secondary)
                        }
                        Text(deliveryLabel(message)).font(.caption).foregroundStyle(.secondary)
                        Text(message.body).textSelection(.enabled)
                        Text(message.createdAt).font(.caption).foregroundStyle(.tertiary)
                    }.padding(12).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
                }
                if messages.isEmpty {
                    ContentUnavailableView(L10n("No channel messages"), systemImage: "bubble.left")
                }
            }.padding(24)
        }
    }

    private func deliveryLabel(_ message: SessionCollaborationMessage) -> String {
        guard let receipt = message.delivery else { return L10n("Saved") }
        if receipt.batchStatus == "unknown" { return L10n("Delivery uncertain — automatic replay blocked") }
        if let count = receipt.messageCount, count > 1 {
            return "\(L10n("Batch")) · \(count) \(L10n("messages")) · \(receipt.executionStatus ?? receipt.status)"
        }
        if ["notification", "acknowledgement"].contains(message.deliveryIntent ?? ""), receipt.status == "pending" {
            return L10n("Saved — does not wake recipient")
        }
        return L10n(receipt.executionStatus ?? receipt.status)
    }

}

private struct CollaborationAgentList: View {
    let agents: [CollaborationAgent]
    var body: some View {
        List(agents) { agent in
            VStack(alignment: .leading, spacing: 5) {
                HStack { Text(agent.name).font(.headline); Spacer(); CollaborationStatusBadge(status: agent.status) }
                Text(agent.agentId).font(.caption.monospaced()).foregroundStyle(.secondary)
                Text(agent.description).foregroundStyle(.secondary)
            }.padding(.vertical, 5)
        }
    }
}

private struct CollaborationServiceList: View {
    let services: [CollaborationService]
    let agents: [CollaborationAgent]
    var body: some View {
        List(services) { service in
            VStack(alignment: .leading, spacing: 5) {
                HStack { Text(service.name).font(.headline); Spacer(); CollaborationStatusBadge(status: service.status) }
                Text(service.description).foregroundStyle(.secondary)
                Text(agents.first(where: { $0.agentId == service.ownerAgentId })?.name ?? service.ownerAgentId).font(.caption)
            }.padding(.vertical, 5)
        }
    }
}

private struct CollaborationStatusBadge: View {
    let status: String
    var body: some View {
        Text(status.replacingOccurrences(of: "_", with: " "))
            .font(.caption.weight(.semibold)).padding(.horizontal, 8).padding(.vertical, 4)
            .background(color.opacity(0.14), in: Capsule()).foregroundStyle(color)
    }
    private var color: Color {
        switch status {
        case "active", "available", "delivered": .green
        case "pending", "pending_authorization", "queued": .orange
        case "revoked", "failed", "rejected": .red
        default: .secondary
        }
    }
}
