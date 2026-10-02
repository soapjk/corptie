import Combine
import CorptieConversation
import AppKit
import SwiftUI

enum ContextReferenceAddMode: String, Identifiable {
    case webURL
    case work
    case task
    case agent
    case session

    var id: String { rawValue }
    var title: String {
        switch self {
        case .webURL: "添加网页链接"
        case .work: "引用 Work"
        case .task: "引用 CorptieTask"
        case .agent: "引用 Agent"
        case .session: "引用其他会话"
        }
    }
    var referenceType: SessionContextReferenceType {
        switch self {
        case .webURL: .webURL
        case .work: .work
        case .task: .task
        case .agent: .agent
        case .session: .session
        }
    }
}

private struct ContextReferenceCandidate: Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let systemImage: String
}

struct ContextReferenceAddSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var backendClient = BackendClient.shared
    @ObservedObject private var entityClient = EntityAPIClient.shared
    let session: TaskSession
    let mode: ContextReferenceAddMode
    @State private var urlText = ""
    @State private var searchText = ""
    @State private var tasks: [CorptieTask] = []
    @State private var isSubmitting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(mode.title).font(.system(size: 16, weight: .semibold))
                Spacer()
                Button("取消") { dismiss() }.buttonStyle(.plain)
            }

            if mode == .webURL {
                Text("网页会在添加时保存正文快照；之后可以从引用菜单手动刷新。")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                TextField("https://example.com/document", text: $urlText)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { addWebURL() }
                Spacer()
                HStack {
                    Spacer()
                    Button("添加") { addWebURL() }
                        .buttonStyle(.borderedProminent)
                        .disabled(urlText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSubmitting)
                }
            } else {
                TextField("搜索", text: $searchText)
                    .textFieldStyle(.roundedBorder)
                if candidates.isEmpty {
                    ContentUnavailableView("没有可引用的对象", systemImage: mode.referenceType.systemImage)
                } else {
                    List(filteredCandidates) { candidate in
                        Button {
                            add(candidate)
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: candidate.systemImage)
                                    .frame(width: 20)
                                    .foregroundStyle(Color.accentColor)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(candidate.title).font(.system(size: 12, weight: .medium))
                                    if !candidate.subtitle.isEmpty {
                                        Text(candidate.subtitle)
                                            .font(.system(size: 10))
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                }
                                Spacer()
                                Image(systemName: "plus.circle")
                                    .foregroundStyle(.secondary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(isSubmitting)
                    }
                    .listStyle(.inset)
                }
            }

            if let error = backendClient.lastError, !error.isEmpty {
                Text(error).font(.system(size: 10)).foregroundStyle(.red).lineLimit(2)
            }
            if mode == .task, let error = entityClient.tasksLoadError {
                Text(error).font(.system(size: 10)).foregroundStyle(.red).lineLimit(3)
            }
        }
        .padding(18)
        .frame(width: 430, height: mode == .webURL ? 230 : 460)
        .task {
            switch mode {
            case .work: await entityClient.refreshWorks()
            case .task:
                if let loaded = await entityClient.allCorptieTasks() {
                    tasks = loaded
                }
            case .agent: await entityClient.refreshAgents()
            case .session, .webURL: break
            }
        }
    }

    private var candidates: [ContextReferenceCandidate] {
        switch mode {
        case .work:
            entityClient.works.map { .init(id: $0.id, title: $0.name, subtitle: $0.status, systemImage: "scope") }
        case .task:
            tasks.map { .init(id: $0.id, title: $0.title, subtitle: $0.lifecycleState, systemImage: "checklist") }
        case .agent:
            entityClient.agents
                .filter { $0.agentId != session.agentId }
                .map { .init(id: $0.agentId, title: $0.name, subtitle: $0.description, systemImage: "person.2") }
        case .session:
            backendClient.sessions
                .filter { $0.id != session.id }
                .map { .init(id: $0.id, title: $0.title, subtitle: $0.agent, systemImage: "bubble.left.and.bubble.right") }
        case .webURL:
            []
        }
    }

    private var filteredCandidates: [ContextReferenceCandidate] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return candidates }
        return candidates.filter { $0.title.localizedCaseInsensitiveContains(query) || $0.subtitle.localizedCaseInsensitiveContains(query) }
    }

    private func addWebURL() {
        let locator = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !locator.isEmpty else { return }
        isSubmitting = true
        Task {
            let added = await backendClient.addContextReference(to: session, type: .webURL, locator: locator)
            isSubmitting = false
            if added { dismiss() }
        }
    }

    private func add(_ candidate: ContextReferenceCandidate) {
        isSubmitting = true
        Task {
            let added = await backendClient.addContextReference(
                to: session,
                type: mode.referenceType,
                targetId: candidate.id,
                displayName: candidate.title
            )
            isSubmitting = false
            if added { dismiss() }
        }
    }
}

extension SessionContextReferenceType {
    var systemImage: String {
        switch self {
        case .localFile: "doc"
        case .webURL: "globe"
        case .work: "scope"
        case .task: "checklist"
        case .agent: "person.2"
        case .session: "bubble.left.and.bubble.right"
        }
    }
}
