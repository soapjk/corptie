import SwiftUI
import CorptieClientCore

/// A structured checklist inside an execution card. Step identity survives plan revisions,
/// so SwiftUI can update a changed status without replacing the whole text leaf.
public struct ExecutionPlanChecklist: View {
    public let plan: ConversationExecutionPlan
    @ScaledMetric(relativeTo: .caption) private var titleSize: CGFloat = 10.5
    @ScaledMetric(relativeTo: .caption) private var explanationSize: CGFloat = 10
    @ScaledMetric(relativeTo: .caption) private var markerWidth: CGFloat = 13

    public init(plan: ConversationExecutionPlan) {
        self.plan = plan
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Image(systemName: "list.bullet.clipboard")
                    .accessibilityHidden(true)
                Text(plan.lifecycle == "unknown"
                    ? "计划更新暂不可用"
                    : plan.steps.isEmpty ? "暂无计划步骤"
                        : "计划 \(plan.steps.filter { $0.status == "completed" }.count)/\(plan.steps.count)")
            }
            .font(.system(size: titleSize, weight: .semibold))
            .foregroundStyle(.secondary)

            if let explanation = plan.explanation, !explanation.isEmpty {
                Text(explanation)
                    .font(.system(size: explanationSize))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !plan.steps.isEmpty {
                LazyVStack(alignment: .leading, spacing: 5) {
                    ForEach(plan.steps) { step in
                        HStack(alignment: .firstTextBaseline, spacing: 7) {
                            Text(step.marker)
                                .font(.system(size: titleSize, weight: .bold))
                                .foregroundStyle(color(for: step.status))
                                .frame(width: markerWidth, alignment: .center)
                                .accessibilityHidden(true)
                            Text(step.text)
                                .font(.system(size: titleSize))
                                .foregroundStyle(step.status == "completed" ? .secondary : .primary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(statusLabel(for: step.status))，\(step.text)")
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("execution-plan-\(plan.planId)")
    }

    private func color(for status: String) -> Color {
        switch status {
        case "completed": .green
        case "inProgress": .accentColor
        case "failed": .red
        default: .secondary
        }
    }

    private func statusLabel(for status: String) -> String {
        switch status {
        case "completed": "已完成"
        case "inProgress": "进行中"
        case "failed": "失败"
        case "cancelled": "已取消"
        case "pending": "待开始"
        default: "状态未知"
        }
    }
}
