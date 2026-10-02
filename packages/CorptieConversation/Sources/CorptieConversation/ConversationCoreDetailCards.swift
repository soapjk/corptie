import SwiftUI
import CorptieClientCore

public struct ConversationSessionInformationCard: View {
    public let sessionID: String
    public let workName: String?

    public init(sessionID: String, workName: String? = nil) {
        self.sessionID = sessionID
        self.workName = workName
    }

    public var body: some View {
        ConversationDetailModuleCard(title: "会话信息", systemImage: "info.circle") {
            Text(sessionID).font(.caption.monospaced()).lineLimit(1)
                .truncationMode(.middle).textSelection(.enabled)
            if let workName, !workName.isEmpty { Text(workName).lineLimit(2) }
        }
    }
}

public struct ConversationChatSummaryCard: View {
    public let summary: String?

    public init(summary: String?) { self.summary = summary }

    public var body: some View {
        if let summary = summary?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty {
            ConversationDetailModuleCard(title: "会话摘要", systemImage: "text.alignleft") {
                ConversationDetailText(text: summary)
            }
        }
    }
}

public struct ConversationWorkOverviewCard: View {
    public let description: String?

    public init(description: String?) { self.description = description }

    public var body: some View {
        if let description = description?.trimmingCharacters(in: .whitespacesAndNewlines), !description.isEmpty {
            ConversationDetailModuleCard(title: "Work 概述", systemImage: "scope") {
                ConversationDetailText(text: description)
            }
        }
    }
}

public struct ConversationFocusTask: Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let sessionID: String?
    public let summary: ConversationTaskSummary?

    public init(id: String, title: String, sessionID: String?, summary: ConversationTaskSummary?) {
        self.id = id
        self.title = title
        self.sessionID = sessionID
        self.summary = summary
    }

    public init?(inspectorValue: ClientInspectorValue, sessionID: String?) {
        guard let id = inspectorValue["id"].text else { return nil }
        self.init(id: id, title: inspectorValue["title"].text ?? "Task", sessionID: sessionID,
            summary: ConversationTaskSummary(inspectorValue: inspectorValue["summary"],
                taskRevision: inspectorValue["taskRevision"].number.map(Int.init)))
    }
}

public struct ConversationFocusTasksCard: View {
    public let tasks: [ConversationFocusTask]
    public let onOpenSession: (String, String) -> Void

    public init(tasks: [ConversationFocusTask], onOpenSession: @escaping (String, String) -> Void) {
        self.tasks = tasks
        self.onOpenSession = onOpenSession
    }

    public var body: some View {
        if !tasks.isEmpty {
            ConversationDetailModuleCard(title: "重点 Task", systemImage: "checklist") {
                ForEach(tasks) { task in
                    Group {
                        if let sessionID = task.sessionID {
                            Button { onOpenSession(task.id, sessionID) } label: { row(task) }
                                .buttonStyle(.plain)
                        } else {
                            row(task)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                }
            }
        }
    }

    private func row(_ task: ConversationFocusTask) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(task.title).font(.system(size: 11, weight: .medium))
            if task.summary != nil { ConversationTaskSummaryView(summary: task.summary, compact: true) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
