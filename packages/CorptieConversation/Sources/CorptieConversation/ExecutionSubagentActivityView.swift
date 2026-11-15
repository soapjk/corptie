import SwiftUI
import CorptieClientCore

/// A bounded child-activity presentation. It consumes the common projection,
/// without treating a provider child as an independently addressable Session.
public struct ExecutionSubagentPresentation: Sendable {
    public static let inlineLimit = 8

    public struct Activity: Identifiable, Sendable {
        public let id: String
        public let event: String
        public let status: String
    }

    public let name: String
    public let kindLabel: String
    public let status: String
    public let state: ConversationExecutionStep.State
    public let activities: [Activity]
    public let hiddenCount: Int

    public init?(step: ConversationExecutionStep, languageCode: String) {
        guard let child = step.subagent else { return nil }
        let zh = languageCode.lowercased().hasPrefix("zh")
        name = child.name
        kindLabel = zh ? "子 Agent" : "Subagent"
        state = step.state
        status = Self.statusLabel(state, zh: zh)
        activities = child.activities.suffix(Self.inlineLimit).map {
            Activity(id: $0.activityId, event: Self.eventLabel($0.event, zh: zh),
                     status: Self.statusLabel(Self.state($0.status), zh: zh))
        }
        hiddenCount = max(0, child.activities.count - Self.inlineLimit)
    }

    /// Materialize full history only when the user requests details.
    public static func fullText(step: ConversationExecutionStep, languageCode: String) -> String {
        guard let child = step.subagent else { return "" }
        let zh = languageCode.lowercased().hasPrefix("zh")
        return ([child.name, statusLabel(step.state, zh: zh)] + child.activities.map {
            eventLabel($0.event, zh: zh) + " · " + statusLabel(state($0.status), zh: zh)
        }).joined(separator: "\n")
    }

    private static func state(_ status: String) -> ConversationExecutionStep.State {
        switch status {
        case "running": .running
        case "completed": .completed
        case "failed": .failed
        case "cancelled": .cancelled
        default: .unknown
        }
    }

    private static func statusLabel(_ state: ConversationExecutionStep.State, zh: Bool) -> String {
        switch state {
        case .running: zh ? "进行中" : "Running"
        case .completed: zh ? "已完成" : "Completed"
        case .failed: zh ? "失败" : "Failed"
        case .cancelled: zh ? "已停止" : "Stopped"
        case .unknown: zh ? "状态待确认" : "Status unconfirmed"
        }
    }

    private static func eventLabel(_ event: String, zh: Bool) -> String {
        switch event {
        case "started": zh ? "已启动" : "Started"
        case "interacted": zh ? "已发送后续指令" : "Follow-up sent"
        case "completed": zh ? "执行结束" : "Execution ended"
        default: zh ? "活动更新" : "Activity updated"
        }
    }
}

public struct ExecutionSubagentActivityView: View {
    public let presentation: ExecutionSubagentPresentation

    public init(presentation: ExecutionSubagentPresentation) {
        self.presentation = presentation
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label {
                Text(presentation.name)
                    .font(.subheadline.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "person.2")
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
            }
            HStack(alignment: .top, spacing: 6) {
                Text(presentation.kindLabel)
                Text("·").accessibilityHidden(true)
                Text(presentation.status)
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            ForEach(presentation.activities) { activity in
                VStack(alignment: .leading, spacing: 2) {
                    Text(activity.event).font(.caption)
                    Text(activity.status).font(.caption2).foregroundStyle(.secondary)
                }
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityElement(children: .combine)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("execution-subagent-activity")
    }
}
